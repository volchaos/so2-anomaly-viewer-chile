"""
save_polygon.py  <YYYY-MM-DD> <Nombre Volcán>

Lee el polígono dibujado en QGIS (capa "Anomalía SO₂" del GeoPackage generado
por prepare_day.py), calcula la masa de SO₂ dentro del polígono y guarda los
resultados en la base de datos, el JSON del visor y el GeoJSON de plumas.

Requisitos: rasterio, numpy  (ya instalados en el entorno)

Uso:
    python scripts/save_polygon.py 2026-02-08 Lascar
    python scripts/save_polygon.py 2026-04-26 "Lascar"

Luego hacer push para actualizar el visor:
    git add data/ && git commit -m "SO2 manual 2026-02-08 Lascar" && git push
"""

import json
import sqlite3
import struct
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import rasterio
from rasterio.mask import mask as rio_mask

# ── Rutas ─────────────────────────────────────────────────────────────────────
REPO_ROOT    = Path(__file__).parent.parent
GJ_PATH      = REPO_ROOT / "data" / "volcanoes_ovdas_44.geojson"
QGIS_DIR     = REPO_ROOT / "data" / "qgis"
DB_PATH      = REPO_ROOT / "data" / "so2_history.db"
JSON_PATH    = REPO_ROOT / "data" / "so2_stats.json"
PLUME_DIR    = REPO_ROOT / "data" / "plumes"
HISTORY_DAYS = 90

DU_TO_G_PER_M2 = 2.856e-2   # 1 DU SO₂ = 2.856×10⁻² g/m²
NODATA         = -9999.0    # nodata del GeoTIFF L2 generado por process_l2_so2.py

# ── Lectura del polígono desde el GeoPackage ──────────────────────────────────

def read_polygon(gpkg_path: Path) -> dict | None:
    """Lee el primer polígono de la capa 'anomalia' y lo devuelve como GeoJSON."""
    conn = sqlite3.connect(gpkg_path)
    row  = conn.execute(
        "SELECT geom FROM anomalia WHERE geom IS NOT NULL LIMIT 1"
    ).fetchone()
    conn.close()

    if not row:
        return None
    return _parse_gpkg_geometry(row[0])


def _parse_gpkg_geometry(blob: bytes) -> dict:
    """
    Parsea un blob de geometría GPKG → dict GeoJSON.
    Formato: 2 magic + 1 version + 1 flags + 4 srs_id + [envelope] + WKB
    """
    flags    = blob[3]
    env_type = (flags >> 1) & 0x07
    env_len  = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get(env_type, 0)
    wkb      = blob[8 + env_len:]
    return _wkb_to_geojson(wkb)


def _wkb_to_geojson(wkb: bytes) -> dict:
    """Convierte WKB (Polygon o MultiPolygon) a dict GeoJSON."""
    bo       = "<" if wkb[0] == 1 else ">"
    wkb_type = struct.unpack_from(bo + "I", wkb, 1)[0]

    # Descartar coordenada Z si la tiene (wkb_type >= 1000)
    has_z = wkb_type > 1000
    coord_size = 24 if has_z else 16
    base_type  = wkb_type % 1000

    if base_type == 3:      # Polygon
        return _parse_polygon(wkb, bo, 5, coord_size)
    elif base_type == 6:    # MultiPolygon → usar primer anillo
        n_polys = struct.unpack_from(bo + "I", wkb, 5)[0]
        if n_polys == 0:
            raise ValueError("MultiPolygon vacío")
        # Saltar encabezado del primer sub-polígono (1 byte_order + 4 type)
        return _parse_polygon(wkb, bo, 9 + 5, coord_size)
    else:
        raise ValueError(f"Tipo WKB no soportado: {wkb_type} (se esperaba Polygon)")


def _parse_polygon(wkb: bytes, bo: str, offset: int, coord_size: int) -> dict:
    n_rings = struct.unpack_from(bo + "I", wkb, offset)[0]
    offset += 4
    rings = []
    for _ in range(n_rings):
        n_pts = struct.unpack_from(bo + "I", wkb, offset)[0]
        offset += 4
        coords = []
        for _ in range(n_pts):
            x, y = struct.unpack_from(bo + "dd", wkb, offset)
            coords.append([x, y])
            offset += coord_size
        rings.append(coords)
    return {"type": "Polygon", "coordinates": rings}

# ── Cálculo de masa SO₂ ───────────────────────────────────────────────────────

def calculate_mass(tif_path: Path, polygon: dict) -> dict | None:
    """
    Enmascara el raster al polígono y calcula la masa de SO₂ en toneladas.
    """
    with rasterio.open(tif_path) as src:
        try:
            masked, transform = rio_mask(
                src, [polygon], crop=True, filled=True, nodata=NODATA
            )
        except Exception as e:
            print(f"  Error enmascarando raster: {e}")
            return None
        res_lon = abs(src.transform.a)
        res_lat = abs(src.transform.e)

    data = masked[0].astype(float)
    rows, cols = data.shape

    # Grilla de coordenadas
    lons = transform.c + np.arange(cols) * transform.a + transform.a / 2
    lats = transform.f + np.arange(rows) * transform.e - abs(transform.e) / 2
    lon_grid, lat_grid = np.meshgrid(lons, lats)

    valid = (data > NODATA + 1.0) & np.isfinite(data) & (data > 0)

    if not np.any(valid):
        print("  Sin píxeles SO₂ válidos dentro del polígono.")
        return {"so2_tons": 0.0, "max_du": 0.0, "plume_pixels": 0,
                "plume_km2": 0.0, "centroid_lat": None, "centroid_lon": None}

    # Área real por píxel (m²), corregida por latitud
    area_grid = (
        np.radians(res_lat) * 6_371_000.0 *
        np.radians(res_lon) * 6_371_000.0 *
        np.abs(np.cos(np.radians(lat_grid)))
    )

    vals    = data[valid]
    areas   = area_grid[valid]
    lats_v  = lat_grid[valid]
    lons_v  = lon_grid[valid]

    mass_g   = vals * DU_TO_G_PER_M2 * areas
    total_g  = float(np.sum(mass_g))
    total_m2 = float(np.sum(areas))

    c_lat = float(np.sum(lats_v * mass_g) / total_g) if total_g > 0 else None
    c_lon = float(np.sum(lons_v * mass_g) / total_g) if total_g > 0 else None

    result = {
        "so2_tons":     round(total_g / 1e6, 2),
        "max_du":       round(float(vals.max()), 3),
        "plume_pixels": int(np.sum(valid)),
        "plume_km2":    round(total_m2 / 1e6, 1),
        "centroid_lat": round(c_lat, 4) if c_lat is not None else None,
        "centroid_lon": round(c_lon, 4) if c_lon is not None else None,
    }
    print(
        f"  Masa: {result['so2_tons']:.1f} t SO₂  |  "
        f"max: {result['max_du']:.2f} DU  |  "
        f"{result['plume_pixels']} px  |  "
        f"{result['plume_km2']:.0f} km²"
    )
    return result

# ── Base de datos ─────────────────────────────────────────────────────────────

def save_to_db(conn: sqlite3.Connection, date_str: str,
               volcano: str, metrics: dict) -> None:
    conn.execute("""
        INSERT OR REPLACE INTO so2_measurements
        (date, volcano, so2_tons, max_du, plume_pixels, plume_km2,
         centroid_lat, centroid_lon, data_ok)
        VALUES (?,?,?,?,?,?,?,?,1)
    """, (date_str, volcano,
          metrics["so2_tons"], metrics["max_du"],
          metrics["plume_pixels"], metrics["plume_km2"],
          metrics.get("centroid_lat"), metrics.get("centroid_lon")))
    conn.commit()

# ── JSON del visor (90 días) ──────────────────────────────────────────────────

def rebuild_json(conn: sqlite3.Connection, volcanoes: list) -> None:
    cutoff = (date.today() - timedelta(days=HISTORY_DAYS)).isoformat()
    result = {"updated": date.today().isoformat(), "volcanoes": {}}

    for v in volcanoes:
        rows = conn.execute("""
            SELECT date, so2_tons, max_du, plume_pixels, plume_km2,
                   centroid_lat, centroid_lon, data_ok
            FROM so2_measurements
            WHERE volcano=? AND date>=?
            ORDER BY date ASC
        """, (v["name"], cutoff)).fetchall()

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

        result["volcanoes"][v["name"]] = {
            "lat": v["lat"], "lon": v["lon"], "history": history
        }

    JSON_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"  JSON del visor actualizado: {JSON_PATH.name}")

# ── GeoJSON de pluma ──────────────────────────────────────────────────────────

def save_plume_geojson(date_str: str, volcano: str,
                       metrics: dict, polygon: dict) -> None:
    PLUME_DIR.mkdir(parents=True, exist_ok=True)
    plume_file = PLUME_DIR / f"{date_str.replace('-','')}.json"

    # Mantener detecciones de otros volcanes para la misma fecha
    existing_features = []
    if plume_file.exists():
        data = json.loads(plume_file.read_text())
        existing_features = [
            f for f in data.get("features", [])
            if f["properties"]["volcano"] != volcano
        ]

    features = existing_features
    if polygon and metrics["so2_tons"] > 0:
        features.append({
            "type": "Feature",
            "properties": {
                "volcano":   volcano,
                "so2_tons":  metrics["so2_tons"],
                "max_du":    metrics["max_du"],
                "plume_km2": metrics["plume_km2"],
                "source":    "manual",
            },
            "geometry": polygon,
        })

    plume_file.write_text(json.dumps(
        {"type": "FeatureCollection", "date": date_str, "features": features},
        ensure_ascii=False, separators=(",", ":")
    ))
    print(f"  GeoJSON de pluma: {plume_file.name}")

# ── Búsqueda de volcán ────────────────────────────────────────────────────────

def find_volcano(volcanoes: list, query: str) -> dict | None:
    q = query.lower().strip()
    for v in volcanoes:
        if v["name"].lower() == q:
            return v
    matches = [v for v in volcanoes if q in v["name"].lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        print(f"Coincidencias múltiples: {[m['name'] for m in matches]}")
    else:
        print(f"Volcán '{query}' no encontrado.")
    return None

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print("Uso: python scripts/save_polygon.py YYYY-MM-DD 'Nombre Volcán'")
        sys.exit(1)

    date_str     = sys.argv[1]
    volcano_name = " ".join(sys.argv[2:])

    with open(GJ_PATH, encoding="utf-8") as f:
        gj = json.load(f)
    volcanoes = [
        {"name": feat["properties"]["Name"],
         "lat":  feat["properties"]["lat"],
         "lon":  feat["properties"]["lon"]}
        for feat in gj["features"]
    ]

    v = find_volcano(volcanoes, volcano_name)
    if v is None:
        sys.exit(1)

    ds        = date_str.replace("-", "")
    safe_name = v["name"].replace(" ", "_").replace("/", "-")
    gpkg_path = QGIS_DIR / f"{ds}_{safe_name}.gpkg"
    tif_path  = QGIS_DIR / f"so2_l2_{ds}.tif"

    print(f"\nGuardando anomalía  {v['name']}  ·  {date_str}")
    print("─" * 55)

    # Verificar archivos
    for path, label in [(gpkg_path, "GeoPackage"), (tif_path, "GeoTIFF")]:
        if not path.exists():
            print(f"  {label} no encontrado: {path.name}")
            if label == "GeoPackage":
                print(f"  Ejecuta primero: python scripts/prepare_day.py {date_str} '{v['name']}'")
            sys.exit(1)

    # Leer polígono
    polygon = read_polygon(gpkg_path)
    if polygon is None:
        print("  Sin polígono en la capa 'Anomalía SO₂'.")
        print("  En QGIS: selecciona la capa → activa edición → digitaliza → guarda (Ctrl+S).")
        sys.exit(1)

    n_vertices = len(polygon["coordinates"][0])
    print(f"  Polígono leído: {n_vertices} vértices")

    # Calcular masa
    metrics = calculate_mass(tif_path, polygon)
    if metrics is None:
        sys.exit(1)

    # Guardar en DB
    conn = sqlite3.connect(DB_PATH)
    save_to_db(conn, date_str, v["name"], metrics)

    # Reconstruir JSON del visor
    rebuild_json(conn, volcanoes)
    conn.close()

    # Guardar GeoJSON de pluma
    save_plume_geojson(date_str, v["name"], metrics, polygon)

    print(f"""
✓  {v['name']}  ·  {date_str}  →  {metrics['so2_tons']:.1f} t SO₂

Para publicar en el visor web:
    git add data/so2_history.db data/so2_stats.json data/plumes/
    git commit -m "SO2 manual {date_str} {v['name']}: {metrics['so2_tons']:.0f} t"
    git push
""")


if __name__ == "__main__":
    main()
