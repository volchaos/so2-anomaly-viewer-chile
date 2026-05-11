# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A GitHub Pages web viewer for SO₂ (sulfur dioxide) anomaly monitoring over Chile. It overlays Sentinel-5P/TROPOMI L3 daily SO₂ data (via EOC/DLR WMS) on a Leaflet map, with OVDAS volcano markers, smelter locations, and optional GFS wind overlays. No build step — runs directly in the browser from `index.html`.

## Running locally

Open `index.html` in a browser, or serve it with any static server:
```
python -m http.server 8080
```
The app fetches data live from the EOC WMS (`geoservice.dlr.de`) and from `data/` files in the repo.

## Python environment

All Python scripts use the `so2-wind` conda environment:
```
conda env create -f environment.yml
conda activate so2-wind
```
Key deps: `numpy`, `pandas`, `rasterio`, `scipy`, `xarray`, `cfgrib`, `eccodes`, `requests`.

## Python scripts

| Script | Purpose | How to run |
|--------|---------|------------|
| `scripts/run_wind_daily.py` | Download GFS 0.25° GRIB2 and generate wind JSON for all pressure levels | `python scripts/run_wind_daily.py YYYY-MM-DD [lookback_days]` |
| `scripts/build_wind_json.py` | Low-level GFS fetch + sparse JSON output per level | Called by `run_wind_daily.py` |
| `scripts/extract_so2.py` | Automated SO₂ anomaly extraction from EOC COGs (experimental, not integrated in viewer) | `python scripts/extract_so2.py YYYY-MM-DD` |
| `scripts/build_gif.py` | Server-side GIF builder from WMS tiles (server-side alternative to in-browser GIF) | `python scripts/build_gif.py jobs/gif_job.json` |
| `scripts/save_polygon.py` | Reads manually drawn polygon from QGIS GeoPackage, calculates SO₂ mass, writes to DB + JSON | `python scripts/save_polygon.py YYYY-MM-DD "Nombre Volcán"` |

## Manual SO₂ workflow (QGIS-based)

The automated `extract_so2.py` detection is unreliable and is **not integrated in the viewer**. The validated workflow for mass calculation is:

1. Run `prepare_day.py` to download the L3 GeoTIFF and generate a QGIS project (`.qgz`) pre-loaded with the SO₂ raster, volcano markers, and an empty polygon layer.
2. Open the `.qgz` in QGIS 3.40+, digitize the SO₂ anomaly polygon, save (Ctrl+S).
3. Run `save_polygon.py` to read the polygon, calculate mass, and update `data/so2_stats.json` + `data/plumes/YYYYMMDD.json`.
4. Commit and push the updated `data/` files.

QGIS files are written to `data/qgis/YYYYMMDD_VolcanoName.{qgz,gpkg}`.

## GitHub Actions

Two workflows run automatically:

- **`buil_wind.yml`**: Runs daily at 20:10 UTC. Downloads GFS wind data and commits JSON files to `data/wind/YYYY-MM-DD/`. Can be triggered manually with `run_date` and `lookback_days` inputs.
- **`build_gif.yml`**: Manual only. Builds a server-side SO₂ GIF given a `jobs/gif_job.json` specification. Commits output to `data/gifs/`.

Both workflows use `micromamba` with `environment.yml`.

**Important**: GitHub Actions commits to `main` concurrently. Always `git pull --rebase` before pushing to avoid non-fast-forward rejections.

## Frontend architecture

All frontend logic is a single IIFE in `src/app.js` with no bundler. Load order in `index.html`:
1. `src/gifmaker.js` — in-browser GIF encoder (standalone, no dependencies)
2. Leaflet 1.9.4 (CDN)
3. `src/config.js` — exports `window.APP_CONFIG` with WMS URL, layer names, data paths
4. `src/app.js` — all map logic, wind overlays, GIF UI, NASA image panel

Key patterns in `app.js`:
- **SO₂ WMS**: `L.tileLayer.wms()` with `TIME=YYYY-MM-DDT05:00:00Z`. The `T05:00:00Z` offset is intentional (EOC data availability).
- **Wind overlays**: Sparse JSON (`{lats, lons, u, v}`) fetched from `data/wind/YYYY-MM-DD/NNNhPa.json`. Rendered as canvas-based barb arrows via custom `drawWindBarbs()`.
- **In-browser GIF**: `gifmaker.js` encodes frames from WMS tile composites drawn on `<canvas>`. Layers (border, volcanoes, smelters, legend, wind) are drawn on top of the WMS image before encoding.
- **NASA panel**: Fetches `https://so2.gsfc.nasa.gov/pix/daily/` images by constructing candidate URLs; falls back gracefully if no image exists.

## Data layout

```
data/
  volcanoes.geojson           # All Chilean volcanoes (Point, EPSG:4326)
  volcanoes_ovdas_44.geojson  # 44 OVDAS-monitored volcanoes (with lat/lon props)
  smelters_13.geojson         # 13 copper smelters
  wind/YYYY-MM-DD/            # Wind JSON per pressure level (900/500/250/150 hPa)
  gifs/VolcanoName/           # Pre-built GIFs + metadata JSON
  qgis/                       # QGIS projects for manual SO₂ mapping (local only)
  plumes/YYYYMMDD.json        # Manual SO₂ plume polygons (GeoJSON FeatureCollection)
```

Wind JSON format: `{"date":"...","level":"900hPa","lats":[...],"lons":[...],"u":[...],"v":[...]}` — sparse (only points with wind speed > threshold).

## Key configuration

`src/config.js` is the single source of truth for:
- WMS endpoint and layer name (`S5P_TROPOMI_L3_P1D_SO2_v2`)
- TIME format (`isoZ` → appends `T05:00:00Z`)
- GeoJSON data file paths
- Map center/zoom defaults

If EOC changes layer names, styles, or TIME parameter formats, update only `src/config.js`.

## Deployment

The site is served via GitHub Pages from the `main` branch root. No CI build required — push to `main` and the site updates immediately.
