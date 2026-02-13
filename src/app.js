/* global L, APP_CONFIG */
(function () {
  const cfg = window.APP_CONFIG;

  const statusEl = document.getElementById("status");
  const dateInput = document.getElementById("dateInput");
  const opacityInput = document.getElementById("opacityInput");
  const todayBtn = document.getElementById("todayBtn");
  const openEoc = document.getElementById("openEoc");

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function todayUtcDateString() {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function toWmsTime(dateStr) {
    if (cfg.wms.timeFormat === "date") return dateStr;
    return `${dateStr}T05:00:00Z`;
  }

  const map = L.map("map", { worldCopyJump: true }).setView(cfg.map.center, cfg.map.zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  let so2Layer = null;
  function addSo2Layer(dateStr) {
    const timeParam = toWmsTime(dateStr);

    if (so2Layer) map.removeLayer(so2Layer);

    const wmsParams = {
      layers: cfg.wms.layers,
      format: cfg.wms.format,
      transparent: cfg.wms.transparent,
      version: cfg.wms.version,
      time: timeParam
    };
    if (cfg.wms.styles !== undefined) wmsParams.styles = cfg.wms.styles;

    so2Layer = L.tileLayer.wms(cfg.wms.url, wmsParams);
    so2Layer.setOpacity(parseFloat(opacityInput.value));
    so2Layer.addTo(map);

    openEoc.href = cfg.ui.eocDatasetPage;
    setStatus(`SO₂ (WMS) | Fecha seleccionada (UTC): ${dateStr} | TIME=${timeParam}`);
  }

  function volcanoMarker(latlng) {
    return L.marker(latlng, {
      icon: L.divIcon({
        className: "volcano-icon",
        html: '<div style="width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:14px solid black;"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 14]
      })
    });
  }

  function smelterMarker(latlng) {
    return L.circleMarker(latlng, { radius: 6, weight: 2, fillOpacity: 0.9 });
  }

  function bindPopup(layer, props, fallbackTitle) {
    const name = (props && (props.name || props.Name || props.NOMBRE)) || fallbackTitle || "Sin nombre";
    const extra = [];
    if (props && props.type) extra.push(`Tipo: ${props.type}`);
    if (props && props.empresa) extra.push(`Empresa: ${props.empresa}`);
    const html = `<b>${name}</b>${extra.length ? `<br/>${extra.join("<br/>")}` : ""}`;
    layer.bindPopup(html);
  }

  async function loadGeoJson(url, pointToLayerFn, label) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`No se pudo cargar ${label}: ${r.status}`);
    const gj = await r.json();
    return L.geoJSON(gj, {
      pointToLayer: (feature, latlng) => pointToLayerFn(latlng),
      onEachFeature: (feature, lyr) => bindPopup(lyr, feature.properties, label)
    });
  }

  async function loadChileBorder() {
    const r = await fetch(cfg.data.countriesUrl, { cache: "force-cache" });
    if (!r.ok) throw new Error(`No se pudo cargar países: ${r.status}`);
    const gj = await r.json();

    function isChileFeature(props) {
      if (!props) return false;
      for (const k of cfg.data.chileNamePropertyCandidates) {
        if (props[k] && String(props[k]).toLowerCase() === "chile") return true;
      }
      return false;
    }

    const chile = { type: "FeatureCollection", features: (gj.features || []).filter(f => isChileFeature(f.properties)) };

    return L.geoJSON(chile, { style: { color: "#000", weight: 2, fillOpacity: 0 } });
  }

  const layerControl = L.control.layers({}, {}, { collapsed: false }).addTo(map);

  // --- Wind overlays (OFF by default; expects prebuilt JSON under data/wind/YYYY-MM-DD/) ---
  const windLayers = {};
  const WIND_LEVELS = [
    { key: "10m", label: "Viento (10 m)" },
    { key: "900hPa", label: "Viento (~1 km, 900 hPa)" },
    { key: "400hPa", label: "Viento (~7 km, 400 hPa)" },
    { key: "150hPa", label: "Viento (~15 km, 150 hPa)" }
  ];

  const windCache = {}; // por nivel

  function toRad(deg) { return (deg * Math.PI) / 180; }

  function destinationPoint(lat, lon, bearingDeg, distanceKm) {
    const R = 6371.0088;
    const brng = toRad(bearingDeg);
    const φ1 = toRad(lat);
    const λ1 = toRad(lon);
    const δ = distanceKm / R;

    const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1);
    const sinδ = Math.sin(δ), cosδ = Math.cos(δ);

    const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(brng);
    const φ2 = Math.asin(sinφ2);
    const y = Math.sin(brng) * sinδ * cosφ1;
    const x = cosδ - sinφ1 * sinφ2;
    const λ2 = λ1 + Math.atan2(y, x);

    return [ (φ2 * 180) / Math.PI, (λ2 * 180) / Math.PI ];
  }

  function arrowPolyline(lat, lon, bearingDeg, lengthKm, headKm) {
    const tail = [lat, lon];
    const tip = destinationPoint(lat, lon, bearingDeg, lengthKm);
    const left = destinationPoint(tip[0], tip[1], bearingDeg + 150, headKm);
    const right = destinationPoint(tip[0], tip[1], bearingDeg - 150, headKm);
    return { tail, tip, left, right };
  }

  function windJsonPath(dateStr, levelKey) {
    // Resuelve bien en GitHub Pages (Project Pages) y con dominio custom
    const rel = `data/wind/${dateStr}/${levelKey}.json`;
    return new URL(rel, document.baseURI).toString();
  }

  async function loadWindFor(dateStr, levelKey) {
    const url = windJsonPath(dateStr, levelKey);
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`No hay viento (${levelKey}) para ${dateStr} (${r.status})`);
    return await r.json();
  }

  function renderWindToLayer(windData, layerGroup) {
    layerGroup.clearLayers();

    const pts = windData.points || [];

    // Visual mapping: length ~200 km at 10 m/s; clamp for usability.
    const refSpeed = 10; // m/s
    const baseLenKm = 200;
    const minLenKm = 40;
    const maxLenKm = 300;
    const headKm = 18;

    for (const p of pts) {
      const lat = p.lat, lon = p.lon;
      const u = p.u, v = p.v;
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(u) || !isFinite(v)) continue;

      const speed = Math.sqrt(u*u + v*v);
      const bearing = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;

      let lenKm = baseLenKm * (speed / refSpeed);
      lenKm = Math.max(minLenKm, Math.min(maxLenKm, lenKm));

      const a = arrowPolyline(lat, lon, bearing, lenKm, headKm);
      const color = "#111";

      L.polyline([a.tail, a.tip], { color, weight: 2, opacity: 0.85 }).addTo(layerGroup);
      L.polyline([a.left, a.tip, a.right], { color, weight: 2, opacity: 0.85 }).addTo(layerGroup);
    }
  }

  async function refreshWindLayer(levelKey) {
    const layerGroup = windLayers[levelKey];
    if (!layerGroup) return;
    if (!map.hasLayer(layerGroup)) return;

    try {
      const dateStr = dateInput.value;
      const windData = await loadWindFor(dateStr, levelKey);

      windCache[levelKey] = windData;

      const dmin = windData?.meta?.delta_minutes;
      if (typeof dmin === "number" && dmin > 90) {
        setStatus(`⚠ Viento ${levelKey}: desfase ${dmin} min (>90). Fecha: ${dateStr}`);
      }

      renderWindToLayer(windData, layerGroup);
    } catch (e) {
      console.warn(e);
      layerGroup.clearLayers();
      windCache[levelKey] = null;
      setStatus(`(Sin viento ${levelKey} para ${dateInput.value})`);
    }
  }

  function wireWindOverlays() {
    for (const wl of WIND_LEVELS) {
      const lg = L.layerGroup(); // OFF by default
      windLayers[wl.key] = lg;
      layerControl.addOverlay(lg, wl.label);
    }

    map.on("overlayadd", (ev) => {
      for (const wl of WIND_LEVELS) {
        if (ev.layer === windLayers[wl.key]) {
          refreshWindLayer(wl.key);
          break;
        }
      }
    });

    map.on("overlayremove", (ev) => {
      for (const wl of WIND_LEVELS) {
        if (ev.layer === windLayers[wl.key]) {
          windLayers[wl.key].clearLayers();
          break;
        }
      }
    });
  }

  async function init() {
    try {
      dateInput.value = todayUtcDateString();
      addSo2Layer(dateInput.value);

      setStatus("Cargando capas…");

      const borderLayer = await loadChileBorder();
      borderLayer.addTo(map);
      layerControl.addOverlay(borderLayer, "Límite Chile");

      const volcanos = await loadGeoJson(cfg.data.volcanoes, volcanoMarker, "Volcán");

      volcanos.eachLayer(l => {
        const p = l.feature?.properties || {};
        const name = p.name || p.Name || p.NOMBRE || "Volcán";
        l.bindTooltip(name, {
          permanent: true,
          direction: "top",
          offset: [0, -10],
          opacity: 0.9,
          className: "label-volcano"
        });
      });

      volcanos.addTo(map);
      layerControl.addOverlay(volcanos, "Volcanes");

      const smelters = await loadGeoJson(cfg.data.smelters, smelterMarker, "Fundición");
      smelters.eachLayer(l => { if (l.setStyle) l.setStyle({ color: "#000", fillColor: "#000" }); });

      smelters.eachLayer(l => {
        const p = l.feature?.properties || {};
        const name = p.name || p.Name || p.NOMBRE || "Fundición";
        l.bindTooltip(name, {
          permanent: true,
          direction: "right",
          offset: [8, 0],
          opacity: 0.9,
          className: "label-smelter"
        });
      });

      smelters.addTo(map);
      layerControl.addOverlay(smelters, "Fundiciones");

      // --- Show/hide labels by zoom ---
      function updateLabels() {
        const z = map.getZoom();
        const showSmelter = z >= 5;
        const showVolcano = z >= 7;

        volcanos.eachLayer(l => {
          if (!l.getTooltip()) return;
          if (showVolcano) l.openTooltip();
          else l.closeTooltip();
        });

        smelters.eachLayer(l => {
          if (!l.getTooltip()) return;
          if (showSmelter) l.openTooltip();
          else l.closeTooltip();
        });
      }

      map.on("zoomend", updateLabels);
      updateLabels();

      // Wind overlays (added to layer control; OFF by default)
      wireWindOverlays();

      setStatus(`Listo. Fecha (UTC): ${dateInput.value}. Cambia la fecha para actualizar TIME del WMS.`);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
    }
  }

  dateInput.addEventListener("change", () => {
    addSo2Layer(dateInput.value);
    // refresca viento si está encendido
    for (const wl of WIND_LEVELS) refreshWindLayer(wl.key);
  });

  opacityInput.addEventListener("input", () => {
    if (so2Layer) so2Layer.setOpacity(parseFloat(opacityInput.value));
  });

  todayBtn.addEventListener("click", () => {
    dateInput.value = todayUtcDateString();
    addSo2Layer(dateInput.value);
    for (const wl of WIND_LEVELS) refreshWindLayer(wl.key);
  });

  init();
})();
