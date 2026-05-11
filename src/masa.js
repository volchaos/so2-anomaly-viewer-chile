/* global L, GeoTIFF */
/* Pestaña de cálculo interactivo de masa SO₂ en el navegador.
   Requiere: Leaflet.draw y geotiff.js cargados antes que este script. */
(function () {
  "use strict";

  const DU_TO_G_PER_M2 = 2.856e-2;   // 1 DU SO₂ = 2.856×10⁻² g/m²
  const NODATA         = -9999.0;
  const R_EARTH        = 6_371_000;   // radio terrestre medio (m)

  let _map         = null;
  let _raster      = null;   // { data: Float32Array, bbox, width, height }
  let _drawnItems  = null;   // L.FeatureGroup
  let _drawHandler = null;   // L.Draw.Polygon
  let _drawnRing   = null;   // [[lon, lat], ...] outer ring (cerrado)
  let _rasterLayer = null;   // L.imageOverlay con colormap
  let _lastResult  = null;   // { metrics, dateStr, volcanoName }

  // ── DOM helper ────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  function setStatus(msg, warn = false) {
    const s = el("masaStatus");
    if (!s) return;
    s.textContent   = msg;
    s.style.color        = warn ? "var(--accent)" : "";
    s.style.borderColor  = warn ? "rgba(230,160,50,0.4)" : "";
  }

  // ── Ray-casting point-in-polygon ──────────────────────────────────────────
  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) &&
          lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }

  // ── Cálculo de masa ────────────────────────────────────────────────────────
  function calculateMass(raster, ring) {
    const { data, bbox, width, height } = raster;
    const [west, south, east, north] = bbox;
    const resX = (east - west) / width;
    const resY = (north - south) / height;

    let massG = 0, areaM2 = 0, maxDU = 0, pixels = 0, wLat = 0, wLon = 0;

    for (let row = 0; row < height; row++) {
      const lat    = north - (row + 0.5) * resY;
      const cosLat = Math.abs(Math.cos(lat * Math.PI / 180));
      // Área real del píxel corregida por latitud (m²)
      const cellArea = resY * (Math.PI / 180) * R_EARTH *
                       resX * (Math.PI / 180) * R_EARTH * cosLat;

      for (let col = 0; col < width; col++) {
        const val = data[row * width + col];
        if (!isFinite(val) || val <= NODATA + 1 || val <= 0) continue;

        const lon = west + (col + 0.5) * resX;
        if (!pointInRing(lon, lat, ring)) continue;

        const g = val * DU_TO_G_PER_M2 * cellArea;
        massG  += g;
        areaM2 += cellArea;
        if (val > maxDU) maxDU = val;
        pixels++;
        wLat += lat * g;
        wLon += lon * g;
      }
    }

    return {
      so2_tons:     massG / 1e6,
      max_du:       maxDU,
      plume_pixels: pixels,
      plume_km2:    areaM2 / 1e6,
      centroid_lat: massG > 0 ? wLat / massG : null,
      centroid_lon: massG > 0 ? wLon / massG : null,
    };
  }

  // ── Colormap TROPOMI SO₂: blanco→lila→azul→cian→verde→amarillo→naranja→rojo
  const CMAP = [
    [0.0,  [255, 255, 255]],
    [0.3,  [200, 160, 210]],
    [0.8,  [128, 128, 200]],
    [1.5,  [ 64, 160, 216]],
    [3.0,  [ 64, 200, 120]],
    [5.0,  [232, 192,   0]],
    [8.0,  [232, 120,  32]],
    [12.0, [192,   0,   0]],
  ];

  function duToRgba(du) {
    if (du <= 0) return [0, 0, 0, 0];
    let i = 0;
    while (i < CMAP.length - 2 && du >= CMAP[i + 1][0]) i++;
    if (du >= CMAP[CMAP.length - 1][0])
      return [...CMAP[CMAP.length - 1][1], 210];
    const [du0, c0] = CMAP[i], [du1, c1] = CMAP[i + 1];
    const t = (du - du0) / (du1 - du0);
    return [
      Math.round(c0[0] + t * (c1[0] - c0[0])),
      Math.round(c0[1] + t * (c1[1] - c0[1])),
      Math.round(c0[2] + t * (c1[2] - c0[2])),
      190,
    ];
  }

  // ── Overlay del raster en el mapa ─────────────────────────────────────────
  function renderRasterOverlay(raster) {
    const { data, bbox, width, height } = raster;
    const [west, south, east, north] = bbox;

    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(width, height);

    for (let i = 0; i < width * height; i++) {
      const v = data[i];
      const [r, g, b, a] = (!isFinite(v) || v <= NODATA + 1) ? [0, 0, 0, 0] : duToRgba(v);
      img.data[i * 4]     = r; img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);

    if (_rasterLayer) _map.removeLayer(_rasterLayer);
    _rasterLayer = L.imageOverlay(
      canvas.toDataURL(),
      [[south, west], [north, east]],
      { opacity: 0.8, interactive: false, zIndex: 600 }
    ).addTo(_map);

    _map.fitBounds([[south, west], [north, east]], { padding: [30, 30] });
  }

  // ── Exportar polígono como GeoJSON ────────────────────────────────────────
  function exportPolygon(ring, dateStr, volcanoName, metrics) {
    const feature = {
      type: "Feature",
      properties: {
        date:      dateStr,
        volcano:   volcanoName,
        so2_tons:  +metrics.so2_tons.toFixed(2),
        max_du:    +metrics.max_du.toFixed(3),
        plume_km2: +metrics.plume_km2.toFixed(1),
        source:    "browser_masa_tab",
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
    const blob = new Blob([JSON.stringify(feature, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), {
      href:     URL.createObjectURL(blob),
      download: `pluma_${dateStr.replace(/-/g, "")}_${volcanoName.replace(/\s+/g, "_")}.geojson`,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ── Mostrar resultados ────────────────────────────────────────────────────
  function showResults(metrics, dateStr, volcanoName) {
    _lastResult = { metrics, dateStr, volcanoName };
    el("masaTons").textContent   = metrics.so2_tons > 0 ? metrics.so2_tons.toFixed(1) : "0";
    el("masaMaxDu").textContent  = metrics.max_du.toFixed(2);
    el("masaKm2").textContent    = metrics.plume_km2.toFixed(0);
    el("masaPixels").textContent = metrics.plume_pixels.toLocaleString("es");
    el("masaResults").style.display = "";
  }

  // ── Cálculo (diferido un frame para que el browser pinte el status) ───────
  function runCalculation() {
    if (!_raster || !_drawnRing) return;
    setStatus("Calculando…");
    setTimeout(() => {
      try {
        const volcSel     = el("masaVolcanoSelect");
        const volcanoName = volcSel?.options[volcSel.selectedIndex]?.text || "";
        const dateStr     = el("masaDateInput")?.value || "";

        const t0 = performance.now();
        const m  = calculateMass(_raster, _drawnRing);
        const ms = (performance.now() - t0).toFixed(0);

        showResults(m, dateStr, volcanoName);

        if (m.plume_pixels === 0)
          setStatus("Sin píxeles SO₂ > 0 dentro del polígono.", true);
        else
          setStatus(`✓ ${m.plume_pixels.toLocaleString("es")} px en ${ms} ms · ${m.so2_tons.toFixed(1)} t SO₂`);
      } catch (err) {
        setStatus("Error al calcular: " + err.message, true);
        console.error(err);
      }
    }, 30);
  }

  // ── Leaflet.draw ──────────────────────────────────────────────────────────
  function setupDraw() {
    if (_drawnItems) return;

    _drawnItems = new L.FeatureGroup();
    _map.addLayer(_drawnItems);

    _drawHandler = new L.Draw.Polygon(_map, {
      allowIntersection: false,
      shapeOptions: { color: "#e6a032", weight: 2, fillOpacity: 0.1 },
    });

    _map.on(L.Draw.Event.CREATED, (e) => {
      if (e.layerType !== "polygon") return;
      _drawnItems.clearLayers();
      _drawnItems.addLayer(e.layer);

      const lls = e.layer.getLatLngs()[0];
      _drawnRing = lls.map(ll => [ll.lng, ll.lat]);
      // Cerrar el anillo si no lo está
      const [f, l] = [_drawnRing[0], _drawnRing[_drawnRing.length - 1]];
      if (f[0] !== l[0] || f[1] !== l[1]) _drawnRing.push([...f]);

      el("masaDrawBtn").textContent = "Redibujar";
      runCalculation();
    });
  }

  function activateDraw() {
    if (!_drawHandler) { setStatus("Carga primero un raster.", true); return; }
    _drawnItems.clearLayers();
    _drawnRing = null;
    el("masaResults").style.display = "none";
    _drawHandler.enable();
    setStatus("Clic en el mapa para trazar · Doble clic para cerrar el polígono.");
  }

  // ── Limpiar todo ──────────────────────────────────────────────────────────
  function clearAll() {
    if (_drawnItems)  _drawnItems.clearLayers();
    if (_rasterLayer) { _map.removeLayer(_rasterLayer); _rasterLayer = null; }
    if (_drawHandler) _drawHandler.disable();
    _raster = _drawnRing = _lastResult = null;

    el("masaResults").style.display  = "none";
    el("masaDrawBtn").disabled       = true;
    el("masaDrawBtn").textContent    = "Dibujar polígono";
    el("masaClearBtn").style.display = "none";
    setStatus("Selecciona fecha y carga el raster L2.");
  }

  // ── Cargar raster ─────────────────────────────────────────────────────────
  async function loadRaster() {
    const dateVal = el("masaDateInput")?.value;
    if (!dateVal) { setStatus("Selecciona una fecha.", true); return; }

    if (typeof GeoTIFF === "undefined") {
      setStatus("Librería GeoTIFF.js no cargada (revisa la consola).", true); return;
    }

    const flat = dateVal.replace(/-/g, "");
    const url  = `data/qgis/so2_l2_${flat}.tif`;

    el("masaLoadRasterBtn").disabled = true;
    setStatus(`Cargando ${url}…`);

    try {
      const tiff    = await GeoTIFF.fromUrl(url);
      const image   = await tiff.getImage();
      const [data]  = await image.readRasters();     // Float32Array, 1 banda = DU
      const bbox    = image.getBoundingBox();         // [west, south, east, north]

      _raster = { data, bbox, width: image.getWidth(), height: image.getHeight() };

      renderRasterOverlay(_raster);
      setupDraw();

      el("masaDrawBtn").disabled       = false;
      el("masaClearBtn").style.display = "";
      setStatus(`Raster ${_raster.width}×${_raster.height} px · Dibuja el polígono sobre la pluma.`);
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
      console.error(err);
    } finally {
      el("masaLoadRasterBtn").disabled = false;
    }
  }

  // ── Inicialización ────────────────────────────────────────────────────────
  function init(map, getVolcanoList, dateInputEl) {
    _map = map;

    // Poblar selector de volcanes
    const volcSel = el("masaVolcanoSelect");
    if (volcSel) {
      const list = getVolcanoList();
      if (list.length) {
        volcSel.innerHTML = `<option value="">Selecciona un volcán…</option>`;
        [...list]
          .sort((a, b) => a.name.localeCompare(b.name, "es"))
          .forEach(v => {
            const o = document.createElement("option");
            o.value = v.name; o.textContent = v.name;
            volcSel.appendChild(o);
          });
      }
    }

    // Sincronizar fecha con el topbar
    const masaDate = el("masaDateInput");
    if (masaDate && dateInputEl) {
      masaDate.value = dateInputEl.value;
      dateInputEl.addEventListener("change", () => { masaDate.value = dateInputEl.value; });
    }

    // Navegación de fecha propia
    function shiftMasaDate(days) {
      if (!masaDate?.value) return;
      const d = new Date(masaDate.value + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + days);
      masaDate.value = d.toISOString().slice(0, 10);
    }
    el("masaPrevBtn")?.addEventListener("click", () => shiftMasaDate(-1));
    el("masaNextBtn")?.addEventListener("click", () => shiftMasaDate(+1));

    // Botones principales
    el("masaLoadRasterBtn")?.addEventListener("click", loadRaster);
    el("masaDrawBtn")?.addEventListener("click", activateDraw);
    el("masaClearBtn")?.addEventListener("click", clearAll);

    // Exportar
    el("masaExportBtn")?.addEventListener("click", () => {
      if (!_drawnRing || !_lastResult)
        { setStatus("No hay polígono calculado para exportar.", true); return; }
      const { metrics, dateStr, volcanoName } = _lastResult;
      exportPolygon(_drawnRing, dateStr, volcanoName, metrics);
    });

    setStatus("Selecciona fecha y carga el raster L2.");
  }

  window.MasaTab = { init };
})();
