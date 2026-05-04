/**
 * gifmaker.js - Genera GIFs animados de SO2 directamente en el browser.
 * Sin dependencias externas. GIF encoder puro en JavaScript.
 * Descarga tiles WMS de EOC (CORS nativo) frame por frame.
 */
(function (global) {

  // ── GIF Encoder puro JS (sin Workers, sin CDN) ─────────────────────────
  // Basado en el algoritmo LZW estándar para GIF89a

  function GIFEncoder(width, height) {
    this.width    = width;
    this.height   = height;
    this.frames   = [];
    this.delay    = 500; // ms por frame
    this.repeat   = 0;   // 0 = loop infinito
    this.quality  = 10;
  }

  GIFEncoder.prototype.setDelay    = function(ms) { this.delay = ms; };
  GIFEncoder.prototype.setRepeat   = function(r)  { this.repeat = r; };
  GIFEncoder.prototype.setQuality  = function(q)  { this.quality = q; };

  GIFEncoder.prototype.addFrame = function(canvas) {
    const ctx  = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, this.width, this.height);
    this.frames.push({ data: data.data, delay: this.delay });
  };

  GIFEncoder.prototype.finish = function() {
    const frames  = this.frames;
    const w       = this.width;
    const h       = this.height;
    const repeat  = this.repeat;

    // Cuantizar paleta global con todos los frames
    const palette = buildPalette(frames, w, h, this.quality);
    const parts   = [];

    // Header
    parts.push(str("GIF89a"));
    parts.push(word(w), word(h));
    parts.push(byte_(0xF7)); // GCT flag + color depth - 1 (256 colors)
    parts.push(byte_(0));    // background index
    parts.push(byte_(0));    // pixel aspect ratio
    // Global Color Table (256 colores x 3 bytes)
    for (let i = 0; i < 256; i++) {
      const p = palette[i] || [0, 0, 0];
      parts.push(byte_(p[0]), byte_(p[1]), byte_(p[2]));
    }

    // Netscape Application Extension (loop)
    parts.push(byte_(0x21), byte_(0xFF), byte_(11));
    parts.push(str("NETSCAPE2.0"));
    parts.push(byte_(3), byte_(1));
    parts.push(word(repeat));
    parts.push(byte_(0));

    for (let f = 0; f < frames.length; f++) {
      const frame  = frames[f];
      const delayCs = Math.round(frame.delay / 10); // centiseconds

      // Graphic Control Extension
      parts.push(byte_(0x21), byte_(0xF9), byte_(4));
      parts.push(byte_(0));          // disposal
      parts.push(word(delayCs));
      parts.push(byte_(0), byte_(0));

      // Image Descriptor
      parts.push(byte_(0x2C));
      parts.push(word(0), word(0), word(w), word(h));
      parts.push(byte_(0)); // no local color table

      // Image Data
      const indices = quantizeFrame(frame.data, palette, w, h);
      const lzw     = lzwEncode(indices, 8);
      parts.push(byte_(8)); // LZW min code size
      // Sub-blocks
      let pos = 0;
      while (pos < lzw.length) {
        const blockSize = Math.min(255, lzw.length - pos);
        parts.push(byte_(blockSize));
        parts.push(new Uint8Array(lzw.buffer, pos, blockSize));
        pos += blockSize;
      }
      parts.push(byte_(0)); // block terminator
    }

    parts.push(byte_(0x3B)); // GIF trailer

    // Concatenar todo en un Uint8Array
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return new Blob([out], { type: "image/gif" });
  };

  // ── Helpers de serialización ───────────────────────────────────────────
  function str(s) {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function byte_(n) { return new Uint8Array([n & 0xFF]); }
  function word(n)  { return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF]); }

  // ── Cuantización de paleta (mediana-corte simplificada) ────────────────
  function buildPalette(frames, w, h, quality) {
    // Muestrea píxeles de todos los frames
    const step    = Math.max(1, quality);
    const samples = [];
    for (const frame of frames) {
      const d = frame.data;
      for (let i = 0; i < d.length; i += 4 * step) {
        samples.push([d[i], d[i+1], d[i+2]]);
      }
    }

    // k-means con k=256
    let palette = [];
    // Inicializar con colores uniformes
    for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
      palette.push([Math.round(r * 51), Math.round(g * 51), Math.round(b * 51)]);
    }
    // Completar hasta 256
    while (palette.length < 256) palette.push([0, 0, 0]);
    palette = palette.slice(0, 256);

    // 3 iteraciones de k-means
    for (let iter = 0; iter < 3; iter++) {
      const sums   = Array.from({ length: 256 }, () => [0, 0, 0, 0]);
      for (const [r, g, b] of samples) {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < 256; i++) {
          const p = palette[i];
          const d = (r-p[0])**2 + (g-p[1])**2 + (b-p[2])**2;
          if (d < bestD) { bestD = d; best = i; }
        }
        sums[best][0] += r; sums[best][1] += g; sums[best][2] += b; sums[best][3]++;
      }
      for (let i = 0; i < 256; i++) {
        if (sums[i][3] > 0) {
          palette[i] = [
            Math.round(sums[i][0] / sums[i][3]),
            Math.round(sums[i][1] / sums[i][3]),
            Math.round(sums[i][2] / sums[i][3])
          ];
        }
      }
    }
    return palette;
  }

  function quantizeFrame(data, palette, w, h) {
    const indices = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
      let best = 0, bestD = Infinity;
      for (let j = 0; j < 256; j++) {
        const p = palette[j];
        const d = (r-p[0])**2 + (g-p[1])**2 + (b-p[2])**2;
        if (d < bestD) { bestD = d; best = j; }
      }
      indices[i] = best;
    }
    return indices;
  }

  // ── LZW Encoder ────────────────────────────────────────────────────────
  function lzwEncode(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eofCode   = clearCode + 1;
    let codeSize    = minCodeSize + 1;
    let nextCode    = eofCode + 1;

    const output  = [];
    let   bitBuf  = 0, bitLen = 0;

    function emit(code) {
      bitBuf |= code << bitLen;
      bitLen += codeSize;
      while (bitLen >= 8) { output.push(bitBuf & 0xFF); bitBuf >>= 8; bitLen -= 8; }
    }

    let table = new Map();
    function resetTable() {
      table.clear();
      for (let i = 0; i < clearCode; i++) table.set(String(i), i);
      codeSize = minCodeSize + 1;
      nextCode = eofCode + 1;
    }

    resetTable();
    emit(clearCode);

    let prefix = "";
    for (let i = 0; i < indices.length; i++) {
      const k      = String(indices[i]);
      const chain  = prefix ? prefix + "," + k : k;
      if (table.has(chain)) {
        prefix = chain;
      } else {
        emit(table.get(prefix !== "" ? prefix : k));
        if (nextCode < 4096) {
          table.set(chain, nextCode++);
          if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
        } else {
          emit(clearCode);
          resetTable();
        }
        prefix = k;
      }
    }
    if (prefix !== "") emit(table.get(prefix));
    emit(eofCode);
    if (bitLen > 0) output.push(bitBuf & 0xFF);

    return new Uint8Array(output);
  }

  // ── Descargar frame WMS ────────────────────────────────────────────────
  function fetchWmsFrame(wmsUrl, wmsLayers, wmsStyles, wmsVersion, timeFormat, dateStr, bbox, sizePx) {
    const [west, south, east, north] = bbox;
    const timeParam = (timeFormat === "date") ? dateStr : dateStr + "T05:00:00Z";
    const params = new URLSearchParams({
      SERVICE: "WMS", VERSION: wmsVersion || "1.3.0", REQUEST: "GetMap",
      LAYERS: wmsLayers, STYLES: wmsStyles || "",
      CRS: "EPSG:4326",
      BBOX: `${south},${west},${north},${east}`,
      WIDTH: sizePx, HEIGHT: sizePx,
      FORMAT: "image/png", TRANSPARENT: "true",
      TIME: timeParam
    });

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (img.naturalWidth < 2 || img.naturalHeight < 2) {
          reject(new Error("Frame vacío: " + dateStr)); return;
        }
        resolve(img);
      };
      img.onerror = () => reject(new Error("WMS error: " + dateStr));
      img.src = wmsUrl + "?" + params.toString();
    });
  }

  // ── Overlay estático (borde + volcanes) ────────────────────────────────
  function buildOverlayCanvas(sizePx, bbox, volcanoes, selectedVolcano, borderGeoJson) {
    const [west, south, east, north] = bbox;
    const rx = east - west, ry = north - south;
    const g2c = (lon, lat) => [((lon-west)/rx)*sizePx, ((north-lat)/ry)*sizePx];

    const cv  = document.createElement("canvas");
    cv.width  = sizePx; cv.height = sizePx;
    const ctx = cv.getContext("2d");

    if (borderGeoJson) {
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.lineWidth   = Math.max(1, sizePx/300);
      for (const f of (borderGeoJson.features||[])) {
        const geom = f.geometry;
        if (!geom) continue;
        const rings = geom.type === "Polygon" ? geom.coordinates :
                      geom.type === "MultiPolygon" ? geom.coordinates.flat() : [];
        for (const ring of rings) {
          ctx.beginPath();
          ring.forEach(([lo,la],i) => { const [x,y]=g2c(lo,la); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
          ctx.closePath(); ctx.stroke();
        }
      }
    }

    if (volcanoes && volcanoes.length) {
      for (const v of volcanoes) {
        const [cx, cy] = g2c(v.lon, v.lat);
        const isSelected = v.name === selectedVolcano;
        // Volcán seleccionado: grande; otros: pequeños y semitransparentes
        const ts = isSelected
          ? Math.max(8, Math.round(sizePx / 38))
          : Math.max(4, Math.round(sizePx / 70));
        if (cx < -ts*2 || cx > sizePx+ts*2 || cy < -ts*2 || cy > sizePx+ts*2) continue;

        ctx.globalAlpha = isSelected ? 1.0 : 0.55;

        // Cuerpo
        ctx.beginPath();
        ctx.moveTo(cx, cy - ts);
        ctx.lineTo(cx - ts, cy + ts);
        ctx.lineTo(cx + ts, cy + ts);
        ctx.closePath();
        ctx.fillStyle = "#4a5568";
        ctx.fill();
        ctx.strokeStyle = "#1a202c";
        ctx.lineWidth = Math.max(0.5, ts / 12);
        ctx.stroke();

        // Nieve
        ctx.beginPath();
        ctx.moveTo(cx, cy - ts);
        ctx.lineTo(cx - ts * 0.48, cy - ts + ts * 0.76);
        ctx.quadraticCurveTo(cx, cy - ts + ts * 0.56, cx + ts * 0.48, cy - ts + ts * 0.76);
        ctx.closePath();
        ctx.fillStyle = "#e8eaf0";
        ctx.fill();
        ctx.strokeStyle = "#9aa5b4";
        ctx.lineWidth = Math.max(0.3, ts / 20);
        ctx.stroke();

        // Etiqueta
        if (v.name) {
          const fs = isSelected
            ? Math.max(9, Math.round(sizePx / 36))
            : Math.max(6, Math.round(sizePx / 60));
          ctx.font = `bold ${fs}px Arial, sans-serif`;
          ctx.textAlign = "center";
          ctx.lineWidth = Math.max(1.5, fs / 5);
          ctx.strokeStyle = "rgba(0,0,0,0.85)";
          ctx.lineJoin = "round";
          ctx.strokeText(v.name, cx, cy - ts - 3);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(v.name, cx, cy - ts - 3);
          ctx.textAlign = "left";
        }

        ctx.globalAlpha = 1.0;
      }
    }
    return cv;
  }

  // ── Dibujar frame ──────────────────────────────────────────────────────
  function drawFrame(ctx, sizePx, wmsImg, overlayCanvas, dateStr) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sizePx, sizePx);

    if (wmsImg instanceof HTMLImageElement && wmsImg.complete && wmsImg.naturalWidth > 1) {
      ctx.drawImage(wmsImg, 0, 0, sizePx, sizePx);
    } else {
      ctx.fillStyle = "#e0e0e0";
      ctx.fillRect(0, 0, sizePx, sizePx);
      ctx.fillStyle = "#999";
      ctx.font = `${Math.round(sizePx*0.04)}px Arial`;
      ctx.textAlign = "center";
      ctx.fillText("Sin datos", sizePx/2, sizePx/2);
      ctx.textAlign = "left";
    }

    if (overlayCanvas) ctx.drawImage(overlayCanvas, 0, 0, sizePx, sizePx);

    // ── Leyenda SO₂ (esquina inferior derecha) ──────────────────────────
    const pad    = Math.round(sizePx * 0.02);
    const fs     = Math.round(sizePx * 0.038);
    const barW   = Math.round(sizePx * 0.028);
    const barH   = Math.round(sizePx * 0.28);
    const lx     = sizePx - pad - barW - Math.round(fs * 2.8); // x inicio barra
    const ly     = sizePx - pad - barH;                        // y inicio barra

    // Fondo semitransparente
    const bgPad = Math.round(sizePx * 0.012);
    const titleH = Math.round(fs * 1.4);
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.fillRect(lx - bgPad, ly - titleH - bgPad, barW + Math.round(fs * 3.2), barH + titleH + bgPad * 2);

    // Título
    ctx.font = `bold ${Math.round(fs * 0.75)}px Arial`;
    ctx.fillStyle = "#111";
    ctx.textAlign = "left";
    ctx.fillText("SO\u2082 (DU)", lx - bgPad + Math.round(bgPad * 0.5), ly - Math.round(bgPad * 0.5));

    // Barra de colores — gradiente espectral TROPOMI
    const grad = ctx.createLinearGradient(0, ly, 0, ly + barH);
    grad.addColorStop(0.00, "#c00000");
    grad.addColorStop(0.08, "#e83020");
    grad.addColorStop(0.18, "#e87820");
    grad.addColorStop(0.28, "#e8c000");
    grad.addColorStop(0.38, "#c8e040");
    grad.addColorStop(0.50, "#40c878");
    grad.addColorStop(0.62, "#40a0d8");
    grad.addColorStop(0.72, "#8080c8");
    grad.addColorStop(0.82, "#c8a0d0");
    grad.addColorStop(0.92, "#e8d5e8");
    grad.addColorStop(1.00, "#ffffff");
    ctx.fillStyle = grad;
    ctx.fillRect(lx, ly, barW, barH);
    ctx.strokeStyle = "#888";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(lx, ly, barW, barH);

    // Ticks y etiquetas
    const ticks = [
      { pct: 0,    label: "10"  },
      { pct: 0.38, label: "3.3" },
      { pct: 0.62, label: "1.1" },
      { pct: 0.80, label: "0.3" },
      { pct: 0.92, label: "0.1" },
      { pct: 1,    label: "0"   },
    ];
    ctx.font = `${Math.round(fs * 0.85)}px Arial`;
    ctx.fillStyle = "#111";
    ctx.textAlign = "left";
    for (const t of ticks) {
      const ty = ly + t.pct * barH;
      ctx.strokeStyle = "#555";
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(lx + barW, ty);
      ctx.lineTo(lx + barW + Math.round(fs * 0.4), ty);
      ctx.stroke();
      ctx.fillText(t.label, lx + barW + Math.round(fs * 0.55), ty + Math.round(fs * 0.35));
    }

    // ── Etiqueta de fecha (esquina inferior izquierda) ──────────────────
    const datefs = Math.round(sizePx * 0.045);
    ctx.font  = `bold ${datefs}px Arial`;
    ctx.textAlign = "left";
    const tw  = ctx.measureText(dateStr).width;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(pad - 4, sizePx - pad - datefs - 4, tw + 8, datefs + 8);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(dateStr, pad, sizePx - pad);
  }

  // ── API pública ────────────────────────────────────────────────────────
  async function generate({ wmsUrl, wmsLayers, wmsStyles, wmsVersion, timeFormat,
                             dates, bbox, sizePx, fps, volcanoes, selectedVolcano, borderGeoJson, onProgress }) {
    onProgress("Preparando overlays…", 0);

    const overlayCanvas = buildOverlayCanvas(sizePx, bbox, volcanoes, selectedVolcano, borderGeoJson);
    const canvas = document.createElement("canvas");
    canvas.width = sizePx; canvas.height = sizePx;
    const ctx = canvas.getContext("2d");

    const encoder = new GIFEncoder(sizePx, sizePx);
    encoder.setDelay(Math.round(1000 / fps));
    encoder.setRepeat(0);
    encoder.setQuality(10);

    let successFrames = 0;

    for (let i = 0; i < dates.length; i++) {
      const dateStr = dates[i];
      onProgress(`Frame ${i+1}/${dates.length}: ${dateStr}…`, Math.round((i/dates.length)*80));

      let wmsImg = null;
      try {
        wmsImg = await fetchWmsFrame(wmsUrl, wmsLayers, wmsStyles, wmsVersion, timeFormat, dateStr, bbox, sizePx);
        successFrames++;
      } catch(e) {
        console.warn("Frame sin datos:", dateStr, e.message);
      }

      drawFrame(ctx, sizePx, wmsImg, overlayCanvas, dateStr);
      encoder.addFrame(canvas);
    }

    if (successFrames === 0) throw new Error("No se pudo obtener ningún frame del WMS.");

    onProgress("Codificando GIF…", 82);

    // Ejecutar en chunks para no bloquear el UI
    await new Promise(r => setTimeout(r, 50));
    const blob = encoder.finish();

    onProgress("¡GIF listo!", 100);
    return blob;
  }

  global.SO2GifMaker = { generate };

})(window);
