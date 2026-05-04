/* global L, APP_CONFIG */
(function () {
  const cfg = window.APP_CONFIG;

  const statusEl = document.getElementById("status");
  const dateInput = document.getElementById("dateInput");
  const opacityInput = document.getElementById("opacityInput");
  const todayBtn = document.getElementById("todayBtn");
  const prevDayBtn = document.getElementById("prevDayBtn");
  const nextDayBtn = document.getElementById("nextDayBtn");
  const openEoc = document.getElementById("openEoc");

  // GIF UI
  const gifVolcanoSelect = document.getElementById("gifVolcanoSelect");
  const gifRoiSelect = document.getElementById("gifRoiSelect");
  const gifFrom = document.getElementById("gifFrom");
  const gifTo = document.getElementById("gifTo");
  const gifLastN = document.getElementById("gifLastN");
  const gifRangeBlock = document.getElementById("gifRangeBlock");
  const gifLastNBlock = document.getElementById("gifLastNBlock");
  const gifGenerateBtn = document.getElementById("gifGenerateBtn");
  const gifDownloadLink = document.getElementById("gifDownloadLink");
  const gifPreview = document.getElementById("gifPreview");
  const gifProgress = document.getElementById("gifProgress");
  const gifSize = document.getElementById("gifSize");
  const gifFps = document.getElementById("gifFps");

  // GIF overlay toggles
  const gifChkChileBorder = document.getElementById("gifChkChileBorder");
  const gifChkVolcanoesOvdas = document.getElementById("gifChkVolcanoesOvdas");
  const gifChkSmelters = document.getElementById("gifChkSmelters");
  const gifChkLegend = document.getElementById("gifChkLegend");

  // Wind toggles (per level)
  const gifChkWind900 = document.getElementById("gifChkWind900");
  const gifChkWind500 = document.getElementById("gifChkWind500");
  const gifChkWind400 = document.getElementById("gifChkWind400");
  const gifChkWind250 = document.getElementById("gifChkWind250");
  const gifChkWind150 = document.getElementById("gifChkWind150");

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
  function setGifProgress(msg) { if (gifProgress) gifProgress.textContent = msg; }

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

  // Legend init (unchanged)
  function buildSo2LegendUrl() {
    const base = cfg.wms.url;
    const params = new URLSearchParams();
    params.set("service", "WMS");
    params.set("version", cfg.wms.version || "1.3.0");
    params.set("request", "GetLegendGraphic");
    params.set("format", "image/png");
    params.set("layer", cfg.wms.layers);
    if (cfg.wms.styles && String(cfg.wms.styles).trim() !== "") params.set("style", cfg.wms.styles);
    params.set("transparent", "true");
    return `${base}?${params.toString()}`;
  }
  function buildFallbackLegendDataUri() {
    // Paleta exacta TROPOMI SO2: blanco→lila→azul→cian→verde→amarillo→naranja→rojo
    const ticks = [
      { y: 18,  label: "10.0" },
      { y: 55,  label: "3.3"  },
      { y: 90,  label: "1.1"  },
      { y: 118, label: "0.3"  },
      { y: 140, label: "0.1"  },
      { y: 158, label: "0"    }
    ];
    const tickLines = ticks.map(t => `
      <line x1="52" y1="${t.y}" x2="58" y2="${t.y}" stroke="#333" stroke-width="1"/>
      <text x="62" y="${t.y + 4}" font-size="11" fill="#111" font-family="Arial,sans-serif">${t.label}</text>
    `).join("");
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="120" height="175" viewBox="0 0 120 175">
        <rect x="0" y="0" width="120" height="175" fill="white"/>
        <text x="8" y="13" font-size="11" font-weight="700" fill="#111" font-family="Arial,sans-serif">SO&#x2082; (DU)</text>
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="#c00000"/>
            <stop offset="8%"   stop-color="#e83020"/>
            <stop offset="18%"  stop-color="#e87820"/>
            <stop offset="28%"  stop-color="#e8c000"/>
            <stop offset="38%"  stop-color="#c8e040"/>
            <stop offset="50%"  stop-color="#40c878"/>
            <stop offset="62%"  stop-color="#40a0d8"/>
            <stop offset="72%"  stop-color="#8080c8"/>
            <stop offset="82%"  stop-color="#c8a0d0"/>
            <stop offset="92%"  stop-color="#e8d5e8"/>
            <stop offset="100%" stop-color="#ffffff"/>
          </linearGradient>
        </defs>
        <rect x="10" y="18" width="40" height="145" fill="url(#g)" stroke="#999" stroke-width="0.5"/>
        ${tickLines}
      </svg>
    `;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }
  function initSo2Legend() {
    const img = document.getElementById("so2LegendImg");
    if (!img) return;
    // Usamos siempre el SVG propio para tener control total sobre la escala
    img.src = buildFallbackLegendDataUri();
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

  // Tamaño base de íconos según zoom
  function iconSizeForZoom(zoom) {
    if (zoom <= 4)  return { ovdas: 10, other: 6 };
    if (zoom <= 5)  return { ovdas: 13, other: 7 };
    if (zoom <= 6)  return { ovdas: 16, other: 8 };
    if (zoom <= 7)  return { ovdas: 20, other: 10 };
    if (zoom <= 8)  return { ovdas: 24, other: 12 };
    if (zoom <= 9)  return { ovdas: 28, other: 14 };
    return              { ovdas: 32, other: 16 };
  }

  // Ícono OVDAS: volcán estilizado con cuerpo gris, nieve blanca y emisión de gases
  function ovdasDivIcon(sizePx) {
    const w = sizePx;
    const h = Math.round(sizePx * 1.3);
    // Coordenadas proporcionales al tamaño
    const cx = w / 2;
    // Montaña principal (gris oscuro)
    const bodyPath = `M${cx},${h * 0.1} L0,${h} L${w},${h} Z`;
    // Nieve/cráter (blanco-azulado, tapa superior)
    const snowPath = `M${cx},${h * 0.1} L${cx * 0.55},${h * 0.42} Q${cx},${h * 0.32} ${cx * 1.45},${h * 0.42} Z`;
    // Líneas de emisión (arcos sobre el cráter)
    const e1 = `M${cx * 0.7},${h * 0.07} Q${cx * 0.55},${h * -0.08} ${cx * 0.4},${h * 0.04}`;
    const e2 = `M${cx},${h * 0.02} Q${cx * 0.85},${h * -0.12} ${cx * 0.7},0`;
    const e3 = `M${cx * 1.3},${h * 0.07} Q${cx * 1.45},${h * -0.08} ${cx * 1.6},${h * 0.04}`;
    const sw = Math.max(1, sizePx / 18);
    const svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      <path d="${bodyPath}" fill="#4a5568" stroke="#1a202c" stroke-width="${sw * 0.6}" stroke-linejoin="round"/>
      <path d="${snowPath}" fill="#e8eaf0" stroke="#9aa5b4" stroke-width="${sw * 0.4}"/>
      <path d="${e1}" fill="none" stroke="#1a202c" stroke-width="${sw * 0.7}" stroke-linecap="round"/>
      <path d="${e2}" fill="none" stroke="#1a202c" stroke-width="${sw * 0.7}" stroke-linecap="round"/>
      <path d="${e3}" fill="none" stroke="#1a202c" stroke-width="${sw * 0.7}" stroke-linecap="round"/>
    </svg>`;
    return L.divIcon({ className: "volcano-icon", html: svg, iconSize: [w, h], iconAnchor: [Math.round(w/2), h] });
  }

  // Ícono otros volcanes: triángulo simple gris pequeño
  function otherDivIcon(sizePx) {
    const w = sizePx;
    const h = Math.round(sizePx * 1.1);
    const sw = Math.max(0.5, sizePx / 12);
    const svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      <polygon points="${w/2},0 0,${h} ${w},${h}" fill="#718096" stroke="#2d3748" stroke-width="${sw}" stroke-linejoin="round"/>
    </svg>`;
    return L.divIcon({ className: "volcano-icon", html: svg, iconSize: [w, h], iconAnchor: [Math.round(w/2), h] });
  }

  const volcanoMarkerOVDAS = (latlng) => L.marker(latlng, { icon: ovdasDivIcon(20) });
  const volcanoMarkerOther = (latlng) => L.marker(latlng, { icon: otherDivIcon(10) });
  const smelterMarker      = (latlng) => L.circleMarker(latlng, { radius: 5, weight: 1.5, fillOpacity: 0.85 });

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
    const chile = { type: "FeatureCollection", features: (gj.features || []).filter(f => isChileFeature(f.properties)) };
    return L.geoJSON(chile, { style: { color: "#000", weight: 2, fillOpacity: 0 } });
  }

  const layerControl = L.control.layers({}, {}, { collapsed: false }).addTo(map);

  let borderLayer = null;
  let volcanesOvdasLayer = null;
  let volcanesOtrosLayer = null;
  let smeltersLayer = null;

  function bindPermanentLabel(layer, text, className, direction, offset) {
    layer.bindTooltip(text, { permanent: false, direction: direction || "top", offset: offset || [0, -10], opacity: 1.0, className: className || "" });
  }

  function updateLabelsByZoom() {
    const z = map.getZoom();
    const zSmelter = cfg.zoomLabels?.smelter ?? 5;
    const zOvdas = cfg.zoomLabels?.ovdas ?? 7;
    const zOther = cfg.zoomLabels?.other ?? 9;
    const toggle = (layer, show) => layer.eachLayer(l => { const t = l.getTooltip?.(); if (!t) return; show ? l.openTooltip() : l.closeTooltip(); });
    if (smeltersLayer) toggle(smeltersLayer, z >= zSmelter);
    if (volcanesOvdasLayer) toggle(volcanesOvdasLayer, z >= zOvdas);
    if (volcanesOtrosLayer) toggle(volcanesOtrosLayer, z >= zOther);
  }

  // ---------------- Wind overlays (viewer) ----------------
  const windLayers = {};
  const WIND_LEVELS = [
    { key: "900hPa", label: "Viento (~1 km, 900 hPa)" },
    { key: "500hPa", label: "Viento (~5 km, 500 hPa)" },
    { key: "400hPa", label: "Viento (~7 km, 400 hPa)" },
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
    const φ1 = toRad(lat), λ1 = toRad(lon);
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

    const refSpeed = 10, baseLenKm = 120, minLenKm = 30, maxLenKm = 220, headKm = 10;
    const color = "#555", weight = 1.4, opacity = 0.75;

    const bounds = map.getBounds();
    const z = map.getZoom();
    const stride = (z <= 3) ? 40 : (z === 4) ? 25 : (z === 5) ? 14 : (z === 6) ? 9 : (z === 7) ? 6 : 3;

    for (let i = 0; i < pts.length; i += stride) {
      const p = pts[i];
      const lat = p.lat, lon = p.lon, u = p.u, v = p.v;
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(u) || !isFinite(v)) continue;
      if (!bounds.contains([lat, lon])) continue;

      const speed = Math.sqrt(u*u + v*v);
      const bearing = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;

      let lenKm = baseLenKm * (speed / refSpeed);
      lenKm = Math.max(minLenKm, Math.min(maxLenKm, lenKm));

      const a = arrowPolyline(lat, lon, bearing, lenKm, headKm);
      L.polyline([a.tail, a.tip], { color, weight, opacity, interactive: false }).addTo(layerGroup);
      L.polyline([a.left, a.tip, a.right], { color, weight, opacity, interactive: false }).addTo(layerGroup);
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
        if (ev.layer === windLayers[wl.key]) { refreshWindLayer(wl.key); break; }
      }
    });
    map.on("overlayremove", (ev) => {
      for (const wl of WIND_LEVELS) {
        if (ev.layer === windLayers[wl.key]) { windLayers[wl.key].clearLayers(); break; }
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

  // ---------------- GIF job module ----------------
  let ovdasVolcanoList = [];
  let roiRect = null;

  function kmToDegLat(km) { return km / 111.32; }
  function kmToDegLon(km, lat) { return km / (111.32 * Math.cos(lat * Math.PI / 180)); }

  function computeRoiBounds(lat, lon, sizeKm) {
    const half = sizeKm / 2;
    const dLat = kmToDegLat(half);
    const dLon = kmToDegLon(half, lat);
    return { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat };
  }

  function updateRoiOnMap(lat, lon) {
    const sizeKm = parseFloat(gifRoiSelect.value || "200");
    const b = computeRoiBounds(lat, lon, sizeKm);
    const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
    if (roiRect) roiRect.remove();
    roiRect = L.rectangle(bounds, { color: "#111", weight: 1, fillOpacity: 0.0, dashArray: "4,4" }).addTo(map);
  }

  function centerMapOnVolcano(lat, lon) { map.setView([lat, lon], 7); }

  function fillVolcanoSelect(list) {
    gifVolcanoSelect.innerHTML = `<option value="">Selecciona un volcán…</option>`;
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, "es"));
    for (const v of sorted) {
      const opt = document.createElement("option");
      opt.value = `${v.lat},${v.lon}`;
      opt.textContent = v.name;
      gifVolcanoSelect.appendChild(opt);
    }
  }

  function datesBetween(fromStr, toStr) {
    const out = [];
    const from = new Date(fromStr + "T00:00:00Z");
    const to = new Date(toStr + "T00:00:00Z");
    if (isNaN(from) || isNaN(to)) return out;
    for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      out.push(`${yyyy}-${mm}-${dd}`);
    }
    return out;
  }

  function getGifMode() {
    const el = document.querySelector('input[name="gifMode"]:checked');
    return el ? el.value : "range";
  }

  function safeName(s) {
    return (s || "volcano").replace(/[^\w\-\.]+/g, "_").replace(/^_+|_+$/g, "") || "volcano";
  }

  function downloadTextFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function expectedGifPath(volcanoName, dates, roiKm, sizePx) {
    const safeVol = safeName(volcanoName);
    const d0 = dates[0].replaceAll("-", "");
    const d1 = dates[dates.length - 1].replaceAll("-", "");
    const name = `SO2_${safeVol}_${d0}-${d1}_${roiKm}km_${sizePx}px.gif`;
    return `data/gifs/${safeVol}/${name}`;
  }

  function updatePreviewFromPath(path) {
    if (!gifPreview) return;
    gifPreview.src = path;
  }

  function prepareGifJob() {
    if (!gifVolcanoSelect.value) { setGifProgress("Selecciona un volcán."); return; }

    const [latStr, lonStr] = gifVolcanoSelect.value.split(",");
    const lat = parseFloat(latStr), lon = parseFloat(lonStr);
    const volcanoName = gifVolcanoSelect.options[gifVolcanoSelect.selectedIndex].textContent || "Volcán";

    const roiKm = parseInt(gifRoiSelect.value || "200", 10);
    const sizePx = parseInt(gifSize.value || "512", 10);
    const fps = parseInt(gifFps.value || "2", 10);

    const mode = getGifMode();
    let dates = [];
    if (mode === "lastN") {
      const n = Math.max(2, Math.min(120, parseInt(gifLastN.value || "14", 10)));
      const end = dateInput.value || todayUtcDateString();
      const endD = new Date(end + "T00:00:00Z");
      const startD = new Date(endD);
      startD.setUTCDate(startD.getUTCDate() - (n - 1));
      const yyyy = startD.getUTCFullYear();
      const mm = String(startD.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(startD.getUTCDate()).padStart(2, "0");
      dates = datesBetween(`${yyyy}-${mm}-${dd}`, end);
    } else {
      if (!gifFrom.value || !gifTo.value) { setGifProgress("Define Desde / Hasta."); return; }
      dates = datesBetween(gifFrom.value, gifTo.value);
    }

    if (!dates.length) { setGifProgress("Rango inválido."); return; }

    const roiBBox = computeRoiBounds(lat, lon, roiKm);
    const gifRelPath = expectedGifPath(volcanoName, dates, roiKm, sizePx);

    // Base overlays
    const includeChile = gifChkChileBorder ? gifChkChileBorder.checked : true;
    const includeVolcanoes = gifChkVolcanoesOvdas ? gifChkVolcanoesOvdas.checked : true;
    const includeSmelters = gifChkSmelters ? gifChkSmelters.checked : true;
    const includeLegend = gifChkLegend ? gifChkLegend.checked : true;

    // Wind overlays per level
    const wind900 = gifChkWind900 ? gifChkWind900.checked : false;
    const wind500 = gifChkWind500 ? gifChkWind500.checked : false;
    const wind400 = gifChkWind400 ? gifChkWind400.checked : false;
    const wind250 = gifChkWind250 ? gifChkWind250.checked : false;
    const wind150 = gifChkWind150 ? gifChkWind150.checked : false;

    const job = {
      version: 1,
      volcano_name: volcanoName,
      volcano_lat: lat,
      volcano_lon: lon,
      roi_km: roiKm,
      roi_bbox: roiBBox,
      date_from: dates[0],
      date_to: dates[dates.length - 1],
      size_px: sizePx,
      fps: fps,
      max_frames: 30,
      output_relpath: gifRelPath,

      skip_empty_frames: { enabled: true },

      overlays: {
        chile_border: includeChile,
        volcanoes_ovdas: includeVolcanoes,
        smelters: includeSmelters,

        volcanoes_ovdas_path: cfg.data.volcanoesOvdas,
        smelters_path: cfg.data.smelters,

        // ✅ wind layers (read from data/wind/YYYY-MM-DD/*.json)
        wind_900hPa: wind900,
        wind_500hPa: wind500,
        wind_400hPa: wind400,
        wind_250hPa: wind250,
        wind_150hPa: wind150,
        wind_style: {
          color_rgba: [85, 85, 85, 200],
          width: 2,
          opacity: 0.8,
          head_px: 10,
          base_len_px: 60,
          min_len_px: 20,
          max_len_px: 90,
          ref_speed: 10.0,
          // draw fewer arrows for big ROI
          stride: 2
        },

        chile_border_cfg: {
          stroke_rgba: [0, 0, 0, 220],
          stroke_width: 2,
          countries_url: cfg.data.countriesUrl
        }
      },

      wms: {
        url: cfg.wms.url,
        layers: cfg.wms.layers,
        styles: cfg.wms.styles || "",
        version: cfg.wms.version || "1.3.0",
        timeFormat: cfg.wms.timeFormat || "isoZ",
        legend: includeLegend
      }
    };

    downloadTextFile("gif_job.json", JSON.stringify(job, null, 2), "application/json");

    gifDownloadLink.style.display = "none";
    updatePreviewFromPath(gifRelPath);

    setGifProgress(
      "Job descargado ✅\n" +
      "1) Sube gif_job.json al repo en: jobs/gif_job.json\n" +
      "2) Actions → Build SO₂ GIF → Run workflow\n" +
      "3) Luego el GIF estará en: " + gifRelPath
    );
  }

  // ── Generación de GIF en el browser ─────────────────────────────────────
  let _gifGenerating = false;

  async function generateGifInBrowser() {
    if (_gifGenerating) return;

    if (!gifVolcanoSelect.value) {
      setGifProgress("Selecciona un volcán.");
      return;
    }

    const [latStr, lonStr] = gifVolcanoSelect.value.split(",");
    const lat = parseFloat(latStr), lon = parseFloat(lonStr);
    const volcanoName = gifVolcanoSelect.options[gifVolcanoSelect.selectedIndex].textContent;
    const roiKm = parseInt(gifRoiSelect.value || "200", 10);
    const sizePx = parseInt(gifSize.value || "512", 10);
    const fps   = parseInt(gifFps.value || "2", 10);
    const mode  = getGifMode();

    let dates = [];
    if (mode === "lastN") {
      const n = Math.max(2, Math.min(30, parseInt(gifLastN.value || "14", 10)));
      const end = dateInput.value || todayUtcDateString();
      const endD = new Date(end + "T00:00:00Z");
      const startD = new Date(endD);
      startD.setUTCDate(startD.getUTCDate() - (n - 1));
      dates = datesBetween(
        startD.toISOString().slice(0, 10),
        end
      );
    } else {
      if (!gifFrom.value || !gifTo.value) { setGifProgress("Define Desde / Hasta."); return; }
      dates = datesBetween(gifFrom.value, gifTo.value);
    }

    if (!dates.length) { setGifProgress("Rango inválido."); return; }
    if (dates.length > 30) { setGifProgress("Máximo 30 días por GIF."); return; }

    // BBox del ROI
    const roiBBox = computeRoiBounds(lat, lon, roiKm);
    const bbox = [roiBBox.west, roiBBox.south, roiBBox.east, roiBBox.north];

    // Cargar border GeoJSON para overlays
    let borderGeoJson = null;
    try {
      const resp = await fetch(cfg.data.countriesUrl, { cache: "force-cache" });
      const all = await resp.json();
      borderGeoJson = {
        type: "FeatureCollection",
        features: (all.features || []).filter(f => {
          const p = f.properties || {};
          return cfg.data.chileNamePropertyCandidates.some(k => p[k] && String(p[k]).toLowerCase() === "chile");
        })
      };
    } catch (e) { console.warn("No se pudo cargar el borde de Chile:", e); }

    // Volcanes para overlay
    const volcanoesForOverlay = ovdasVolcanoList;

    _gifGenerating = true;
    gifGenerateBtn.disabled = true;
    gifGenerateBtn.textContent = "Generando…";
    if (gifDownloadLink) gifDownloadLink.style.display = "none";

    try {
      const blob = await window.SO2GifMaker.generate({
        wmsUrl:     cfg.wms.url,
        wmsLayers:  cfg.wms.layers,
        wmsStyles:  cfg.wms.styles || "",
        wmsVersion: cfg.wms.version || "1.3.0",
        timeFormat: cfg.wms.timeFormat || "isoZ",
        dates,
        bbox,
        sizePx,
        fps,
        volcanoes: volcanoesForOverlay,
        borderGeoJson,
        onProgress: (msg, pct) => {
          setGifProgress(msg);
        }
      });

      // Ofrecer descarga
      const url = URL.createObjectURL(blob);
      const fname = `SO2_${safeName(volcanoName)}_${dates[0]}_${dates[dates.length-1]}_${roiKm}km.gif`;

      if (gifDownloadLink) {
        gifDownloadLink.href = url;
        gifDownloadLink.download = fname;
        gifDownloadLink.style.display = "";
        gifDownloadLink.textContent = "⬇ Descargar GIF";
      }

      // Preview
      if (gifPreview) gifPreview.src = url;

      setGifProgress(`✓ GIF listo — ${dates.length} frames, ${(blob.size/1024).toFixed(0)} KB`);

    } catch (e) {
      setGifProgress("Error al generar GIF: " + e.message);
      console.error(e);
    } finally {
      _gifGenerating = false;
      gifGenerateBtn.disabled = false;
      gifGenerateBtn.textContent = "Generar GIF";
    }
  }

  function wireGifUi() {
    if (gifGenerateBtn) gifGenerateBtn.textContent = "Generar GIF";

    const today = todayUtcDateString();
    if (gifFrom && gifTo) {
      const endD = new Date(today + "T00:00:00Z");
      const startD = new Date(endD);
      startD.setUTCDate(startD.getUTCDate() - 13);
      const yyyy = startD.getUTCFullYear();
      const mm   = String(startD.getUTCMonth() + 1).padStart(2, "0");
      const dd   = String(startD.getUTCDate()).padStart(2, "0");
      gifFrom.value = `${yyyy}-${mm}-${dd}`;
      gifTo.value   = today;
    }

    document.querySelectorAll('input[name="gifMode"]').forEach(r => {
      r.addEventListener("change", () => {
        const mode = getGifMode();
        gifRangeBlock.style.display  = (mode === "range")  ? "" : "none";
        gifLastNBlock.style.display  = (mode === "lastN") ? "" : "none";
      });
    });

    gifVolcanoSelect.addEventListener("change", () => {
      if (!gifVolcanoSelect.value) return;
      const [latStr, lonStr] = gifVolcanoSelect.value.split(",");
      centerMapOnVolcano(parseFloat(latStr), parseFloat(lonStr));
      updateRoiOnMap(parseFloat(latStr), parseFloat(lonStr));
      setGifProgress("ROI actualizado. Configura fechas y genera el GIF.");
    });

    gifRoiSelect.addEventListener("change", () => {
      if (!gifVolcanoSelect.value) return;
      const [latStr, lonStr] = gifVolcanoSelect.value.split(",");
      updateRoiOnMap(parseFloat(latStr), parseFloat(lonStr));
    });

    gifGenerateBtn.addEventListener("click", () => generateGifInBrowser());
  }

  // ---------------- Leyenda sincronizada ----------------
  const LEGEND_LAYERS = [
    { key: "so2",      label: "SO₂ (WMS)",              cls: "so2",     always: true },
    { key: "border",   label: "Límite Chile",            cls: "border",  layerRef: () => borderLayer },
    { key: "ovdas",    label: "Volcanes OVDAS",          cls: "volcano", layerRef: () => volcanesOvdasLayer },
    { key: "otros",    label: "Volcanes no monitoreados",cls: "volcano", layerRef: () => volcanesOtrosLayer },
    { key: "smelters", label: "Fundiciones",             cls: "smelter", layerRef: () => smeltersLayer },
  ];

  function updateLegend() {
    const container = document.getElementById("legendItems");
    if (!container) return;
    container.innerHTML = "";

    for (const item of LEGEND_LAYERS) {
      const isActive = item.always || (item.layerRef && item.layerRef() && map.hasLayer(item.layerRef()));
      if (!isActive) continue;
      const div = document.createElement("div");
      div.className = "legend-item";
      div.innerHTML = `<span class="swatch ${item.cls}"></span> ${item.label}`;
      container.appendChild(div);
    }

    // Viento: mostrar si algún nivel está activo
    const anyWind = WIND_LEVELS.some(wl => windLayers[wl.key] && map.hasLayer(windLayers[wl.key]));
    if (anyWind) {
      const activeWindLabels = WIND_LEVELS
        .filter(wl => windLayers[wl.key] && map.hasLayer(windLayers[wl.key]))
        .map(wl => wl.label.replace("Viento ", ""));
      const div = document.createElement("div");
      div.className = "legend-item";
      div.innerHTML = `<span class="swatch wind"></span> Viento (${activeWindLabels.join(", ")})`;
      container.appendChild(div);
    }
  }

  // ---------------- Panel colapsable ----------------
  function wireCollapsePanel() {
    const tab = document.getElementById("panelCollapseTab");
    const panel = document.getElementById("rightPanel");
    if (!tab || !panel) return;

    const PANEL_WIDTH = panel.offsetWidth || 440;
    let collapsed = false;

    function updateTab() {
      if (collapsed) {
        tab.style.right = "0px";
        tab.innerHTML = "&#8249;";
        tab.title = "Mostrar panel";
      } else {
        tab.style.right = (panel.offsetWidth) + "px";
        tab.innerHTML = "&#8250;";
        tab.title = "Ocultar panel";
      }
    }

    tab.addEventListener("click", () => {
      collapsed = !collapsed;
      panel.classList.toggle("collapsed", collapsed);
      updateTab();
      setTimeout(() => { map.invalidateSize(); updateTab(); }, 260);
    });

    updateTab();
  }

  // ---------------- Secciones colapsables ----------------
  function wireCollapsibleSections() {
    document.querySelectorAll(".section-header").forEach(btn => {
      const targetId = btn.dataset.target;
      const body = document.getElementById(targetId);
      if (!body) return;
      btn.classList.add("open");
      body.classList.add("open");
      btn.addEventListener("click", () => {
        const isOpen = body.classList.toggle("open");
        btn.classList.toggle("open", isOpen);
      });
    });
  }

  // ---------------- Panel de estadísticas SO₂ ----------------
  const SO2_STATS_URL = "data/so2_stats.json";
  let so2StatsData = null;
  let statsChart = null;

  async function loadSo2Stats() {
    try {
      const r = await fetch(SO2_STATS_URL, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  function alertLevel(tons) {
    if (tons <= 0)   return { cls: "alert-normal",   txt: "Sin anomalía detectada" };
    if (tons < 500)  return { cls: "alert-elevated",  txt: `⚠ Anomalía elevada: ${tons.toFixed(0)} t` };
    return             { cls: "alert-high",    txt: `🔴 Anomalía alta: ${tons.toFixed(0)} t` };
  }

  function renderStatsPanel(volcanoName) {
    const empty   = document.getElementById("statsEmpty");
    const metrics = document.getElementById("statsMetrics");
    const chartWrap = document.getElementById("statsChartWrap");
    const badge   = document.getElementById("statsAlertBadge");

    if (!so2StatsData || !volcanoName || !so2StatsData.volcanoes[volcanoName]) {
      if (empty) empty.style.display = "";
      if (metrics) metrics.style.display = "none";
      if (chartWrap) chartWrap.style.display = "none";
      if (badge) badge.style.display = "none";
      return;
    }

    const vData  = so2StatsData.volcanoes[volcanoName];
    const history = vData.history || [];
    const last30  = history.slice(-30);

    if (empty) empty.style.display = "none";
    if (metrics) metrics.style.display = "grid";
    if (chartWrap) chartWrap.style.display = "";

    // Métricas
    const lastEntry  = last30[last30.length - 1];
    const lastTons   = lastEntry ? lastEntry.so2_tons : 0;
    const maxTons    = Math.max(...last30.map(e => e.so2_tons || 0));
    const activeDays = last30.filter(e => e.so2_tons > 0).length;

    const statLastVal    = document.getElementById("statLastVal");
    const statMaxVal     = document.getElementById("statMaxVal");
    const statActiveDays = document.getElementById("statActiveDays");
    if (statLastVal)    statLastVal.textContent    = lastTons > 0 ? lastTons.toFixed(0) : "0";
    if (statMaxVal)     statMaxVal.textContent     = maxTons > 0 ? maxTons.toFixed(0) : "0";
    if (statActiveDays) statActiveDays.textContent = activeDays;

    // Badge de alerta
    if (badge) {
      const lvl = alertLevel(lastTons);
      badge.className = "stats-alert " + lvl.cls;
      badge.textContent = lvl.txt;
      badge.style.display = "";
    }

    // Gráfico
    const canvas = document.getElementById("statsChart");
    if (!canvas) return;

    // Fijar dimensiones para evitar crecimiento infinito en contenedor colapsado
    canvas.style.width  = "100%";
    canvas.style.height = "120px";
    canvas.height = 120;

    const labels = last30.map(e => e.date.slice(5));
    const values = last30.map(e => e.so2_tons || 0);
    const colors = values.map(v =>
      v <= 0   ? "rgba(120,140,200,0.25)" :
      v < 500  ? "rgba(245,158,11,0.7)"   :
                 "rgba(239,68,68,0.8)"
    );

    if (statsChart) { statsChart.destroy(); statsChart = null; }

    statsChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderRadius: 3,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: {
          callbacks: {
            label: ctx => `${ctx.parsed.y.toFixed(0)} t SO₂`
          }
        }},
        scales: {
          x: {
            ticks: { color: "#8fa0c0", font: { size: 9 }, maxRotation: 0,
              callback: (v, i) => i % 5 === 0 ? labels[i] : "" },
            grid: { color: "rgba(120,140,200,0.08)" }
          },
          y: {
            ticks: { color: "#8fa0c0", font: { size: 9 } },
            grid: { color: "rgba(120,140,200,0.08)" },
            beginAtZero: true
          }
        }
      }
    });
  }

  async function wireStatsPanel(ovdasList) {
    so2StatsData = await loadSo2Stats();

    const sel = document.getElementById("statsVolcanoSelect");
    if (!sel) return;

    sel.innerHTML = '<option value="">Selecciona un volcán…</option>';
    for (const v of ovdasList) {
      const opt = document.createElement("option");
      opt.value = v.name || v.Name;
      opt.textContent = v.name || v.Name;
      sel.appendChild(opt);
    }

    sel.addEventListener("change", () => {
      renderStatsPanel(sel.value);
    });

    if (!so2StatsData) {
      const empty = document.getElementById("statsEmpty");
      if (empty) empty.textContent = "Datos no disponibles aún. El workflow de extracción está corriendo.";
    }
  }
  async function init() {
    try {
      dateInput.value = todayUtcDateString();
      addSo2Layer(dateInput.value);
      setStatus("Cargando capas…");

      borderLayer = await loadChileBorder();
      borderLayer.addTo(map);
      layerControl.addOverlay(borderLayer, "Límite fronterizo Chile");

      volcanesOvdasLayer = await loadGeoJson(cfg.data.volcanoesOvdas, (latlng) => volcanoMarkerOVDAS(latlng), "Volcán OVDAS");
      const ovdasNames = new Set();
      volcanesOvdasLayer.eachLayer(l => {
        const p = l.feature?.properties || {};
        const name = nameFromProps(p, "Volcán");
        ovdasNames.add(name);
        bindPermanentLabel(l, name, "label-volcano", "top", [0, -12]);
        const ll = l.getLatLng();
        ovdasVolcanoList.push({ name, lat: ll.lat, lon: ll.lng });
      });
      volcanesOvdasLayer.addTo(map);
      layerControl.addOverlay(volcanesOvdasLayer, "Volcanes monitoreados (OVDAS)");

      volcanesOtrosLayer = await loadGeoJson(cfg.data.volcanoesAll, (latlng) => volcanoMarkerOther(latlng), "Volcán");
      // Eliminar del layer "otros" los volcanes que ya están en OVDAS
      const toRemove = [];
      volcanesOtrosLayer.eachLayer(l => {
        const p = l.feature?.properties || {};
        const name = nameFromProps(p, "Volcán");
        if (ovdasNames.has(name)) {
          toRemove.push(l);
        } else {
          bindPermanentLabel(l, name, "label-volcano", "top", [0, -10]);
        }
      });
      toRemove.forEach(l => volcanesOtrosLayer.removeLayer(l));
      volcanesOtrosLayer.addTo(map);
      layerControl.addOverlay(volcanesOtrosLayer, "Volcanes no monitoreados");

      // Traer OVDAS al frente para que no queden debajo de otros
      volcanesOvdasLayer.bringToFront();

      smeltersLayer = await loadGeoJson(cfg.data.smelters, (latlng) => smelterMarker(latlng), "Fundición");
      smeltersLayer.eachLayer(l => { if (l.setStyle) l.setStyle({ color: "#000", fillColor: "#000" }); });
      smeltersLayer.eachLayer(l => {
        const p = l.feature?.properties || {};
        bindPermanentLabel(l, nameFromProps(p, "Fundición"), "label-smelter", "right", [8, 0]);
      });
      smeltersLayer.addTo(map);
      layerControl.addOverlay(smeltersLayer, "Fundiciones");

      wireWindOverlays();

      // Redimensionar íconos de volcanes según zoom
      function resizeVolcanoIcons() {
        const zoom = map.getZoom();
        const sizes = iconSizeForZoom(zoom);
        if (volcanesOvdasLayer) {
          volcanesOvdasLayer.eachLayer(l => {
            if (l.setIcon) l.setIcon(ovdasDivIcon(sizes.ovdas));
          });
        }
        if (volcanesOtrosLayer) {
          volcanesOtrosLayer.eachLayer(l => {
            if (l.setIcon) l.setIcon(otherDivIcon(sizes.other));
          });
        }
      }

      map.on("zoomend", updateLabelsByZoom);
      map.on("zoomend", resizeVolcanoIcons);
      updateLabelsByZoom();
      resizeVolcanoIcons();

      map.on("zoomend", rerenderVisibleWind);
      map.on("moveend", rerenderVisibleWind);

      map.on("overlayadd overlayremove", updateLegend);

      initSo2Legend();
      fillVolcanoSelect(ovdasVolcanoList);
      wireGifUi();
      wireCollapsePanel();
      wireCollapsibleSections();
      updateLegend();
      wireStatsPanel(ovdasVolcanoList);

      setStatus(`Listo. Fecha (UTC): ${dateInput.value}. Cambia la fecha para actualizar SO₂.`);
      setGifProgress("Selecciona un volcán para comenzar.");
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
      setGifProgress(`Error: ${err.message}`);
    }
  }

  function shiftDate(days) {
    if (!dateInput.value) return;
    const d = new Date(dateInput.value + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    dateInput.value = `${yyyy}-${mm}-${dd}`;
    addSo2Layer(dateInput.value);
    rerenderVisibleWind();
  }

  dateInput.addEventListener("change", () => {
    addSo2Layer(dateInput.value);
    rerenderVisibleWind();
  });

  if (prevDayBtn) prevDayBtn.addEventListener("click", () => shiftDate(-1));
  if (nextDayBtn) nextDayBtn.addEventListener("click", () => shiftDate(+1));

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
