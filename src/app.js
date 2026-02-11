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
  function volcanoDivIcon(sizePx) {
    const s = sizePx;
    return L.divIcon({
      className: "volcano-icon",
      html: `<div style="width:0;height:0;border-left:${Math.round(s/2)}px solid transparent;border-right:${Math.round(s/2)}px solid transparent;border-bottom:${Math.round(s*1.1)}px solid black;"></div>`,
      iconSize: [s, Math.round(s*1.1)],
      iconAnchor: [Math.round(s/2), Math.round(s*1.1)]
    });
  }

  function volcanoMarker(latlng, isOvdas) {
    return L.marker(latlng, { icon: volcanoDivIcon(isOvdas ? 18 : 12) });
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

  // Layer refs for zoom label control
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

  function updateLabels() {
    const z = map.getZoom();
    const zl = cfg.zoomLabels || { smelter: 5, ovdas: 7, other: 9 };

    const showSmelter = z >= zl.smelter;
    const showOvdas = z >= zl.ovdas;
    const showOther = z >= zl.other;

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
      smeltersLayer = await loadGeoJson(cfg.data.smelters, (feature, latlng) => smelterMarker(latlng), "Fundición");
      smeltersLayer.eachLayer(l => {
        if (l.setStyle) l.setStyle({ color: "#000", fillColor: "#000" });
      });
      smeltersLayer.eachLayer(l => {
        const p = l.feature?.properties || {};
        const name = p.name || p.Name || p.NOMBRE || "Fundición";
        bindLabel(l, name, "label-smelter", {
          direction: "right",
          offset: [8, 0]
        });
      });
      smeltersLayer.addTo(map);
      layerControl.addOverlay(smeltersLayer, "Fundiciones");

      map.on("zoomend", updateLabels);
      updateLabels();

      const zl = cfg.zoomLabels || { smelter: 5, ovdas: 7, other: 9 };
      setStatus(`Listo. Fecha (UTC): ${dateInput.value}. Etiquetas: fundiciones ≥${zl.smelter}, OVDAS ≥${zl.ovdas}, otros ≥${zl.other}.`);
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
