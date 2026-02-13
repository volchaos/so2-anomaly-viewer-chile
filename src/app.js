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

  // --- Scale controls (bottom-left) ---
  // Graphic scale
  L.control.scale({
    position: "bottomleft",
    metric: true,
    imperial: false,
    maxWidth: 140
  }).addTo(map);

  // Numeric scale control (1:XX.XXX)
  const NumericScaleControl = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd: function () {
      const div = L.DomUtil.create("div", "numeric-scale");
      div.textContent = "1:—";
      return div;
    }
  });
  const numericScale = new NumericScaleControl();
  numericScale.addTo(map);

  function formatScale(n) {
    try {
      return `1:${Math.round(n).toLocaleString("es-CL")}`;
    } catch {
      return `1:${Math.round(n)}`;
    }
  }

  // Approx scale denominator at current view center (96 DPI)
  function currentScaleDenominator() {
    const DPI = 96;
    const INCHES_PER_METER = 39.37;

    const centerLat = map.getCenter().lat;
    const z = map.getZoom();
    const metersPerPixel =
      156543.03392 * Math.cos(centerLat * Math.PI / 180) / Math.pow(2, z);

    return metersPerPixel * DPI * INCHES_PER_METER;
  }

  function updateNumericScale() {
    const el = numericScale.getContainer();
    if (!el) return;
    const scale = currentScaleDenominator();
    el.textContent = formatScale(scale);
  }

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

  // --- Icons ---
  function volcanoDivIcon(sizePx, isOvdas) {
    const w = sizePx;
    const h = Math.round(sizePx * 1.1);
    const strokeWidth = isOvdas ? 2 : 0;

    const svg = `
      <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
        <polygon
          points="${w / 2},0 0,${h} ${w},${h}"
          fill="black"
          stroke="${isOvdas ? "red" : "none"}"
          stroke-width="${strokeWidth}"
          stroke-linejoin="round"
        />
      </svg>
    `;

    return L.divIcon({
      className: "volcano-icon",
      html: svg,
      iconSize: [w, h],
      iconAnchor: [Math.round(w / 2), h]
    });
  }

  function volcanoMarker(latlng, isOvdas) {
    const size = isOvdas ? 18 : 9;
    return L.marker(latlng, { icon: volcanoDivIcon(size, isOvdas) });
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
      pointToLayer: (feature, latlng) => pointToLayerFn(latlng, feature),
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

  // --- Data layers ---
  let volcanesOvdasLayer = null;
  let volcanesOtrosLayer = null;
  let smeltersLayer = null;
  let borderLayer = null;

  function volcanoNameFromProps(p) {
    return p?.name || p?.Name || p?.NOMBRE || p?.volcano || p?.VOLCANO || "Volcán";
  }

  function smelterNameFromProps(p) {
    return p?.name || p?.Name || p?.NOMBRE || p?.smelter || p?.SMELTER || "Fundición";
  }

  function updateLabels() {
    // OVDAS labels from 1:250.000
    const showOvdas = currentScaleDenominator() <= 250000;
    // Others + Smelters labels from 1:50.000
    const showClose = currentScaleDenominator() <= 50000;

    if (volcanesOvdasLayer) {
      volcanesOvdasLayer.eachLayer(l => {
        if (!l.getTooltip()) return;
        if (showOvdas) l.openTooltip();
        else l.closeTooltip();
      });
    }

    if (volcanesOtrosLayer) {
      volcanesOtrosLayer.eachLayer(l => {
        if (!l.getTooltip()) return;
        if (showClose) l.openTooltip();
        else l.closeTooltip();
      });
    }

    if (smeltersLayer) {
      smeltersLayer.eachLayer(l => {
        if (!l.getTooltip()) return;
        if (showClose) l.openTooltip();
        else l.closeTooltip();
      });
    }

    updateNumericScale();
  }

  // --- Wind overlays (OFF by default; expects prebuilt JSON under data/wind/YYYY-MM-DD/) ---
  const windLayers = {};
  const WIND_LEVELS = [
    { key: "10m", label: "Viento (10 m)" },
    { key: "900hPa", label: "Viento (~1 km, 900 hPa)" },
    { key: "400hPa", label: "Viento (~7 km, 400 hPa)" },
    { key: "150hPa", label: "Viento (~15 km, 150 hPa)" }
  ];

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

  // ✅ FIX 1: URL correcta en GitHub Pages (Project Pages)
  function windJsonPath(dateStr, levelKey) {
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

      const dmin = windData?.meta?.delta_minutes;
      if (typeof dmin === "number" && dmin > 90) {
        setStatus(`⚠ Viento ${levelKey}: desfase ${dmin} min (>90). Fecha: ${dateStr}`);
      }

      renderWindToLayer(windData, layerGroup);
    } catch (e) {
      console.warn(e);
      layerGroup.clearLayers();
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

      borderLayer = await loadChileBorder();
      borderLayer.addTo(map);
      layerControl.addOverlay(borderLayer, "Límite fronterizo Chile");

      // Volcanes (OVDAS 44)
      volcanesOvdasLayer = await loadGeoJson(cfg.data.volcanoesOvdas, (latlng) => volcanoMarker(latlng, true), "Volcán OVDAS");
      volcanesOvdasLayer.eachLayer(l => {
        const p = l.feature?.properties || {};
        const name = volcanoNameFromProps(p);
        l.bindTooltip(name, {
          permanent: true,
          direction: "top",
          offset: [0, -12],
          opacity: 0.9,
          className: "label-volcano"
        });
      });
      volcanesOvdasLayer.addTo(map);
      layerControl.addOverlay(volcanesOvdasLayer, "Volcanes monitoreados (OVDAS)");

      // Volcanes (otros)
      volcanesOtrosLayer = await loadGeoJson(cfg.data.volcanoesAll, (latlng, feature) => {
        const isOvdas = false;
        return volcanoMarker(latlng, isOvdas);
      }, "Volcán");
      volcanesOtrosLayer.eachLayer(l => {
        const p = l.feature?.properties || {};
        const name = volcanoNameFromProps(p);
        l.bindTooltip(name, {
          permanent: true,
          direction: "top",
          offset: [0, -10],
          opacity: 0.9,
          className: "label-volcano"
        });
      });
      volcanesOtrosLayer.addTo(map);
      layerControl.addOverlay(volcanesOtrosLayer, "Volcanes no monitoreados");

      // Fundiciones
      smeltersLayer = await loadGeoJson(cfg.data.smelters, (latlng) => smelterMarker(latlng), "Fundición");
      smeltersLayer.eachLayer(l => { if (l.setStyle) l.setStyle({ color: "#000", fillColor: "#000" }); });
      smeltersLayer.eachLayer(l => {
        const p = l.feature?.properties || {};
        const name = smelterNameFromProps(p);
        l.bindTooltip(name, {
          permanent: true,
          direction: "right",
          offset: [8, 0],
          opacity: 0.9,
          className: "label-smelter"
        });
      });
      smeltersLayer.addTo(map);
      layerControl.addOverlay(smeltersLayer, "Fundiciones");

      // Wind overlays (OFF by default)
      wireWindOverlays();

      // label visibility by scale + numeric scale update
      map.on("zoomend", updateLabels);
      map.on("moveend", updateLabels);
      updateLabels();

      setStatus(`Listo. Fecha (UTC): ${dateInput.value}. Cambia la fecha para actualizar TIME del WMS.`);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
    }
  }

  dateInput.addEventListener("change", () => {
    addSo2Layer(dateInput.value);
    // si alguna capa de viento está activada, refrescarla
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
