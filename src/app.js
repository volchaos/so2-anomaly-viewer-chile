/* global L, APP_CONFIG */
(function () {
  const cfg = window.APP_CONFIG;

  const statusEl = document.getElementById("status");
  const dateInput = document.getElementById("dateInput");
  const opacityInput = document.getElementById("opacityInput");
  const todayBtn = document.getElementById("todayBtn");
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

  // ✅ NEW GIF overlay toggles
  const gifChkChileBorder = document.getElementById("gifChkChileBorder");
  const gifChkVolcanoesOvdas = document.getElementById("gifChkVolcanoesOvdas");
  const gifChkSmelters = document.getElementById("gifChkSmelters");
  const gifChkLegend = document.getElementById("gifChkLegend");

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

  // ---------------- SO₂ Legend (DU) ----------------
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
    const ticks = [
      { y: 10, label: "10" }, { y: 45, label: "5" }, { y: 80, label: "2" },
      { y: 105, label: "1" }, { y: 125, label: "0.5" }, { y: 145, label: "0" }
    ];
    const tickLines = ticks.map(t => `
      <line x1="70" y1="${t.y}" x2="78" y2="${t.y}" stroke="#111" stroke-width="1"/>
      <text x="82" y="${t.y + 4}" font-size="10" fill="#111" font-family="Arial">${t.label}</text>
    `).join("");
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="160" height="190" viewBox="0 0 160 190">
        <rect x="0" y="0" width="160" height="190" fill="white"/>
        <text x="10" y="16" font-size="12" font-weight="700" fill="#111" font-family="Arial">SO₂ (DU)</text>
        <defs>
          <linearGradient id="g" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%"  stop-color="#2c7bb6"/>
            <stop offset="20%" stop-color="#abd9e9"/>
            <stop offset="40%" stop-color="#ffffbf"/>
            <stop offset="60%" stop-color="#fdae61"/>
            <stop offset="80%" stop-color="#f46d43"/>
            <stop offset="100%" stop-color="#a50026"/>
          </linearGradient>
        </defs>
        <rect x="18" y="28" width="42" height="140" fill="url(#g)" stroke="#111" stroke-width="1"/>
        ${tickLines}
        <text x="10" y="185" font-size="9" fill="#444" font-family="Arial">(fallback)</text>
      </svg>
    `;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  function initSo2Legend() {
    const img = document.getElementById("so2LegendImg");
    if (!img) return;
    const url = buildSo2LegendUrl();
    img.onerror = () => { img.onerror = null; img.src = buildFallbackLegendDataUri(); };
    img.src = url;
    img.onload = () => { if (img.naturalWidth <= 2 || img.naturalHeight <= 2) img.src = buildFallbackLegendDataUri(); };
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
        <polygon points="${w/2},0 0,${h} ${w},${h}" fill="black" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>
      </svg>
    `;
    return L.divIcon({ className: "volcano-icon", html: svg, iconSize: [w, h], iconAnchor: [Math.round(w/2), h] });
  }
  const volcanoMarkerOVDAS = (latlng) => L.marker(latlng, { icon: volcanoDivIcon(18, "red") });
  const volcanoMarkerOther = (latlng) => L.marker(latlng, { icon: volcanoDivIcon(9, null) });
  const smelterMarker = (latlng) => L.circleMarker(latlng, { radius: 6, weight: 2, fillOpacity: 0.9 });

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
    layer.bindTooltip(text, { permanent: true, direction: direction || "top", offset: offset || [0, -10], opacity: 0.9, className: className || "" });
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

  // ---------------- Wind overlays ----------------
  const windLayers = {};
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

  // ---------------- GIF job module (server-side) ----------------
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

    // Read toggles (default true if element missing)
    const includeChile = gifChkChileBorder ? gifChkChileBorder.checked : true;
    const includeVolcanoes = gifChkVolcanoesOvdas ? gifChkVolcanoesOvdas.checked : true;
    const includeSmelters = gifChkSmelters ? gifChkSmelters.checked : true;
    const includeLegend = gifChkLegend ? gifChkLegend.checked : true;

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

      // auto-skip frames sin datos
      skip_empty_frames: { enabled: true },

      // ✅ overlays elegibles
      overlays: {
        chile_border: includeChile,
        volcanoes_ovdas: includeVolcanoes,
        smelters: includeSmelters,

        // paths locales (repo) para que el Action dibuje puntos sin CORS
        volcanoes_ovdas_path: cfg.data.volcanoesOvdas,
        smelters_path: cfg.data.smelters,

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

  function wireGifUi() {
    if (gifGenerateBtn) gifGenerateBtn.textContent = "Preparar GIF (job)";

    const today = todayUtcDateString();
    if (gifFrom && gifTo) {
      const endD = new Date(today + "T00:00:00Z");
      const startD = new Date(endD);
      startD.setUTCDate(startD.getUTCDate() - 13);
      const yyyy = startD.getUTCFullYear();
      const mm = String(startD.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(startD.getUTCDate()).padStart(2, "0");
      gifFrom.value = `${yyyy}-${mm}-${dd}`;
      gifTo.value = today;
    }

    document.querySelectorAll('input[name="gifMode"]').forEach(r => {
      r.addEventListener("change", () => {
        const mode = getGifMode();
        gifRangeBlock.style.display = (mode === "range") ? "" : "none";
        gifLastNBlock.style.display = (mode === "lastN") ? "" : "none";
      });
    });

    gifVolcanoSelect.addEventListener("change", () => {
      if (!gifVolcanoSelect.value) return;
      const [latStr, lonStr] = gifVolcanoSelect.value.split(",");
      const lat = parseFloat(latStr), lon = parseFloat(lonStr);
      centerMapOnVolcano(lat, lon);
      updateRoiOnMap(lat, lon);
      setGifProgress("ROI actualizado. Define fechas y prepara el job.");
    });

    gifRoiSelect.addEventListener("change", () => {
      if (!gifVolcanoSelect.value) return;
      const [latStr, lonStr] = gifVolcanoSelect.value.split(",");
      updateRoiOnMap(parseFloat(latStr), parseFloat(lonStr));
    });

    gifGenerateBtn.addEventListener("click", () => prepareGifJob());
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
        const name = nameFromProps(p, "Volcán");
        bindPermanentLabel(l, name, "label-volcano", "top", [0, -12]);
        const ll = l.getLatLng();
        ovdasVolcanoList.push({ name, lat: ll.lat, lon: ll.lng });
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

      initSo2Legend();

      fillVolcanoSelect(ovdasVolcanoList);
      wireGifUi();

      setStatus(`Listo. Fecha (UTC): ${dateInput.value}. Cambia la fecha para actualizar SO₂.`);
      setGifProgress("Selecciona un volcán para comenzar.");
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
      setGifProgress(`Error: ${err.message}`);
    }
  }

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
