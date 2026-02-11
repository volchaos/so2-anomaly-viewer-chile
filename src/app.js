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
    return `${dateStr}T05:00:00Z`;
  }

  const map = L.map("map", { worldCopyJump: true }).setView(cfg.map.center, cfg.map.zoom);

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

  function volcanoMarker(latlng) {
    return L.marker(latlng, {
      icon: L.divIcon({
        className: "volcano-icon",
        html: '<div style="width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:14px solid black;"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 14]
      })
    });
  }

  function smelterMarker(latlng) {
    return L.circleMarker(latlng, { radius: 6, weight: 2, fillOpacity: 0.9 });
  }

  function bindPopup(layer, props, fallbackTitle) {
    const name = (props && (props.name || props.Name || props.NOMBRE)) || fallbackTitle || "Sin nombre";
    const extra = [];
    if (props && props.type) extra.push(`Tipo: ${props.type}`);
    if (props && props.empresa) extra.push(`Empresa: ${props.empresa}`);
    const html = `<b>${name}</b>${extra.length ? `<br/>${extra.join("<br/>")}` : ""}`;
    layer.bindPopup(html);
  }

  async function loadGeoJson(url, pointToLayerFn, label) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`No se pudo cargar ${label}: ${r.status}`);
    const gj = await r.json();
    return L.geoJSON(gj, {
      pointToLayer: (feature, latlng) => pointToLayerFn(latlng),
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

  async function init() {
    try {
      dateInput.value = todayUtcDateString();
      addSo2Layer(dateInput.value);

      setStatus("Cargando capas…");

      const borderLayer = await loadChileBorder();
      borderLayer.addTo(map);
      layerControl.addOverlay(borderLayer, "Límite Chile");

      const volcanos = await loadGeoJson(cfg.data.volcanoes, volcanoMarker, "Volcán");
      // --- Labels: Volcanoes ---
      volcanos.eachLayer(l => {
        const p = l.feature?.properties || {};
        const name = p.name || p.Name || p.NOMBRE || "Volcán";
        l.bindTooltip(name, {
          permanent: true,
          direction: "top",
          offset: [0, -10],
          opacity: 0.9,
          className: "label-volcano"
        });
      });

      volcanos.addTo(map);
      layerControl.addOverlay(volcanos, "Volcanes");

      const smelters = await loadGeoJson(cfg.data.smelters, smelterMarker, "Fundición");
      smelters.eachLayer(l => { if (l.setStyle) l.setStyle({ color: "#000", fillColor: "#000" }); });
      // --- Labels: Smelters ---
      smelters.eachLayer(l => {
        const p = l.feature?.properties || {};
        const name = p.name || p.Name || p.NOMBRE || "Fundición";
        l.bindTooltip(name, {
          permanent: true,
          direction: "right",
          offset: [8, 0],
          opacity: 0.9,
          className: "label-smelter"
        });
      });

      smelters.addTo(map);
      layerControl.addOverlay(smelters, "Fundiciones");

      // --- Show/hide labels by zoom ---
      function updateLabels() {
        const z = map.getZoom();
        const showSmelter = z >= 5;
        const showVolcano = z >= 7;

        volcanos.eachLayer(l => {
          if (!l.getTooltip()) return;
          if (showVolcano) l.openTooltip();
          else l.closeTooltip();
        });

  smelters.eachLayer(l => {
    if (!l.getTooltip()) return;
    if (showSmelter) l.openTooltip();
    else l.closeTooltip();
  });
}
      
      setStatus(`Listo. Fecha (UTC): ${dateInput.value}. Cambia la fecha para actualizar TIME del WMS.`);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
    }
  }

map.on("zoomend", updateLabels);
updateLabels();
  
  dateInput.addEventListener("change", () => addSo2Layer(dateInput.value));
  opacityInput.addEventListener("input", () => { if (so2Layer) so2Layer.setOpacity(parseFloat(opacityInput.value)); });
  todayBtn.addEventListener("click", () => { dateInput.value = todayUtcDateString(); addSo2Layer(dateInput.value); });

  init();
})();
