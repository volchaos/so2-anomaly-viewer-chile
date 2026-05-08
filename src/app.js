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
  const windUnitsSelect = document.getElementById("windUnitsSelect");

  // Listener para refrescar capas de viento al cambiar unidades
  if (windUnitsSelect) {
    windUnitsSelect.addEventListener("change", () => {
      for (const wl of WIND_LEVELS) {
        if (windLayers[wl.key] && map.hasLayer(windLayers[wl.key])) {
          refreshWindLayer(wl.key);
        }
      }
    });
  }
  const gifPreview            = document.getElementById("gifPreview");
  const gifPreviewWrap        = document.getElementById("gifPreviewWrap");
  const gifPreviewPlaceholder = document.getElementById("gifPreviewPlaceholder");
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
  const gifProgressFill = document.getElementById("gifProgressFill");
  const gifProgressWrap = document.getElementById("gifProgressWrap");

  function setGifProgress(msg, pct) {
    if (gifProgress) gifProgress.textContent = msg;
    if (gifProgressFill && gifProgressWrap) {
      if (pct !== undefined) {
        gifProgressWrap.style.display = "";
        gifProgressFill.style.width = Math.round(pct) + "%";
      } else {
        gifProgressWrap.style.display = "none";
        gifProgressFill.style.width = "0%";
      }
    }
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
      { y: 22,  label: "10.0" },
      { y: 62,  label: "3.3"  },
      { y: 101, label: "1.1"  },
      { y: 132, label: "0.3"  },
      { y: 155, label: "0.1"  },
      { y: 175, label: "0"    }
    ];
    const tickLines = ticks.map(t => `
      <line x1="52" y1="${t.y}" x2="60" y2="${t.y}" stroke="#3d4d6a" stroke-width="1.2"/>
      <text x="64" y="${t.y + 4}" font-size="13" fill="#7a8aaa" font-family="'IBM Plex Mono',monospace">${t.label}</text>
    `).join("");
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="130" height="195" viewBox="0 0 130 195">
        <rect x="0" y="0" width="130" height="195" fill="#161b26"/>
        <text x="8" y="16" font-size="14" font-weight="600" fill="#e2e8f0" font-family="'IBM Plex Mono',monospace">SO₂ (DU)</text>
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
        <rect x="10" y="22" width="40" height="175" fill="url(#g)" stroke="#999" stroke-width="0.5"/>
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
    if (zoom <= 4)  return { ovdas: 10, other: 6,  smelter: 4 };
    if (zoom <= 5)  return { ovdas: 13, other: 7,  smelter: 5 };
    if (zoom <= 6)  return { ovdas: 16, other: 8,  smelter: 6 };
    if (zoom <= 7)  return { ovdas: 20, other: 10, smelter: 7 };
    if (zoom <= 8)  return { ovdas: 24, other: 12, smelter: 8 };
    if (zoom <= 9)  return { ovdas: 28, other: 14, smelter: 9 };
    return              { ovdas: 32, other: 16, smelter: 10 };
  }

  // Ícono OVDAS: volcán estilizado con cuerpo gris y nieve blanca
  function ovdasDivIcon(sizePx) {
    const w = sizePx;
    const h = Math.round(sizePx * 1.15);
    const cx = w / 2;
    const sw = Math.max(0.5, sizePx / 20);
    // Montaña principal (gris oscuro)
    const bodyPath = `M${cx},0 L0,${h} L${w},${h} Z`;
    // Nieve/cráter (blanco-azulado, tapa superior ~35%)
    const snowPath = `M${cx},0 L${cx*0.52},${h*0.38} Q${cx},${h*0.28} ${cx*1.48},${h*0.38} Z`;
    const svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      <path d="${bodyPath}" fill="#4a5568" stroke="#1a202c" stroke-width="${sw}" stroke-linejoin="round"/>
      <path d="${snowPath}" fill="#e8eaf0" stroke="#9aa5b4" stroke-width="${sw * 0.5}"/>
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
  const smelterMarker      = (latlng) => L.circleMarker(latlng, { radius: 7, weight: 1.5, fillOpacity: 0.9, color: "#000", fillColor: "#111" });

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

  const layerControl = L.control.layers({}, {}, { collapsed: true }).addTo(map);

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

    const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSO","SO","OSO","O","ONO","NO","NNO"];

    for (let i = 0; i < pts.length; i += stride) {
      const p = pts[i];
      const lat = p.lat, lon = p.lon, u = p.u, v = p.v;
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(u) || !isFinite(v)) continue;
      if (!bounds.contains([lat, lon])) continue;

      const speed = Math.sqrt(u*u + v*v);
      const bearing = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;
      const fromBearing = (bearing + 180) % 360;
      const dir = dirs[Math.round(fromBearing / 22.5) % 16];
      const useKmh = !windUnitsSelect || windUnitsSelect.value === "kmh";
      const speedDisplay = useKmh ? Math.round(speed * 3.6) + " km/h" : speed.toFixed(1) + " m/s";
      let lenKm = baseLenKm * (speed / refSpeed);
      lenKm = Math.max(minLenKm, Math.min(maxLenKm, lenKm));

      const a = arrowPolyline(lat, lon, bearing, lenKm, headKm);
      L.polyline([a.tail, a.tip], { color, weight, opacity, interactive: false }).addTo(layerGroup);
      L.polyline([a.left, a.tip, a.right], { color, weight, opacity, interactive: false }).addTo(layerGroup);

      // Etiqueta de velocidad en el punto medio de la flecha
      const midLat = (a.tail[0] + a.tip[0]) / 2;
      const midLon = (a.tail[1] + a.tip[1]) / 2;
      const label = `${speedDisplay}<br><span style="font-size:8px">${dir}</span>`;
      L.marker([midLat, midLon], {
        icon: L.divIcon({
          className: "wind-speed-label",
          html: label,
          iconSize: [36, 20],
          iconAnchor: [18, 10]
        }),
        interactive: false
      }).addTo(layerGroup);
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
      if (wl.key !== "400hPa") {  // 400 hPa (~7 km) deshabilitado temporalmente
        layerControl.addOverlay(lg, wl.label);
      }
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
      const n = Math.max(2, Math.min(90, parseInt(gifLastN.value || "14", 10)));
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
    if (dates.length > 90) { setGifProgress("Máximo 90 días por GIF."); return; }
    if (dates.length > 30) { setGifProgress(`Generando GIF de ${dates.length} días — puede tardar varios minutos…`); await new Promise(r => setTimeout(r, 100)); }

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
        wmsUrl:          cfg.wms.url,
        wmsLayers:       cfg.wms.layers,
        wmsStyles:       cfg.wms.styles || "",
        wmsVersion:      cfg.wms.version || "1.3.0",
        timeFormat:      cfg.wms.timeFormat || "isoZ",
        dates,
        bbox,
        sizePx,
        fps,
        roiKm,
        volcanoes:       volcanoesForOverlay,
        selectedVolcano: volcanoName,
        borderGeoJson,
        onProgress: (msg, pct) => {
          setGifProgress(msg, pct);
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
      if (gifPreview) {
        gifPreview.src = url;
        if (gifPreviewWrap) gifPreviewWrap.style.display = "";
        if (gifPreviewPlaceholder) gifPreviewPlaceholder.style.display = "none";
      }

      setGifProgress(`✓ GIF listo — ${dates.length} frames, ${(blob.size/1024).toFixed(0)} KB`);

    } catch (e) {
      setGifProgress("Error al generar GIF: " + e.message);
      if (gifProgressWrap) gifProgressWrap.style.display = "none";
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

    // SVG inline para cada tipo de ícono — coinciden exactamente con los del mapa
    const swatchSvg = {
      so2:     `<span style="display:inline-block;width:28px;height:12px;background:linear-gradient(to right,#2c7bb6,#40c878,#e8c000,#d73027);border-radius:3px;vertical-align:middle"></span>`,
      border:  `<svg width="20" height="14" viewBox="0 0 20 14"><rect x="1" y="4" width="18" height="6" fill="none" stroke="#333" stroke-width="2" rx="1"/></svg>`,
      volcano: `<svg width="18" height="20" viewBox="0 0 18 20">
                  <path d="M9,0 L0,20 L18,20 Z" fill="#4a5568" stroke="#1a202c" stroke-width="0.8" stroke-linejoin="round"/>
                  <path d="M9,0 L4.7,7.6 Q9,5.6 13.3,7.6 Z" fill="#e8eaf0" stroke="#9aa5b4" stroke-width="0.5"/>
                </svg>`,
      other:   `<svg width="14" height="14" viewBox="0 0 14 14">
                  <polygon points="7,1 0,13 14,13" fill="#718096" stroke="#2d3748" stroke-width="0.8" stroke-linejoin="round"/>
                </svg>`,
      smelter: `<svg width="14" height="14" viewBox="0 0 14 14">
                  <circle cx="7" cy="7" r="5.5" fill="#111" stroke="#000" stroke-width="1.5"/>
                </svg>`,
      wind:    `<svg width="20" height="14" viewBox="0 0 20 14"><line x1="2" y1="7" x2="18" y2="7" stroke="#555" stroke-width="1.5" stroke-dasharray="3,2"/></svg>`
    };

    const LEGEND_LAYERS_MAP = {
      so2:     { label: "SO₂ (WMS)",              swatch: "so2" },
      border:  { label: "Límite Chile",            swatch: "border" },
      ovdas:   { label: "Volcanes OVDAS",          swatch: "volcano" },
      otros:   { label: "Volcanes no monitoreados",swatch: "other" },
      smelters:{ label: "Fundiciones",             swatch: "smelter" },
    };

    for (const item of LEGEND_LAYERS) {
      const isActive = item.always || (item.layerRef && item.layerRef() && map.hasLayer(item.layerRef()));
      if (!isActive) continue;
      const cfg2 = LEGEND_LAYERS_MAP[item.key];
      if (!cfg2) continue;
      const div = document.createElement("div");
      div.className = "legend-item";
      div.innerHTML = `${swatchSvg[cfg2.swatch] || ""} ${cfg2.label}`;
      container.appendChild(div);
    }

    // Viento
    const anyWind = WIND_LEVELS.some(wl => windLayers[wl.key] && map.hasLayer(windLayers[wl.key]));
    if (anyWind) {
      const activeWindLabels = WIND_LEVELS
        .filter(wl => windLayers[wl.key] && map.hasLayer(windLayers[wl.key]))
        .map(wl => wl.label.replace("Viento ", ""));
      const div = document.createElement("div");
      div.className = "legend-item";
      div.innerHTML = `${swatchSvg.wind} Viento (${activeWindLabels.join(", ")})`;
      container.appendChild(div);
    }
  }

  // ---------------- Mobile: bottom tab bar ----------------
  function wireMobileTabs() {
    const mapBtn   = document.getElementById("mobileTabMap");
    const panelBtn = document.getElementById("mobileTabPanel");
    const leftEl   = document.querySelector(".left");
    const rightEl  = document.querySelector(".right");
    if (!mapBtn || !panelBtn || !leftEl || !rightEl) return;

    function setTab(tab) {
      const toMap = tab === "map";
      leftEl.classList.toggle("tab-visible",  toMap);
      rightEl.classList.toggle("tab-visible", !toMap);
      mapBtn.classList.toggle("active",   toMap);
      panelBtn.classList.toggle("active", !toMap);
      if (toMap) setTimeout(() => map.invalidateSize(), 50);
    }

    mapBtn.addEventListener("click",   () => setTab("map"));
    panelBtn.addEventListener("click", () => setTab("panel"));
    setTab("map");
  }

  // ---------------- Mobile: ajustes rápidos (opacity + viento) ----------------
  function wireMobileQuickSettings() {
    const opacityMobile    = document.getElementById("opacityMobile");
    const windUnitsMobile  = document.getElementById("windUnitsMobile");
    if (!opacityMobile && !windUnitsMobile) return;

    // Opacity mobile ↔ topbar
    if (opacityMobile) {
      opacityMobile.value = opacityInput.value;
      opacityMobile.addEventListener("input", () => {
        opacityInput.value = opacityMobile.value;
        if (so2Layer) so2Layer.setOpacity(parseFloat(opacityMobile.value));
      });
      opacityInput.addEventListener("input", () => {
        opacityMobile.value = opacityInput.value;
      });
    }

    // Wind units mobile ↔ topbar (reutiliza el listener existente de windUnitsSelect)
    if (windUnitsMobile && windUnitsSelect) {
      windUnitsMobile.value = windUnitsSelect.value;
      windUnitsMobile.addEventListener("change", () => {
        windUnitsSelect.value = windUnitsMobile.value;
        windUnitsSelect.dispatchEvent(new Event("change"));
      });
      windUnitsSelect.addEventListener("change", () => {
        windUnitsMobile.value = windUnitsSelect.value;
      });
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
    if (tons <    1) return { cls: "alert-normal",    txt: "Sin anomalía detectada" };
    if (tons <   50) return { cls: "alert-trace",     txt: `〜 Traza: ${tons.toFixed(0)} t` };
    if (tons <  150) return { cls: "alert-low",       txt: `▲ Baja: ${tons.toFixed(0)} t` };
    if (tons <  400) return { cls: "alert-medium",    txt: `⚠ Media: ${tons.toFixed(0)} t` };
    if (tons < 1000) return { cls: "alert-high",      txt: `🔴 Alta: ${tons.toFixed(0)} t` };
    return                   { cls: "alert-eruption", txt: `🔴 Muy alta: ${tons.toFixed(0)} t` };
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
      v <    1 ? "rgba(120,140,200,0.2)"  :   // sin anomalía
      v <   50 ? "rgba(100,130,210,0.5)"  :   // traza
      v <  150 ? "rgba(234,179,8,0.65)"   :   // baja
      v <  400 ? "rgba(245,130,30,0.75)"  :   // media
      v < 1000 ? "rgba(239,68,68,0.8)"    :   // alta
                 "rgba(220,20,220,0.9)"       // muy alta/eruptiva
    );

    // Escala Y: mínimo 10 t, crece dinámicamente si hay valores mayores
    const MIN_Y = 10;
    const rawMax = Math.max(...values, 0);
    // Redondear hacia arriba a un valor "limpio"
    const niceMax = rawMax <= MIN_Y ? MIN_Y :
      rawMax <= 20  ? 20  :
      rawMax <= 30  ? 30  :
      rawMax <= 50  ? 50  :
      rawMax <= 75  ? 75  :
      rawMax <= 100 ? 100 :
      rawMax <= 150 ? 150 :
      Math.ceil(rawMax / 50) * 50;

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
            label: ctx => `${ctx.parsed.y.toFixed(1)} t SO₂`
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
            beginAtZero: true,
            max: niceMax,
            min: 0
          }
        }
      }
    });
  }

  // ── Panel NASA GSFC SO₂ ────────────────────────────────────────────────
  function nasaImgCandidates(bn, date) {
    const yr4    = date.getUTCFullYear();
    const yr2    = String(yr4).slice(-2);
    const mo     = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dy     = String(date.getUTCDate()).padStart(2, "0");
    const folder = `${mo}${yr2}`;
    const full   = `${yr4}${mo}${dy}`;
    // Confirmed pattern: BN_tropomi_so2trm_YYYYMMDD.png
    return [
      `https://so2.gsfc.nasa.gov/pix/daily/${folder}/${bn}_tropomi_so2trm_${full}.png`,
    ];
  }

  function nasaPageUrl(bn, date) {
    const yr = String(date.getUTCFullYear()).slice(-2);
    const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dy = String(date.getUTCDate()).padStart(2, "0");
    return `https://so2.gsfc.nasa.gov/pix/daily/ixxxza/troploop5pca.php?yr=${yr}&mo=${mo}&dy=${dy}&bn=${bn}`;
  }

  function tryNasaImg(url) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload  = () => resolve(url);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async function findLatestNasaImage(bn, fromDate) {
    for (let back = 0; back <= 10; back++) {
      const d = new Date(fromDate);
      d.setUTCDate(d.getUTCDate() - back);
      const results = await Promise.all(nasaImgCandidates(bn, d).map(tryNasaImg));
      const found = results.find(r => r !== null);
      if (found) return { url: found, date: d };
    }
    return null;
  }

  function wireNasaPanel() {
    const regionSel = document.getElementById("nasaRegionSelect");
    const nasaDate  = document.getElementById("nasaDateInput");
    const prevBtn   = document.getElementById("nasaPrevBtn");
    const nextBtn   = document.getElementById("nasaNextBtn");
    const statusEl  = document.getElementById("nasaStatus");
    const wrapEl    = document.getElementById("nasaImageWrap");
    const imgEl     = document.getElementById("nasaImg");
    const linkEl    = document.getElementById("nasaLink");
    if (!regionSel || !nasaDate) return;

    const labels = { nchile: "Norte de Chile", cchile: "Central Chile", schile: "Sur de Chile" };

    // Init with today's UTC date
    nasaDate.value = new Date().toISOString().slice(0, 10);

    async function loadNasaImage(autoFind = false) {
      const bn = regionSel.value;
      if (statusEl) { statusEl.textContent = "Buscando imagen…"; statusEl.style.display = ""; }
      if (wrapEl)   wrapEl.style.display = "none";

      const fromDate = new Date(nasaDate.value + "T00:00:00Z");
      let result = null;

      if (autoFind) {
        result = await findLatestNasaImage(bn, fromDate);
        if (result) nasaDate.value = result.date.toISOString().slice(0, 10);
      } else {
        const candidates = nasaImgCandidates(bn, fromDate);
        const results = await Promise.all(candidates.map(tryNasaImg));
        const found = results.find(r => r !== null);
        if (found) result = { url: found, date: fromDate };
      }

      if (!result) {
        if (statusEl) statusEl.textContent = autoFind
          ? "No se encontró imagen reciente para esta región."
          : `Sin imagen disponible para ${nasaDate.value}.`;
        return;
      }

      const dateStr = result.date.toISOString().slice(0, 10);
      if (statusEl) statusEl.textContent = `${labels[bn] || bn} · ${dateStr}`;
      if (imgEl)    imgEl.src = result.url;
      if (linkEl)   linkEl.href = nasaPageUrl(bn, result.date);
      if (wrapEl)   wrapEl.style.display = "";
    }

    function shiftDate(days) {
      const d = new Date(nasaDate.value + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + days);
      nasaDate.value = d.toISOString().slice(0, 10);
      loadNasaImage(false);
    }

    prevBtn?.addEventListener("click", () => shiftDate(-1));
    nextBtn?.addEventListener("click", () => shiftDate(+1));
    nasaDate.addEventListener("change", () => loadNasaImage(false));
    regionSel.addEventListener("change", () => loadNasaImage(false));

    let loaded = false;
    const header = document.querySelector('[data-target="secNasa"]');
    if (header) {
      header.addEventListener("click", () => {
        const body = document.getElementById("secNasa");
        if (body?.classList.contains("open") && !loaded) {
          loaded = true;
          loadNasaImage(true);
        }
      });
    }
  }

  async function wireStatsPanel() {
    so2StatsData = await loadSo2Stats();

    if (!so2StatsData) {
      const empty = document.getElementById("statsEmpty");
      if (empty) empty.textContent = "Datos no disponibles aún. El workflow de extracción está corriendo.";
    }

    gifVolcanoSelect.addEventListener("change", () => {
      const name = gifVolcanoSelect.value
        ? gifVolcanoSelect.options[gifVolcanoSelect.selectedIndex].textContent.trim()
        : "";
      renderStatsPanel(name);
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

      // Redimensionar íconos de volcanes y fundiciones según zoom
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
        if (smeltersLayer) {
          smeltersLayer.eachLayer(l => {
            if (l.setRadius) l.setRadius(sizes.smelter);
          });
        }
      }

      map.on("zoomend", updateLabelsByZoom);
      map.on("zoomend", resizeVolcanoIcons);
      map.on("click",   updateLabelsByZoom);   // reabrir etiquetas tras tap mobile
      updateLabelsByZoom();
      resizeVolcanoIcons();

      map.on("zoomend", rerenderVisibleWind);
      map.on("moveend", rerenderVisibleWind);

      map.on("overlayadd overlayremove", updateLegend);

      initSo2Legend();
      fillVolcanoSelect(ovdasVolcanoList);
      wireGifUi();
      wireMobileTabs();
      wireMobileQuickSettings();
      wireCollapsePanel();
      wireCollapsibleSections();
      updateLegend();
      wireStatsPanel();
      wireNasaPanel();

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
