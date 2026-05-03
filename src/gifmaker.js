/**
 * gifmaker.js
 * Genera GIFs animados de SO2 directamente en el browser.
 * Descarga tiles WMS de EOC (CORS nativo) y los renderiza frame por frame.
 */
(function (global) {

  const GIF_JS_URL    = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js";
  const GIF_WORKER_URL = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js";

  // ── Cargar gif.js dinámicamente ─────────────────────────────────────────
  function loadGifJs() {
    return new Promise((resolve, reject) => {
      if (window.GIF) { resolve(window.GIF); return; }
      const s = document.createElement("script");
      s.src = GIF_JS_URL;
      s.onload = () => resolve(window.GIF);
      s.onerror = () => reject(new Error("No se pudo cargar gif.js"));
      document.head.appendChild(s);
    });
  }

  // ── Descargar imagen WMS como HTMLImageElement ──────────────────────────
  function fetchWmsFrame(wmsUrl, dateStr, bbox, sizePx) {
    const [west, south, east, north] = bbox;
    const params = new URLSearchParams({
      SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetMap",
      LAYERS: "S5P_SO2_NRTI_L3", STYLES: "",
      CRS: "EPSG:4326",
      BBOX: `${south},${west},${north},${east}`,
      WIDTH: sizePx, HEIGHT: sizePx,
      FORMAT: "image/png", TRANSPARENT: "true",
      TIME: dateStr + "T05:00:00Z"
    });
    const url = wmsUrl + "?" + params.toString();

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error("WMS sin datos para " + dateStr));
      img.src = url;
    });
  }

  // ── Dibujar frame en canvas ─────────────────────────────────────────────
  function drawFrame(ctx, sizePx, wmsImg, overlayCanvas, dateStr) {
    // Fondo blanco
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sizePx, sizePx);

    // Imagen WMS
    if (wmsImg instanceof HTMLImageElement && wmsImg.complete && wmsImg.naturalWidth > 0) {
      ctx.drawImage(wmsImg, 0, 0, sizePx, sizePx);
    } else {
      ctx.fillStyle = "#e8e8e8";
      ctx.fillRect(0, 0, sizePx, sizePx);
      ctx.fillStyle = "#999";
      ctx.font = `${Math.round(sizePx * 0.04)}px Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("Sin datos disponibles", sizePx / 2, sizePx / 2);
      ctx.textAlign = "left";
    }

    // Overlays pre-renderizados
    if (overlayCanvas) {
      ctx.drawImage(overlayCanvas, 0, 0, sizePx, sizePx);
    }

    // Etiqueta de fecha
    const pad      = Math.round(sizePx * 0.02);
    const fontSize = Math.round(sizePx * 0.045);
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    const tw = ctx.measureText(dateStr).width;
    const th = fontSize;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(pad - 4, sizePx - pad - th - 4, tw + 8, th + 8);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(dateStr, pad, sizePx - pad);
  }

  // ── Dibujar overlay estático (borde Chile + volcanes) ──────────────────
  function buildOverlayCanvas(sizePx, bbox, volcanoes, borderGeoJson) {
    const [west, south, east, north] = bbox;
    const rangeX = east  - west;
    const rangeY = north - south;

    function geo2c(lon, lat) {
      return [
        ((lon - west)  / rangeX) * sizePx,
        ((north - lat) / rangeY) * sizePx
      ];
    }

    const canvas = document.createElement("canvas");
    canvas.width  = sizePx;
    canvas.height = sizePx;
    const ctx = canvas.getContext("2d");

    // Borde de Chile
    if (borderGeoJson) {
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.lineWidth   = Math.max(1, sizePx / 300);
      for (const feat of (borderGeoJson.features || [])) {
        drawGeoJsonFeature(ctx, feat, geo2c);
      }
    }

    // Triángulos volcanes
    if (volcanoes && volcanoes.length) {
      const ts = Math.max(6, Math.round(sizePx / 60));
      for (const v of volcanoes) {
        const [cx, cy] = geo2c(v.lon, v.lat);
        if (cx < -ts || cx > sizePx + ts || cy < -ts || cy > sizePx + ts) continue;
        ctx.beginPath();
        ctx.moveTo(cx, cy - ts);
        ctx.lineTo(cx - ts, cy + ts);
        ctx.lineTo(cx + ts, cy + ts);
        ctx.closePath();
        ctx.fillStyle   = "rgba(0,0,0,0.85)";
        ctx.fill();
        ctx.strokeStyle = "rgba(220,50,50,1)";
        ctx.lineWidth   = Math.max(1, ts / 5);
        ctx.stroke();
      }
    }

    return canvas;
  }

  function drawGeoJsonFeature(ctx, feat, geo2c) {
    const geom = feat.geometry;
    if (!geom) return;
    const drawRing = (ring) => {
      if (!ring.length) return;
      ctx.beginPath();
      ring.forEach(([lon, lat], i) => {
        const [x, y] = geo2c(lon, lat);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    };
    if      (geom.type === "Polygon")      geom.coordinates.forEach(drawRing);
    else if (geom.type === "MultiPolygon") geom.coordinates.forEach(p => p.forEach(drawRing));
    else if (geom.type === "LineString")   drawRing(geom.coordinates);
    else if (geom.type === "MultiLineString") geom.coordinates.forEach(drawRing);
  }

  // ── Generar GIF ─────────────────────────────────────────────────────────
  async function generate({ wmsUrl, dates, bbox, sizePx, fps, volcanoes, borderGeoJson, onProgress }) {
    const GIF = await loadGifJs();

    onProgress("Preparando overlays…", 0);
    const overlayCanvas = buildOverlayCanvas(sizePx, bbox, volcanoes, borderGeoJson);

    // Canvas de trabajo
    const canvas = document.createElement("canvas");
    canvas.width  = sizePx;
    canvas.height = sizePx;
    const ctx = canvas.getContext("2d");

    const gif = new GIF({
      workers:      2,
      quality:      8,
      width:        sizePx,
      height:       sizePx,
      workerScript: GIF_WORKER_URL,
      background:   "#ffffff"
    });

    const delayMs     = Math.round(1000 / fps);
    let   successFrames = 0;

    // Descargar frames de a 3 en paralelo para no sobrecargar
    for (let i = 0; i < dates.length; i++) {
      const dateStr = dates[i];
      onProgress(`Descargando frame ${i + 1}/${dates.length}: ${dateStr}…`, Math.round((i / dates.length) * 80));

      let wmsImg = null;
      try {
        wmsImg = await fetchWmsFrame(wmsUrl, dateStr, bbox, sizePx);
        successFrames++;
      } catch (e) {
        console.warn("Frame sin datos:", dateStr, e.message);
      }

      drawFrame(ctx, sizePx, wmsImg, overlayCanvas, dateStr);
      gif.addFrame(canvas, { copy: true, delay: delayMs });
    }

    if (successFrames === 0) throw new Error("No se pudo obtener ningún frame del WMS.");

    onProgress("Codificando GIF…", 85);

    return new Promise((resolve, reject) => {
      gif.on("progress", p => onProgress("Codificando… " + Math.round(p * 100) + "%", 85 + Math.round(p * 14)));
      gif.on("finished", blob => { onProgress("¡GIF listo!", 100); resolve(blob); });
      gif.on("error",    e    => reject(new Error("Error codificando GIF: " + e)));
      gif.render();
    });
  }

  global.SO2GifMaker = { generate };

})(window);
