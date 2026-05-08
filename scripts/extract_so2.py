"""
extract_so2.py
Extrae anomalías de SO2 desde COG GeoTIFFs de EOC/DLR para volcanes OVDAS.
- Lee solo la región necesaria via HTTP range requests (COG)
- Aplica Enfoque B: flood fill desde el pixel máximo dentro del radio
- Calcula masa en toneladas
- Escribe en SQLite (histórico) y JSON (90 días, para el visor)
"""

import json
import math
import os
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import requests
from scipy.ndimage import label

# ── Intentar importar rasterio; si no hay, instalar ──────────────────────────
try:
    import rasterio
    from rasterio.crs import CRS
    from rasterio.transform import rowcol
    from rasterio.windows import Window
except ImportError:
    os.system("pip install rasterio --quiet")
    import rasterio
    from rasterio.crs import CRS
    from rasterio.transform import rowcol
    from rasterio.windows import Window

# ── Configuración ─────────────────────────────────────────────────────────────
SEED_RADIUS_KM  = 150.0   # radio para buscar la semilla inicial junto al volcán
MAX_RADIUS_KM   = 1000.0  # límite máximo de expansión de la pluma
HIGH_THRESHOLD  = 0.45    # DU: umbral de semilla (señal segura)
LOW_THRESHOLD   = 0.20    # DU: umbral de crecimiento (rellena huecos, captura extremos)
HISTORY_DAYS    = 90      # días a incluir en el JSON del visor
NODATA_VALUE    = 9.969e+36  # valor nodata del GeoTIFF de EOC
BASE_URL        = "https://download.geoservice.dlr.de/S5P_TROPOMI/files/L3"

REPO_ROOT = Path(__file__).parent.parent
DB_PATH   = REPO_ROOT / "data" / "so2_history.db"
JSON_PATH = REPO_ROOT / "data" / "so2_stats.json"
GJ_PATH   = REPO_ROOT / "data" / "volcanoes_ovdas_44.geojson"

# Factor de conversión: 1 DU SO₂ = 2.6867e20 molec/m² × 64.066 g/mol ÷ 6.022e23 = 2.856e-2 g/m²
DU_TO_G_PER_M2 = 2.856e-2

# ── Funciones de geometría ────────────────────────────────────────────────────

def haversine_km(lat1, lon1, lat2, lon2):
    """Distancia en km entre dos puntos (lat/lon en grados)."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def pixel_area_m2(lat, res_deg_lon=0.1, res_deg_lat=0.1):
    """Área real de un pixel en m² a una latitud dada (pixels se achican en los polos)."""
    R = 6371000.0
    dy = math.radians(res_deg_lat) * R
    dx = math.radians(res_deg_lon) * R * math.cos(math.radians(lat))
    return abs(dx * dy)

def bbox_for_radius(lat, lon, radius_km):
    """Bounding box (min_lon, min_lat, max_lon, max_lat) para un radio dado."""
    deg_lat = radius_km / 111.0
    deg_lon = radius_km / (111.0 * math.cos(math.radians(lat)))
    return (lon - deg_lon, lat - deg_lat, lon + deg_lon, lat + deg_lat)

# ── URL del COG ───────────────────────────────────────────────────────────────

def cog_url(d: date) -> str:
    ds = d.strftime("%Y%m%d")
    return (
        f"{BASE_URL}/{d.year:04d}/{d.month:02d}/{d.day:02d}/"
        f"S5P_DLR_NRTI_01_L3_SO2_{ds}/"
        f"S5P_DLR_NRTI_01_L3_SO2_{ds}_so2.tif"
    )

def file_exists(url: str) -> bool:
    try:
        r = requests.head(url, timeout=15)
        return r.status_code == 200
    except Exception:
        return False

# ── Lectura del COG ───────────────────────────────────────────────────────────

def read_region(url: str, min_lon, min_lat, max_lon, max_lat):
    """
    Lee solo la región de Chile del COG usando HTTP range requests.
    Devuelve (data_array, transform, res_lon, res_lat) o None si falla.
    """
    try:
        env_path = f"/vsicurl/{url}"
        with rasterio.open(env_path) as src:
            # Transformar coordenadas geo a filas/columnas
            row_min, col_min = rowcol(src.transform, min_lon, max_lat)
            row_max, col_max = rowcol(src.transform, max_lon, min_lat)

            # Asegurar orden correcto y límites válidos
            row_min, row_max = sorted([row_min, row_max])
            col_min, col_max = sorted([col_min, col_max])
            row_min = max(0, row_min)
            col_min = max(0, col_min)
            row_max = min(src.height - 1, row_max)
            col_max = min(src.width - 1, col_max)

            window = Window(col_min, row_min,
                            col_max - col_min + 1,
                            row_max - row_min + 1)

            data = src.read(1, window=window).astype(float)
            win_transform = src.window_transform(window)

            res_lon = src.transform.a   # resolución en grados lon (~0.1)
            res_lat = abs(src.transform.e)  # resolución en grados lat (~0.1)

            return data, win_transform, res_lon, res_lat
    except Exception as e:
        print(f"  Error leyendo COG: {e}")
        return None

# ── Extracción de anomalía (Enfoque B) ───────────────────────────────────────

def extract_anomaly(data, transform, res_lon, res_lat, v_lat, v_lon):
    """
    Extracción de pluma con umbral dual (hysteresis) y sin límite de radio para el flood fill.

    Lógica:
    1. Semilla: píxeles con SO₂ >= HIGH_THRESHOLD dentro de SEED_RADIUS_KM del volcán.
       Asegura que la señal esté atribuida al volcán correcto.
    2. Crecimiento: flood fill (conectividad 8) con SO₂ >= LOW_THRESHOLD dentro de
       MAX_RADIUS_KM. El umbral bajo rellena huecos y captura los extremos débiles de
       la pluma; el radio máximo previene expansión descontrolada.
    3. Se toman TODAS las regiones conectadas que contengan al menos un píxel semilla,
       capturando plumas parcialmente fragmentadas.
    """
    rows, cols = data.shape

    # Máscara de nodata y valores inválidos
    valid = (data < NODATA_VALUE * 0.9) & np.isfinite(data)
    data_clean = np.where(valid, data, np.nan)

    # Grilla de coordenadas y distancias (vectorizado)
    col_idx = np.arange(cols)
    row_idx = np.arange(rows)
    lons = transform.c + col_idx * transform.a + transform.a / 2
    lats = transform.f + row_idx * transform.e - abs(transform.e) / 2
    lon_grid, lat_grid = np.meshgrid(lons, lats)

    dlat = np.radians(lat_grid - v_lat)
    dlon = np.radians(lon_grid - v_lon)
    sin_dlat = np.sin(dlat / 2)
    sin_dlon = np.sin(dlon / 2)
    a_hav = sin_dlat**2 + np.cos(np.radians(v_lat)) * np.cos(np.radians(lat_grid)) * sin_dlon**2
    dist_km = 6371.0 * 2 * np.arctan2(np.sqrt(a_hav), np.sqrt(1.0 - a_hav))

    in_seed_radius = dist_km <= SEED_RADIUS_KM
    in_max_radius  = dist_km <= MAX_RADIUS_KM

    # Píxeles semilla: señal fuerte y cercana al volcán
    seed_mask = in_seed_radius & (data_clean >= HIGH_THRESHOLD) & valid
    if not np.any(seed_mask):
        return None

    max_val = float(np.nanmax(data_clean[seed_mask]))

    # Máscara de crecimiento: umbral bajo, dentro del radio máximo
    growth_mask = (data_clean >= LOW_THRESHOLD) & valid & in_max_radius

    # Etiquetar regiones conectadas (conectividad 8)
    structure = np.ones((3, 3), dtype=int)
    labeled, n_features = label(growth_mask, structure=structure)
    if n_features == 0:
        return None

    # Todas las etiquetas que contienen al menos un píxel semilla
    seed_labels = set(int(lbl) for lbl in np.unique(labeled[seed_mask]) if lbl > 0)
    if not seed_labels:
        return None

    plume_mask = np.isin(labeled, list(seed_labels))

    # Área por píxel según latitud (vectorizado)
    area_grid = (np.radians(res_lat) * 6371000.0) * \
                (np.radians(res_lon) * 6371000.0 * np.abs(np.cos(np.radians(lat_grid))))

    plume_vals  = data_clean[plume_mask]
    plume_areas = area_grid[plume_mask]
    plume_lats  = lat_grid[plume_mask]
    plume_lons  = lon_grid[plume_mask]

    mass_g_arr    = plume_vals * DU_TO_G_PER_M2 * plume_areas
    total_mass_g  = float(np.sum(mass_g_arr))
    total_area_m2 = float(np.sum(plume_areas))

    centroid_lat = float(np.sum(plume_lats * mass_g_arr) / total_mass_g) if total_mass_g > 0 else v_lat
    centroid_lon = float(np.sum(plume_lons * mass_g_arr) / total_mass_g) if total_mass_g > 0 else v_lon

    return {
        "so2_tons":     round(total_mass_g / 1e6, 2),
        "max_du":       round(max_val, 3),
        "plume_pixels": int(np.sum(plume_mask)),
        "plume_km2":    round(total_area_m2 / 1e6, 1),
        "centroid_lat": round(centroid_lat, 4),
        "centroid_lon": round(centroid_lon, 4),
    }

# ── Base de datos SQLite ──────────────────────────────────────────────────────

def init_db(db_path: Path):
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS so2_measurements (
            date          TEXT NOT NULL,
            volcano       TEXT NOT NULL,
            so2_tons      REAL,
            max_du        REAL,
            plume_pixels  INTEGER,
            plume_km2     REAL,
            centroid_lat  REAL,
            centroid_lon  REAL,
            data_ok       INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (date, volcano)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_vol_date ON so2_measurements(volcano, date)")
    conn.commit()
    return conn

def upsert(conn, date_str, volcano, metrics, data_ok):
    if metrics:
        conn.execute("""
            INSERT OR REPLACE INTO so2_measurements
            (date, volcano, so2_tons, max_du, plume_pixels, plume_km2, centroid_lat, centroid_lon, data_ok)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (date_str, volcano,
              metrics["so2_tons"], metrics["max_du"],
              metrics["plume_pixels"], metrics["plume_km2"],
              metrics["centroid_lat"], metrics["centroid_lon"],
              1 if data_ok else 0))
    else:
        conn.execute("""
            INSERT OR REPLACE INTO so2_measurements
            (date, volcano, so2_tons, max_du, plume_pixels, plume_km2, centroid_lat, centroid_lon, data_ok)
            VALUES (?, ?, 0, 0, 0, 0, NULL, NULL, ?)
        """, (date_str, volcano, 1 if data_ok else 0))
    conn.commit()

def record_exists(conn, date_str, volcano):
    cur = conn.execute(
        "SELECT 1 FROM so2_measurements WHERE date=? AND volcano=?",
        (date_str, volcano)
    )
    return cur.fetchone() is not None

# ── Generación del JSON de 90 días ────────────────────────────────────────────

def build_json(conn, volcanoes, json_path: Path):
    cutoff = (date.today() - timedelta(days=HISTORY_DAYS)).isoformat()
    result = {
        "updated":          date.today().isoformat(),
        "high_threshold_du": HIGH_THRESHOLD,
        "low_threshold_du":  LOW_THRESHOLD,
        "seed_radius_km":    SEED_RADIUS_KM,
        "max_radius_km":     MAX_RADIUS_KM,
        "volcanoes":         {}
    }

    for v in volcanoes:
        name = v["name"]
        rows = conn.execute("""
            SELECT date, so2_tons, max_du, plume_pixels, plume_km2, centroid_lat, centroid_lon, data_ok
            FROM so2_measurements
            WHERE volcano=? AND date>=?
            ORDER BY date ASC
        """, (name, cutoff)).fetchall()

        history = []
        for row in rows:
            entry = {
                "date":         row[0],
                "so2_tons":     row[1],
                "max_du":       row[2],
                "plume_pixels": row[3],
                "plume_km2":    row[4],
                "data_ok":      bool(row[7]),
            }
            if row[5] is not None:
                entry["centroid_lat"] = row[5]
                entry["centroid_lon"] = row[6]
            history.append(entry)

        result["volcanoes"][name] = {
            "lat":     v["lat"],
            "lon":     v["lon"],
            "history": history
        }

    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"JSON escrito: {json_path} ({len(json_path.read_bytes())/1024:.1f} KB)")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # Cargar volcanes OVDAS
    with open(GJ_PATH, encoding="utf-8") as f:
        gj = json.load(f)
    volcanoes = [
        {
            "name": feat["properties"]["Name"],
            "lat":  feat["properties"]["lat"],
            "lon":  feat["properties"]["lon"],
        }
        for feat in gj["features"]
    ]
    print(f"Volcanes OVDAS cargados: {len(volcanoes)}")

    # Inicializar DB
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = init_db(DB_PATH)

    # Determinar qué fechas procesar
    # Por defecto: ayer (cron diario). Con argumento --backfill N: últimos N días
    force = "--force" in sys.argv
    if "--backfill" in sys.argv:
        idx = sys.argv.index("--backfill")
        n_days = int(sys.argv[idx + 1])
    else:
        n_days = 1

    today = date.today()
    dates_to_process = [today - timedelta(days=i) for i in range(1, n_days + 1)]
    dates_to_process.reverse()  # Procesar del más antiguo al más reciente

    print(f"Fechas a procesar: {len(dates_to_process)} "
          f"({dates_to_process[0]} → {dates_to_process[-1]})"
          + (" [FORCE]" if force else ""))

    for d in dates_to_process:
        date_str = d.isoformat()
        url = cog_url(d)

        # Sin --force, saltar fechas ya completadas
        if not force:
            all_done = all(record_exists(conn, date_str, v["name"]) for v in volcanoes)
            if all_done:
                print(f"{date_str}: ya procesado, omitiendo")
                continue

        print(f"\n── {date_str} ──────────────────────────────────")

        # Verificar disponibilidad del archivo
        if not file_exists(url):
            print(f"  Archivo no disponible: {url}")
            for v in volcanoes:
                if force or not record_exists(conn, date_str, v["name"]):
                    upsert(conn, date_str, v["name"], None, data_ok=False)
            continue

        print(f"  URL: {url}")

        # Leer el COG una sola vez para todo Chile + margen para flood fill
        all_lats = [v["lat"] for v in volcanoes]
        all_lons = [v["lon"] for v in volcanoes]
        margin = MAX_RADIUS_KM / 111.0 + 0.5
        bbox = (
            min(all_lons) - margin,
            min(all_lats) - margin,
            max(all_lons) + margin,
            max(all_lats) + margin,
        )

        result = read_region(url, *bbox)
        if result is None:
            print("  No se pudo leer el COG, marcando como data_ok=False")
            for v in volcanoes:
                if force or not record_exists(conn, date_str, v["name"]):
                    upsert(conn, date_str, v["name"], None, data_ok=False)
            continue

        data, transform, res_lon, res_lat = result
        print(f"  Región leída: {data.shape[0]}×{data.shape[1]} pixels")

        # Procesar cada volcán
        for v in volcanoes:
            if not force and record_exists(conn, date_str, v["name"]):
                continue

            metrics = extract_anomaly(data, transform, res_lon, res_lat,
                                      v["lat"], v["lon"])
            upsert(conn, date_str, v["name"], metrics, data_ok=True)

            if metrics and metrics["so2_tons"] > 0:
                print(f"  {v['name']:30s} {metrics['so2_tons']:8.1f} t  "
                      f"max={metrics['max_du']:.2f} DU  "
                      f"{metrics['plume_pixels']} px  "
                      f"{metrics['plume_km2']:.0f} km²")
            else:
                print(f"  {v['name']:30s} sin anomalía")

    # Generar JSON de 90 días
    print("\nGenerando JSON del visor...")
    build_json(conn, volcanoes, JSON_PATH)
    conn.close()
    print("Listo.")

if __name__ == "__main__":
    main()
