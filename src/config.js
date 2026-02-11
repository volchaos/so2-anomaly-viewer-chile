// Central config for WMS + data sources.
// If EOC changes layer names/styles or TIME formats, update here.

window.APP_CONFIG = {
  map: {
    center: [-30.0, -71.0],
    zoom: 4,
    maxZoom: 10
  },

  wms: {
    url: "https://geoservice.dlr.de/eoc/atmosphere/wms",
    layers: "S5P_TROPOMI_L3_P1D_SO2_v2",
    version: "1.3.0",
    format: "image/png",
    transparent: true,
    timeFormat: "isoZ",
    styles: "",
    attribution: "EOC Geoservice (DLR)"
  },

  data: {
    volcanoes: "data/volcanoes.geojson",
    smelters: "data/smelters_13.geojson",
    countriesUrl: "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson",
    chileNamePropertyCandidates: ["ADMIN", "name", "NAME", "COUNTRY", "SOVEREIGNT"]
  },

  ui: {
    eocDatasetPage: "https://geoservice.dlr.de/web/datasets/tropomi_l3_so2"
  }
};
