"""
process_l2_so2.py  <YYYY-MM-DD>  <Nombre Volcán>

Procesa archivos L2 TROPOMI SO₂ para Chile:
  1. Lee variables clave de cada granulo NetCDF/HDF5
  2. Filtra por bbox + calidad (qa_value ≥ 0.5)
  3. Calcula área real de cada píxel TROPOMI (cuadrilátero esférico)
  4. Sustracción de fondo espacial: mediana en anillo 75–250 km alrededor del volcán
  5. Regrilla la anomalía (mol/m² → DU) a 0.05° regular
  6. Guarda GeoTIFF listo para QGIS + JSON con el valor de fondo

Salida:
    data/qgis/so2_l2_YYYYMMDD.tif            ← anomalía SO₂ en DU (float32)
    data/qgis/so2_l2_YYYYMMDD_background.json ← info de fondo por volcán

Uso:
    python scripts/process_l2_so2.py 2026-05-10 Lascar
"""

import json
import math
import sys
from pathlib import Path

import netCDF4 as nc4
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds

REPO_ROOT = Path(__file__).parent.parent
CACHE_DIR = REPO_ROOT / "data" / "l2_cache"
QGIS_DIR  = REPO_ROOT / "data" / "qgis"
GJ_PATH   = REPO_ROOT / "data" / "volcanoes_ovdas_44.geojson"

# Bbox de extracción (Chile + margen)
BBOX = {"west": -82.0, "east": -60.0, "south": -58.0, "north": -15.0}

# ── Parámetros de calidad y detección ─────────────────────────────────────────
QA_MIN        = 0.5    # umbral estándar TROPOMI: excluye nubes densas, nieve, SZA alto
GRID_DEG      = 0.05   # resolución de salida (°) — comparable a resolución nativa L2

# Anillo de fondo espacial (background ring)
BG_INNER_KM   =  75    # borde interno: excluye señal volcánica directa
BG_OUTER_KM   = 250    # borde externo: captura condiciones regionales
BG_MIN_PIXELS =  20    # mínimo de píxeles válidos en el anillo

# Conversión unidades L2 → DU
# 1 DU = 2.6867×10²⁰ molec/m² / NA = 4.462×10⁻⁴ mol/m²
# → 1 mol/m² = 2241 DU
MOL_M2_TO_DU = 1.0 / 4.462e-4   # ≈ 2241 DU per mol/m²

# Masa: 1 DU SO₂ = 2.856×10⁻² g/m²  (igual que en save_polygon.py)
NODATA_OUT = -9999.0


# ── Geometría ─────────────────────────────────────────────────────────────────

def _haversine_arr(lat0: float, lon0: float,
                   lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """Distancia en km desde (lat0, lon0) a cada punto del array."""
    R = 6371.0
    dlat = np.radians(lats - lat0)
    dlon = np.radians(lons - lon0)
    a = (np.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat0))
         * np.cos(np.radians(lats))
         * np.sin(dlon / 2) ** 2)
    return R * 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))


def _pixel_area_m2(lat_b: np.ndarray, lon_b: np.ndarray) -> np.ndarray:
    """
    Área aproximada (m²) de píxeles TROPOMI a partir de sus 4 vértices.
    lat_b / lon_b: shape (..., 4)  con las esquinas en orden GPKG.
    Usa fórmula del trapecio esférico (error < 1% para píxeles TROPOMI).
    """
    R = 6371000.0
    dlat = np.radians(np.max(lat_b, axis=-1) - np.min(lat_b, axis=-1))
    dlon = np.radians(np.max(lon_b, axis=-1) - np.min(lon_b, axis=-1))
    lat_mid = np.radians(np.mean(lat_b, axis=-1))
    return R ** 2 * dlat * dlon * np.abs(np.cos(lat_mid))


# ── Lectura L2 ────────────────────────────────────────────────────────────────

def _read_orbit(nc_path: Path, bbox: dict) -> dict | None:
    """
    Lee un granulo L2 y retorna arrays planos de puntos dentro del bbox.
    Retorna None si no hay píxeles en la región.

    Variables leídas:
      PRODUCT/latitude, longitude              → coordenadas del centro (°)
      PRODUCT/qa_value                         → calidad [0-1]
      PRODUCT/sulfurdioxide_total_vertical_column → columna SO₂ [mol/m²]
      PRODUCT/SUPPORT_DATA/GEOLOCATIONS/latitude_bounds  → 4 vértices
      PRODUCT/SUPPORT_DATA/GEOLOCATIONS/longitude_bounds → 4 vértices
    """
    try:
        ds = nc4.Dataset(nc_path, mode="r")
    except Exception as e:
        print(f"  Advertencia: no se pudo abrir {nc_path.name}: {e}")
        return None

    try:
        prod = ds.groups["PRODUCT"]

        # Índice 0: dimensión 'time' siempre tiene longitud 1 en S5P L2
        lat  = np.ma.filled(prod.variables["latitude"][0],  np.nan)   # (scans, pix)
        lon  = np.ma.filled(prod.variables["longitude"][0], np.nan)
        so2  = np.ma.filled(
            prod.variables["sulfurdioxide_total_vertical_column"][0], np.nan
        )
        qa   = np.ma.filled(prod.variables["qa_value"][0], 0.0)

        geo  = prod.groups["SUPPORT_DATA"].groups["GEOLOCATIONS"]
        latb = np.ma.filled(geo.variables["latitude_bounds"][0],  np.nan)  # (s,p,4)
        lonb = np.ma.filled(geo.variables["longitude_bounds"][0], np.nan)

    finally:
        ds.close()

    # Flatten y filtrar al bbox
    lat  = lat.ravel()
    lon  = lon.ravel()
    so2  = so2.ravel()
    qa   = qa.ravel()
    latb = latb.reshape(-1, 4)
    lonb = lonb.reshape(-1, 4)

    in_bbox = (
        (lat >= bbox["south"]) & (lat <= bbox["north"]) &
        (lon >= bbox["west"])  & (lon <= bbox["east"])  &
        np.isfinite(lat) & np.isfinite(lon)
    )
    if not np.any(in_bbox):
        return None

    areas = _pixel_area_m2(latb[in_bbox], lonb[in_bbox])

    return {
        "lat":   lat[in_bbox],
        "lon":   lon[in_bbox],
        "so2":   so2[in_bbox],    # mol/m²
        "qa":    qa[in_bbox],
        "areas": areas,           # m²
    }


def _load_all_orbits(date_str: str, bbox: dict) -> dict:
    """Carga y concatena todos los granulos del día desde el caché."""
    manifest = CACHE_DIR / date_str / "files.json"
    if not manifest.exists():
        raise FileNotFoundError(
            f"Sin caché L2 para {date_str}. "
            f"Ejecuta primero:\n  python scripts/fetch_l2_so2.py {date_str}"
        )

    files = json.loads(manifest.read_text())
    if not files:
        raise ValueError(f"Manifiesto vacío para {date_str}")

    lats, lons, so2s, qas, areas = [], [], [], [], []
    for fp in files:
        p = Path(fp)
        if not p.exists():
            print(f"  Omitiendo {p.name} (no encontrado)")
            continue
        print(f"  Leyendo {p.name}…")
        d = _read_orbit(p, bbox)
        if d is None:
            print(f"    → sin píxeles en bbox")
            continue
        lats.append(d["lat"])
        lons.append(d["lon"])
        so2s.append(d["so2"])
        qas.append(d["qa"])
        areas.append(d["areas"])

    if not lats:
        raise ValueError("Ningún granulo tiene píxeles dentro de Chile.")

    return {
        "lat":   np.concatenate(lats),
        "lon":   np.concatenate(lons),
        "so2":   np.concatenate(so2s),
        "qa":    np.concatenate(qas),
        "areas": np.concatenate(areas),
    }


# ── Sustracción de fondo ───────────────────────────────────────────────────────

def compute_background(data: dict, vlat: float, vlon: float) -> float:
    """
    Calcula el fondo regional como mediana del SO₂ en el anillo
    BG_INNER_KM – BG_OUTER_KM alrededor del volcán.

    Solo usa píxeles válidos (QA ≥ QA_MIN, SO₂ finito y no negativo extremo).
    Retorna fondo en mol/m² (0.0 si hay menos de BG_MIN_PIXELS píxeles).
    """
    dist = _haversine_arr(vlat, vlon, data["lat"], data["lon"])
    mask = (
        (dist > BG_INNER_KM) & (dist <= BG_OUTER_KM) &
        (data["qa"] >= QA_MIN) &
        np.isfinite(data["so2"]) &
        (data["so2"] > -1e-3)     # excluir fill values negativos
    )
    n = int(np.sum(mask))
    if n < BG_MIN_PIXELS:
        print(
            f"    ⚠  Solo {n} px en anillo de fondo "
            f"(mín {BG_MIN_PIXELS}) → fondo = 0"
        )
        return 0.0

    bg = float(np.median(data["so2"][mask]))
    bg_du = bg * MOL_M2_TO_DU
    print(
        f"    Fondo: {bg:.6f} mol/m² = {bg_du:.3f} DU  "
        f"(anillo {BG_INNER_KM}–{BG_OUTER_KM} km, n={n})"
    )
    return bg


# ── Regridding → GeoTIFF ──────────────────────────────────────────────────────

def regrid_and_save(
    data: dict,
    so2_anomaly_du: np.ndarray,
    out_path: Path,
    bbox: dict,
) -> None:
    """
    Regrilla la anomalía SO₂ (DU) a una grilla regular GRID_DEG × GRID_DEG
    y la guarda como GeoTIFF float32.
    Solo incluye píxeles con QA ≥ QA_MIN.
    """
    w, e = bbox["west"],  bbox["east"]
    s, n = bbox["south"], bbox["north"]

    lat_edges = np.arange(s, n + GRID_DEG, GRID_DEG)
    lon_edges = np.arange(w, e + GRID_DEG, GRID_DEG)
    nrows = len(lat_edges) - 1
    ncols = len(lon_edges) - 1

    valid = (data["qa"] >= QA_MIN) & np.isfinite(so2_anomaly_du)

    row_idx = np.floor((data["lat"][valid] - s) / GRID_DEG).astype(int)
    col_idx = np.floor((data["lon"][valid] - w) / GRID_DEG).astype(int)

    # Clamp a límites de grilla
    ok = (
        (row_idx >= 0) & (row_idx < nrows) &
        (col_idx >= 0) & (col_idx < ncols)
    )
    vals = so2_anomaly_du[valid][ok]
    ri   = row_idx[ok]
    ci   = col_idx[ok]

    # Media simple por celda (los píxeles TROPOMI no se solapan significativamente)
    grid_sum = np.zeros((nrows, ncols), dtype=np.float64)
    grid_cnt = np.zeros((nrows, ncols), dtype=np.int32)
    np.add.at(grid_sum, (ri, ci), vals)
    np.add.at(grid_cnt, (ri, ci), 1)

    grid = np.where(grid_cnt > 0, grid_sum / grid_cnt, np.nan).astype(np.float32)

    # Rasterio: filas de norte a sur
    grid = grid[::-1, :]
    grid = np.where(np.isnan(grid), NODATA_OUT, grid)

    transform = from_bounds(w, s, e, n, ncols, nrows)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with rasterio.open(
        out_path, "w",
        driver="GTiff", height=nrows, width=ncols,
        count=1, dtype="float32",
        crs=CRS.from_epsg(4326),
        transform=transform,
        nodata=NODATA_OUT,
        compress="deflate",
    ) as dst:
        dst.write(grid[np.newaxis, :, :])

    n_valid = int(np.sum(grid_cnt > 0))
    print(
        f"  GeoTIFF: {out_path.name}  "
        f"({ncols}×{nrows} px · {GRID_DEG}° · {n_valid} celdas válidas)"
    )


# ── Main ───────────────────────────────────────────────────────────────────────

def process(date_str: str, volcano_name: str) -> Path:
    """
    API pública: procesa L2 para la fecha y volcán dados.
    Retorna la ruta del GeoTIFF generado.
    """
    ds_flat = date_str.replace("-", "")
    tif_out = QGIS_DIR / f"so2_l2_{ds_flat}.tif"

    # Cargar lista de volcanes
    with open(GJ_PATH, encoding="utf-8") as f:
        gj = json.load(f)
    volcanoes = [
        {"name": feat["properties"]["Name"],
         "lat":  feat["properties"]["lat"],
         "lon":  feat["properties"]["lon"]}
        for feat in gj["features"]
    ]

    # Buscar volcán
    q = volcano_name.lower().strip()
    v = next((x for x in volcanoes if x["name"].lower() == q), None)
    if v is None:
        matches = [x for x in volcanoes if q in x["name"].lower()]
        if len(matches) == 1:
            v = matches[0]
        elif len(matches) > 1:
            names = [m["name"] for m in matches]
            raise ValueError(f"Múltiples coincidencias para '{volcano_name}': {names}")
        else:
            raise ValueError(f"Volcán '{volcano_name}' no encontrado en OVDAS.")

    print(f"\nProcesando L2 SO₂  {v['name']}  ·  {date_str}")
    print("─" * 55)

    # Cargar granulos
    data = _load_all_orbits(date_str, BBOX)

    n_total = len(data["lat"])
    n_valid = int(np.sum(data["qa"] >= QA_MIN))
    print(
        f"  Píxeles en bbox: {n_total:,}  |  "
        f"válidos (QA≥{QA_MIN}): {n_valid:,}"
    )
    if n_valid == 0:
        raise ValueError("Sin píxeles válidos (QA) para este día en Chile.")

    # Fondo espacial
    bg_mol = compute_background(data, v["lat"], v["lon"])

    # Anomalía en DU (clip negativo: background-corrected noise → 0 en la imagen)
    so2_anom_du = (data["so2"] - bg_mol) * MOL_M2_TO_DU

    # Stats
    valid_mask = (data["qa"] >= QA_MIN) & np.isfinite(data["so2"])
    anom_valid = so2_anom_du[valid_mask]
    print(
        f"  Anomalía  max: {np.nanmax(anom_valid):.2f} DU  |  "
        f"mediana: {np.nanmedian(anom_valid):.3f} DU  |  "
        f"p95: {np.nanpercentile(anom_valid, 95):.2f} DU"
    )

    # Guardar GeoTIFF (con valores negativos: el usuario ve el rango real)
    regrid_and_save(data, so2_anom_du, tif_out, BBOX)

    # Guardar metadata de fondo
    bg_json = QGIS_DIR / f"so2_l2_{ds_flat}_background.json"
    meta = {
        "date":              date_str,
        "volcano":           v["name"],
        "background_mol_m2": round(bg_mol, 8),
        "background_du":     round(bg_mol * MOL_M2_TO_DU, 4),
        "bg_inner_km":       BG_INNER_KM,
        "bg_outer_km":       BG_OUTER_KM,
        "qa_min":            QA_MIN,
        "n_valid_pixels":    n_valid,
    }
    bg_json.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print(f"  Metadata fondo: {bg_json.name}")

    return tif_out


def main() -> None:
    if len(sys.argv) < 3:
        print("Uso: python scripts/process_l2_so2.py YYYY-MM-DD 'Nombre Volcán'")
        sys.exit(1)

    date_str     = sys.argv[1]
    volcano_name = " ".join(sys.argv[2:])

    try:
        tif = process(date_str, volcano_name)
        print(f"\n✓ GeoTIFF listo: {tif}")
    except (FileNotFoundError, ValueError) as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
