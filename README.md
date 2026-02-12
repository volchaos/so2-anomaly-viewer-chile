# SO2 Anomaly Check (Chile) — Live WMS Viewer (GitHub Pages)

This repo hosts a simple web viewer that overlays:
- **EOC Geoservice WMS**: Sentinel‑5P/TROPOMI L3 Daily SO₂ (live)
- **Volcanoes** (local GeoJSON)
- **Smelters/Fundiciones** (local GeoJSON)
- **Chile border** (Natural Earth-derived public GeoJSON, filtered client-side)

## 1) What you need to add
Replace the placeholder files:
- `data/volcanoes.geojson`
- `data/smelters_13.geojson`

They must be **Point** features (EPSG:4326) with at least a `name` property.

## 2) GitHub Pages
1. Push this repo to GitHub.
2. Go to **Settings → Pages**.
3. Set:
   - Source: **Deploy from a branch**
   - Branch: `main`
   - Folder: `/ (root)`
4. Save. Your site will be available at `https://<user>.github.io/<repo>/`.

## 3) Date selection (TIME)
The viewer sends a WMS `TIME` parameter using ISO format:
`YYYY-MM-DDT00:00:00Z`.

If EOC changes accepted TIME formats or styles, update `src/config.js`.

## 4) Notes
- This viewer depends on the EOC WMS being reachable.
- If a selected day has no data, the map may appear blank (the WMS typically returns transparent tiles).


## Volcano layers
- All volcanoes: `data/volcanoes.geojson`
- OVDAS volcanoes (44): `data/volcanoes_ovdas_44.geojson`
The viewer renders OVDAS with a larger symbol and labels at lower zoom.


## Wind overlays (optional)
This viewer supports optional wind overlays (OFF by default) at 10m, 900hPa (~1km), 400hPa (~7km), 150hPa (~15km).
Provide JSON files under `data/wind/YYYY-MM-DD/` as described in `data/wind/README.txt`.

## Automated wind overlays (GitHub Actions)
This repo includes a workflow that generates daily wind overlays from NOAA GFS 0.25° and commits JSON files to `data/wind/YYYY-MM-DD/`.

- Schedule: **20:10 UTC** (~17:10 Chile)
- Manual: Actions → *Build daily wind overlays* → Run workflow (optional `run_date`).
