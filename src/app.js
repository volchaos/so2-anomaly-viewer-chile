/* global L, APP_CONFIG */
(function () {
  const cfg = window.APP_CONFIG;

  const statusEl = document.getElementById("status");
  const dateInput = document.getElementById("dateInput");
  const opacityInput = document.getElementById("opacityInput");
  const todayBtn = document.getElementById("todayBtn");
  const openEoc = document.getElementById("openEoc");

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
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

  // ---------------- Map ----------------
  const map = L.map("map", { worldCopyJump: true }).setView(cfg.map.center, cfg.map.zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  // ---------------- SO2 WMS ----------------
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

    if (openEoc) openEoc.href = cfg.ui.eocDatasetPage;
    setStatus(`SO₂ (WMS) | Fecha (UTC): ${dateStr} | TIME=${timeParam}`);
  }

  // ---------------- Icons ----------------
  function volcanoDivIcon(sizePx, strokeColor) {
    const w = sizePx;
    const h = Math.round(sizePx * 1.1);
    const stroke = strokeColor || "none";
    const strokeWidth = strokeColor ? 2 : 0;

    const svg = `
      <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
        <polygon
          points="${w / 2},0 0,${h} ${w},${h}"
          fill="black"
          stroke="${stroke}"
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

  function volcanoMarkerOVDAS(latlng) {
    return L.marker(latlng, { icon: volcanoDivIcon(18, "red") });
  }

  function volcanoMarkerOther(latlng) {
    return L.marker(latlng, { icon: volcanoDivIcon(9, null) });
  }

  function smelterMarker(latlng) {
    return L.circleMarker(latlng, { radius: 6, weight: 2, fillOpacity: 0.9 });
  }

  // ---------------- Helpers ----------------
  function nameFromProps(props, fallback) {
    return (props && (props.name || props.Name || props.NOMBRE)) || fallback || "Sin nombre";
  }

  function bindPopup(layer, props, fallbackTitle) {
    const name = nameFromProps(props, fallbackTitle);
    const extra = [];
    if (props && props.type) extra.push(`Tipo: ${props.type}`);
    if (props && props.empresa) extra.push(`Empresa: ${props.empresa}`);
    const html = `<b>${name}</b>${extra.length ? `<br/>${extra.join("<br/>")}` : ""}`;
    layer.bindPopup(html);
  }

  async function loadGeoJson(url, pointToLayerFn, label) {
    const absUrl = new URL(url, document.baseURI).toString();
    const r = await fetch(absUrl, { cache: "no-store" });
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

    const chile = {
      type: "FeatureCollection",
      features: (gj.features || []).filter(f => isChileFeature(f.properties))
    };

    return L.geoJSON(chile, { style: { color: "#000", weight: 2, fillOpacity: 0 } });
  }

  // ---------------- Layer control ----------------
  const layerControl = L.control.layers({}, {}, { collapsed: false }).addTo(map);

  // ---------------- Layers ----------------
  let borderLayer = null;
  let volcanesOvdasLayer = null;
  let volcanesOtrosLayer = null;
  let smeltersLayer = null;

  function bindPermanentLabel(layer, text, className, direction, offset) {
    layer.bindTooltip(text, {
      permanent: true,
      direction: direction || "top",
      offset: offset || [0, -10],
      opacity: 0.9,
      className: className || ""
    });
  }

  function updateLabelsByZoom() {
    const z = map.getZoom();
    const zSmelter = cfg.zoomLabels?.smelter ?? 5;
    const zOvdas = cfg.zoomLabels?.ovdas ?? 7;
    const zOther = cfg.zoomLabels?.other ?? 9;

    if (smeltersLayer) {
      const show = z >= zSmelter;
      smeltersLayer.eachLayer(l => {
        const t = l.getTooltip?.();
        if (!t) return;
        if (show) l.openTooltip();
        else l.closeTooltip();
      });
    }

    if (volcanesOvdasLayer) {
      const show = z >= zOvdas;
      volcanesOvdasLayer.eachLayer(l => {
        const t = l.getTooltip?.();
        if (!t) return;
        if (show) l.openTooltip();
        else l.closeTooltip();
      });
    }

    if (volcanesOtrosLayer) {
      const show = z >= zOther;
      volcanesOtrosLayer.eachLayer(l => {
        const t = l.getTooltip?.();
        if (!t) return;
        if (show) l.openTooltip();
        else l.closeTooltip();
      });
    }
  }

  // ---------------- Wind overlays (NOAA/GFS JSON) ----------------
  const windLayers = {};

  // ✅ CAMBIO: quitamos 10m y usamos 900/500/250/150
  const WIND_LEVELS = [
    { key: "900hPa", label: "Viento (~1 km, 900 hPa)" },
    { key: "500hPa", label: "Viento (~5 km, 500 hPa)" },
    { key: "250hPa", label: "Viento (~10 km, 250 hPa)" },
    { key: "150hPa", label: "Viento (~15 km, 150 hPa)" }
  ];

  function windJsonUrl(dateStr, levelKey) {
    const rel = `data/wind/${dateStr}/${levelKey}.json`;
    return new URL(rel, document.baseURI).toString();
  }

  async function loadWindFor(dateStr, levelKey) {
    const url = windJsonUrl(dateStr, levelKey);
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`No hay viento (${levelKey}) para ${dateStr} (${r.status}) | ${url}`);
    return await r.json();
  }

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

  function renderWindToLayer(windData, layerGroup) {
    layerGroup.clearLayers();

    const pts = windData.points || [];
    if (!pts.length) return;

    const refSpeed = 10;
    const baseLenKm = 120;
    const minLenKm = 30;
    const maxLenKm = 220;
    const headKm = 10;

    const color = "#555";
    const weight = 1.4;
    const opacity = 0.75;

    const bounds = map.getBounds();

    const z = map.getZoom();
    const stride = (z <= 3) ? 40 : (z === 4) ? 25 : (z === 5) ? 14 : (z === 6) ? 9 : (z === 7) ? 6 : 3;

    let drawn = 0;
    for (let i = 0; i < pts.length; i += stride) {
      const p = pts[i];
      const lat = p.lat, lon = p.lon;
      const u = p.u, v = p.v;
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(u) || !isFinite(v)) continue;
      if (!bounds.contains([lat, lon])) continue;

      const speed = Math.sqrt(u*u + v*v);
      const bearing = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;

      let lenKm = baseLenKm * (speed / refSpeed);
      lenKm = Math.max(minLenKm, Math.min(maxLenKm, lenKm));

      const a = arrowPolyline(lat, lon, bearing, lenKm, headKm);

      L.polyline([a.tail, a.tip], { color, weight, opacity, interactive: false }).addTo(layerGroup);
      L.polyline([a.left, a.tip, a.right], { color, weight, opacity, interactive: false }).addTo(layerGroup);
      drawn++;
    }

    const lvl = windData?.meta?.level_key || "";
    const dmin = windData?.meta?.delta_minutes;
    if (typeof dmin === "number") {
      setStatus(`Viento ${lvl}: ${drawn} flechas (de ${pts.length}, stride=${stride}) | Δt=${dmin} min`);
    } else {
      setStatus(`Viento: ${drawn} flechas (de ${pts.length}, stride=${stride})`);
    }
  }

  async function refreshWindLayer(levelKey) {
    const layerGroup = windLayers[levelKey];
    if (!layerGroup) return;
    if (!map.hasLayer(layerGroup)) return;

    try {
      const dateStr = dateInput.value;
      const windData = await loadWindFor(dateStr, levelKey);
      renderWindToLayer(windData, layerGroup);
    } catch (e) {
      console.warn(e);
      layerGroup.clearLayers();
      setStatus(`(Sin viento ${levelKey} para ${dateInput.value})`);
    }
  }

  function wireWindOverlays() {
    for (const wl of WIND_LEVELS) {
      const lg = L.layerGroup();
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

  function rerenderVisibleWind() {
    for (const wl of WIND_LEVELS) {
      const lg = windLayers[wl.key];
      if (!lg) continue;
      if (!map.hasLayer(lg)) continue;
      refreshWindLayer(wl.key);
    }
  }

  // ---------------- Init ----------------
  async function init() {
    try {
      dateInput.value = todayUtcDateString();
      addSo2Layer(dateInput.value);

      setStatus("Cargando capas…");

      borderLayer = await loadChileBorder();
      borderLayer.addTo(map);
      layerControl.addOverlay(borderLayer, "Límite fronterizo Chile");

      volcanesOvdasLayer = await loadGeoJson(cfg.data.volcanoesOvdas, (latlng) => volcanoMarkerOVDAS(latlng), "Volcán OVDAS");
      volcanesOvdasLayer.eachLayer(l => {
        const p = l.feature?.properties || {};
        bindPermanentLabel(l, nameFromProps(p, "Volcán"), "label-volcano", "top", [0, -12]);
      });
      volcanesOvdasLayer.addTo(map);
      layerControl.addOverlay(volcanesOvdasLayer, "Volcanes monitoreados (OVDAS)");

      volcanesOtrosLayer = await loadGeoJson(cfg.data.volcanoesAll, (latlng) => volcanoMarkerOther(latlng), "Volcán");
      volcanesOtrosLayer.eachLayer(l => {
        const p = l.feature?.properties || {};
        bindPermanentLabel(l, nameFromProps(p, "Volcán"), "label-volcano", "top", [0, -10]);
      });
      volcanesOtrosLayer.addTo(map);
      layerControl.addOverlay(volcanesOtrosLayer, "Volcanes no monitoreados");

      smeltersLayer = await loadGeoJson(cfg.data.smelters, (latlng) => smelterMarker(latlng), "Fundición");
      smeltersLayer.eachLayer(l => { if (l.setStyle) l.setStyle({ color: "#000", fillColor: "#000" }); });
      smeltersLayer.eachLayer(l => {
        const p = l.feature?.properties || {};
        bindPermanentLabel(l, nameFromProps(p, "Fundición"), "label-smelter", "right", [8, 0]);
      });
      smeltersLayer.addTo(map);
      layerControl.addOverlay(smeltersLayer, "Fundiciones");

      wireWindOverlays();

      map.on("zoomend", updateLabelsByZoom);
      updateLabelsByZoom();

      map.on("zoomend", rerenderVisibleWind);
      map.on("moveend", rerenderVisibleWind);

      setStatus(`Listo. Fecha (UTC): ${dateInput.value}. Cambia la fecha para actualizar SO₂.`);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
    }
  }

  // ---------------- UI events ----------------
  dateInput.addEventListener("change", () => {
    addSo2Layer(dateInput.value);
    rerenderVisibleWind();
  });

  opacityInput.addEventListener("input", () => {
    if (so2Layer) so2Layer.setOpacity(parseFloat(opacityInput.value));
  });

  todayBtn.addEventListener("click", () => {
    dateInput.value = todayUtcDateString();
    addSo2Layer(dateInput.value);
    rerenderVisibleWind();
  });

  init();
})();
