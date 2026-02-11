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
    // EOC daily composites are keyed to 05:00:00Z
    return `${dateStr}T05:00:00Z`;
  }

  const map = L.map("map", { worldCopyJump: true }).setView(
    cfg.map.center,
    cfg.map.zoom
  );

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
    // Spanish-style thousands separators: 250.000
    try {
      return `1:${Math.round(n).toLocaleString("es-CL")}`;
    } catch {
      return `1:${Math.round(n)}`;
    }
  }

  // Approx scale denominator at current view center
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
    // Other volcanoes = half the size of OVDAS
    const size = isOvdas ? 18 : 9;
    return L.marker(latlng, { icon: volcanoDivIcon(size, isOvdas) });
  }

  function smelterMarker(latlng) {
    return L.circleMarker(latlng, { radius: 6, weight: 2, fillOpacity: 0.9 });
  }

  function bindPopup(layer, props, fallbackTitle) {
    const name =
      (props && (props.name || props.Name || props.NOMBRE)) ||
      fallbackTitle ||
      "Sin nombre";
    const extra = [];
    if (props && props.type) extra.push(`Tipo: ${props.type}`);
    if (props && props.empresa) extra.push(`Empresa: ${props.empresa}`);
    const html = `<b>${name}</b>${extra.length ? `<br/>${extra.join("<br/>")}` : ""}`;
    layer.bindPopup(html);
  }

  function normalizeName(s) {
    if (!s) return "";
    return String(s)
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/^volcan\s+/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function fetchJson(url, label, cacheMode) {
    const r = await fetch(url, { cache: cacheMode || "no-store" });
    if (!r.ok) throw new Error(`No se pudo cargar ${label}: ${r.status}`);
    return await r.json();
  }

  async function loadGeoJson(url, pointToLayerFn, label) {
    const gj = await fetchJson(url, label, "no-store");
    return L.geoJSON(gj, {
      pointToLayer: (feature, latlng) => pointToLayerFn(feature, latlng),
      onEachFeature: (feature, lyr) => bindPopup(lyr, feature.properties, label)
    });
  }

  async function loadChileBorder() {
    const gj = await fetchJson(cfg.data.countriesUrl, "países", "force-cache");

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

  const layerControl = L.control.layers({}, {}, { collapsed: false }).addTo(map);

  // Layer refs for label control
  let volcanosOvdasLayer = null;
  let volcanosOtherLayer = null;
  let smeltersLayer = null;

  function bindLabel(layer, name, className, opts) {
    layer.bindTooltip(name, {
      permanent: true,
      opacity: 0.9,
      className,
      ...opts
    });
  }

  // --- Label thresholds by SCALE ---
  // Show labels when scale is "close enough" (denominator <= threshold)
  const SCALE_OVDAS_LABEL = 3500000; // 1:250.000
  const SCALE_OTHER_LABEL = 750000;  // 1:50.000
  const SCALE_SMELTER_LABEL = 750000; // 1:50.000

  function updateLabels() {
    const scale = currentScaleDenominator();

    const showOvdas = scale <= SCALE_OVDAS_LABEL;
    const showOther = scale <= SCALE_OTHER_LABEL;
    const showSmelter = scale <= SCALE_SMELTER_LABEL;

    if (volcanosOvdasLayer) {
      volcanosOvdasLayer.eachLayer(l => {
        if (!l.getTooltip()) return;
        if (showOvdas) l.openTooltip();
        else l.closeTooltip();
      });
    }

    if (volcanosOtherLayer) {
      volcanosOtherLayer.eachLayer(l => {
        if (!l.getTooltip()) return;
        if (showOther) l.openTooltip();
        else l.closeTooltip();
      });
    }

    if (smeltersLayer) {
      smeltersLayer.eachLayer(l => {
        if (!l.getTooltip()) return;
        if (showSmelter) l.openTooltip();
        else l.closeTooltip();
      });
    }
  }

  async function init() {
    try {
      dateInput.value = todayUtcDateString();
      addSo2Layer(dateInput.value);

      setStatus("Cargando capas…");

      // Border (best effort)
      try {
        const borderLayer = await loadChileBorder();
        borderLayer.addTo(map);
        layerControl.addOverlay(borderLayer, "Límite Chile");
      } catch (e) {
        console.warn("Chile border failed:", e);
      }

      // Load OVDAS set (names)
      const ovdasGJ = await fetchJson(cfg.data.volcanoesOvdas, "Volcanes OVDAS (44)", "no-store");
      const ovdasNameSet = new Set(
        (ovdasGJ.features || []).map(f =>
          normalizeName(f.properties && (f.properties.name || f.properties.Name || f.properties.NOMBRE))
        )
      );

      // Load ALL and split into OVDAS vs Other
      const allGJ = await fetchJson(cfg.data.volcanoesAll, "Volcanes (All)", "no-store");
      const ovdasFeatures = [];
      const otherFeatures = [];

      for (const f of (allGJ.features || [])) {
        const n = normalizeName(f.properties && (f.properties.name || f.properties.Name || f.properties.NOMBRE));
        if (ovdasNameSet.has(n)) ovdasFeatures.push(f);
        else otherFeatures.push(f);
      }

      const ovdasFC = { type: "FeatureCollection", features: ovdasFeatures };
      const otherFC = { type: "FeatureCollection", features: otherFeatures };

      volcanosOvdasLayer = L.geoJSON(ovdasFC, {
        pointToLayer: (feature, latlng) => volcanoMarker(latlng, true),
        onEachFeature: (feature, lyr) => {
          bindPopup(lyr, feature.properties, "Volcán");
          const p = feature.properties || {};
          const name = p.name || p.Name || p.NOMBRE || "Volcán";
          bindLabel(lyr, name, "label-volcano label-volcano-ovdas", {
            direction: "top",
            offset: [0, -12]
          });
        }
      });

      volcanosOtherLayer = L.geoJSON(otherFC, {
        pointToLayer: (feature, latlng) => volcanoMarker(latlng, false),
        onEachFeature: (feature, lyr) => {
          bindPopup(lyr, feature.properties, "Volcán");
          const p = feature.properties || {};
          const name = p.name || p.Name || p.NOMBRE || "Volcán";
          bindLabel(lyr, name, "label-volcano label-volcano-other", {
            direction: "top",
            offset: [0, -10]
          });
        }
      });

      volcanosOtherLayer.addTo(map);
      volcanosOvdasLayer.addTo(map);
      layerControl.addOverlay(volcanosOvdasLayer, "Volcanes (OVDAS 44)");
      layerControl.addOverlay(volcanosOtherLayer, "Volcanes (otros)");

      // Smelters
      smeltersLayer = await loadGeoJson(
        cfg.data.smelters,
        (feature, latlng) => smelterMarker(latlng),
        "Fundición"
      );

      smeltersLayer.eachLayer(l => {
        if (l.setStyle) l.setStyle({ color: "#000", fillColor: "#000" });
      });

      // Labels for smelters: RIGHT of point
      smeltersLayer.eachLayer(l => {
        const p = l.feature?.properties || {};
        const name = p.name || p.Name || p.NOMBRE || "Fundición";
        bindLabel(l, name, "label-smelter", {
          direction: "right",
          offset: [10, 0]
        });
      });

      smeltersLayer.addTo(map);
      layerControl.addOverlay(smeltersLayer, "Fundiciones");

      // Update labels + numeric scale when view changes
      map.on("zoomend", () => { updateLabels(); updateNumericScale(); });
      map.on("moveend", () => { updateLabels(); updateNumericScale(); });

      // First update
      updateNumericScale();
      updateLabels();

      setStatus(`Listo. Fecha (UTC): ${dateInput.value}. Etiquetas por escala: OVDAS ≤1:${SCALE_OVDAS_LABEL.toLocaleString("es-CL")}, otros/fundiciones ≤1:${SCALE_OTHER_LABEL.toLocaleString("es-CL")}.`);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
    }
  }

  // UI events
  dateInput.addEventListener("change", () => addSo2Layer(dateInput.value));
  opacityInput.addEventListener("input", () => {
    if (so2Layer) so2Layer.setOpacity(parseFloat(opacityInput.value));
  });
  todayBtn.addEventListener("click", () => {
    dateInput.value = todayUtcDateString();
    addSo2Layer(dateInput.value);
  });

  init();
})();
