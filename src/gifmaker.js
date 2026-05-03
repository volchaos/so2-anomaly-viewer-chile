/**
 * gifmaker.js
 * Genera GIFs animados de SO2 directamente en el browser.
 * Descarga tiles WMS de EOC (CORS nativo) y los renderiza frame por frame.
 * Usa gif.js para la codificación del GIF.
 */
(function (global) {

  const GIF_JS_URL = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js";
  const GIF_WORKER_URL = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js";

  // ── Cargar gif.js dinámicamente ─────────────────────────────────────────
  function loadGifJs() {
    return new Promise((resolve, reject) => {
      if (window.GIF) { resolve(window.GIF); return; }
      const s = document.createElement("script");
      s.src = GIF_JS_URL;
      s.onload = () => resolve(window.GIF);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ── Descargar imagen WMS como ImageBitmap ───────────────────────────────
  async function fetchWmsFrame(wmsUrl, dateStr, bbox, sizePx) {
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
    const resp = await fetch(url, { mode: "cors" });
    if (!resp.ok) throw new Error("WMS error " + resp.status + " for " + dateStr);
    const blob = await resp.blob();
    return createImageBitmap(blob);
  }

  // ── Cargar imagen desde URL como ImageBitmap ───────────────────────────
  async function loadImage(url) {
    const resp = await fetch(url, { cache: "force-cache" });
    const blob = await resp.blob();
    return createImageBitmap(blob);
  }

  // ── Dibujar frame en canvas ─────────────────────────────────────────────
  function drawFrame(ctx, sizePx, wmsFrame, overlayCanvas, dateStr) {
    // Fondo blanco
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sizePx, sizePx);

    // Imagen WMS (solo si existe)
    if (wmsFrame) {
      ctx.drawImage(wmsFrame, 0, 0, sizePx, sizePx);
    } else {
      // Frame vacío — fondo gris claro con mensaje
      ctx.fillStyle = "#e8e8e8";
      ctx.fillRect(0, 0, sizePx, sizePx);
      ctx.fillStyle = "#888";
      ctx.font = `${Math.round(sizePx * 0.035)}px Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("Sin datos", sizePx / 2, sizePx / 2);
      ctx.textAlign = "left";
    }

    // Overlays (límite Chile, volcanes) desde canvas pre-renderizado
    if (overlayCanvas) {
      ctx.drawImage(overlayCanvas, 0, 0, sizePx, sizePx);
    }

    // Fecha en esquina inferior izquierda
    const pad = Math.round(sizePx * 0.02);
    const fontSize = Math.round(sizePx * 0.045);
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    const text = dateStr;
    const tw = ctx.measureText(text).width;
    const th = fontSize;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(pad - 4, sizePx - pad - th - 4, tw + 8, th + 8);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, pad, sizePx - pad);
  }

  // ── Dibujar overlay (Chile border + volcanes) en canvas separado ────────
  async function buildOverlayCanvas(sizePx, bbox, volcanoes, borderGeoJson, cfg) {
    const [west, south, east, north] = bbox;
    const rangeX = east - west;
    const rangeY = north - south;

    function geoToCanvas(lon, lat) {
      return [
        ((lon - west) / rangeX) * sizePx,
        ((north - lat) / rangeY) * sizePx
      ];
    }

    const canvas = document.createElement("canvas");
    canvas.width = sizePx;
    canvas.height = sizePx;
    const ctx = canvas.getContext("2d");

    // Dibujar límite de Chile
    if (borderGeoJson) {
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.lineWidth = Math.max(1, sizePx / 256);
      ctx.setLineDash([]);
      const features = borderGeoJson.features || [];
      for (const feat of features) {
        drawGeoJsonFeature(ctx, feat, geoToCanvas);
      }
    }

    // Dibujar volcanes OVDAS
    if (volcanoes && volcanoes.length) {
      const triSize = Math.max(6, sizePx / 64);
      for (const v of volcanoes) {
        const [cx, cy] = geoToCanvas(v.lon, v.lat);
        if (cx < -triSize || cx > sizePx + triSize || cy < -triSize || cy > sizePx + triSize) continue;
        drawTriangle(ctx, cx, cy, triSize);
      }
    }

    return canvas;
  }

  function drawGeoJsonFeature(ctx, feat, geoToCanvas) {
    const geom = feat.geometry;
    if (!geom) return;
    const drawRing = (ring) => {
      ctx.beginPath();
      ring.forEach(([lon, lat], i) => {
        const [x, y] = geoToCanvas(lon, lat);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    };
    if (geom.type === "Polygon") geom.coordinates.forEach(drawRing);
    else if (geom.type === "MultiPolygon") geom.coordinates.forEach(poly => poly.forEach(drawRing));
    else if (geom.type === "LineString") drawRing(geom.coordinates);
    else if (geom.type === "MultiLineString") geom.coordinates.forEach(drawRing);
  }

  function drawTriangle(ctx, cx, cy, size) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - size);
    ctx.lineTo(cx - size, cy + size);
    ctx.lineTo(cx + size, cy + size);
    ctx.closePath();
    ctx.fillStyle = "rgba(0,0,0,0.9)";
    ctx.fill();
    ctx.strokeStyle = "rgba(220,50,50,1)";
    ctx.lineWidth = Math.max(1, size / 5);
    ctx.stroke();
  }

  // ── Generar GIF ────────────────────────────────────────────────────────
  async function generate({ wmsUrl, dates, bbox, sizePx, fps, volcanoes, borderGeoJson, cfg, onProgress }) {
    const GIF = await loadGifJs();

    onProgress("Preparando overlays…", 0);

    // Canvas de overlay (estático, se reutiliza en todos los frames)
    const overlayCanvas = await buildOverlayCanvas(sizePx, bbox, volcanoes, borderGeoJson, cfg);

    // Canvas de trabajo
    const canvas = document.createElement("canvas");
    canvas.width = sizePx;
    canvas.height = sizePx;
    const ctx = canvas.getContext("2d");

    const gif = new GIF({
      workers: 2,
      quality: 8,
      width: sizePx,
      height: sizePx,
      workerScript: GIF_WORKER_URL,
      background: "#ffffff"
    });

    const delayMs = Math.round(1000 / fps);
    let successFrames = 0;

    for (let i = 0; i < dates.length; i++) {
      const dateStr = dates[i];
      onProgress(`Descargando frame ${i + 1}/${dates.length}: ${dateStr}…`, Math.round((i / dates.length) * 80));

      try {
        const wmsFrame = await fetchWmsFrame(wmsUrl, dateStr, bbox, sizePx);
        drawFrame(ctx, sizePx, wmsFrame, overlayCanvas, dateStr);
        gif.addFrame(canvas, { copy: true, delay: delayMs });
        successFrames++;
      } catch (e) {
        console.warn("Frame fallido:", dateStr, e.message);
        // Frame vacío con solo la fecha
        ctx.fillStyle = "#f0f0f0";
        ctx.fillRect(0, 0, sizePx, sizePx);
        drawFrame(ctx, sizePx, null, overlayCanvas, dateStr + " (sin datos)");
        gif.addFrame(canvas, { copy: true, delay: delayMs });
      }
    }

    if (successFrames === 0) throw new Error("No se pudo descargar ningún frame.");

    onProgress("Codificando GIF…", 85);

    return new Promise((resolve, reject) => {
      gif.on("progress", p => onProgress("Codificando GIF… " + Math.round(p * 100) + "%", 85 + Math.round(p * 14)));
      gif.on("finished", blob => { onProgress("¡GIF listo!", 100); resolve(blob); });
      gif.on("error", reject);
      gif.render();
    });
  }

  global.SO2GifMaker = { generate };

})(window);
