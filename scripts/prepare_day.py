"""
prepare_day.py  <YYYY-MM-DD> <Nombre Volcán>

Descarga datos L2 TROPOMI SO₂ desde Copernicus Dataspace, aplica QA y
sustracción de fondo espacial, y genera un proyecto QGIS (.qgz) listo
para digitalizar la anomalía manualmente.

Requisitos: rasterio, numpy, netcdf4, requests  (entorno so2-wind)

Credenciales necesarias (registro gratuito en dataspace.copernicus.eu):
    CDSE_USER   tu email
    CDSE_PASS   tu contraseña

Uso:
    python scripts/prepare_day.py 2026-02-08 Lascar
    python scripts/prepare_day.py 2026-04-26 "Lascar"

Salida:
    data/qgis/so2_l2_YYYYMMDD.tif   ← anomalía SO₂ en DU (L2, con fondo sustraído)
    data/qgis/YYYYMMDD_Nombre.gpkg  ← capa vacía "Anomalía" + volcanes
    data/qgis/YYYYMMDD_Nombre.qgz   ← proyecto QGIS listo para abrir
"""

import json
import sqlite3
import struct
import sys
import uuid
import zipfile
from datetime import date, datetime
from pathlib import Path

# ── Rutas ─────────────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).parent.parent
GJ_PATH   = REPO_ROOT / "data" / "volcanoes_ovdas_44.geojson"
QGIS_DIR  = REPO_ROOT / "data" / "qgis"
NODATA    = -9999.0   # valor nodata del GeoTIFF L2 generado por process_l2_so2.py

# ── Pipeline L2 ───────────────────────────────────────────────────────────────

def prepare_l2_raster(date_str: str, volcano_name: str) -> Path:
    """
    Descarga datos L2 desde CDSE y procesa la anomalía SO₂.
    Retorna la ruta del GeoTIFF resultante.
    """
    # Importación local: evita depender de netCDF4 si no se usa este módulo
    from fetch_l2_so2 import fetch
    from process_l2_so2 import process

    ds_flat  = date_str.replace("-", "")
    tif_path = QGIS_DIR / f"so2_l2_{ds_flat}.tif"

    if tif_path.exists():
        print(f"  GeoTIFF L2 ya existe, reutilizando: {tif_path.name}")
        return tif_path

    print("  Paso 1/2 — Descargando datos L2 desde Copernicus Dataspace…")
    files = fetch(date_str)
    if not files:
        raise RuntimeError(
            f"No se encontraron datos L2 para {date_str}.\n"
            "Verifica las credenciales CDSE_USER / CDSE_PASS y que la fecha "
            "tenga datos disponibles (NRTI: disponible ~3h después de la pasada)."
        )

    print("\n  Paso 2/2 — Procesando L2 (QA + sustracción de fondo)…")
    return process(date_str, volcano_name)

# ── GeoPackage (sqlite3, sin dependencias extra) ──────────────────────────────

def _gpkg_point_blob(lon: float, lat: float, srs_id: int = 4326) -> bytes:
    """GPKG geometry header + WKB Point (little-endian)."""
    header = b"GP\x00\x01" + struct.pack("<i", srs_id)
    wkb    = b"\x01" + struct.pack("<Idd", 1, lon, lat)
    return header + wkb

def create_gpkg(gpkg_path: Path, volcanoes: list) -> None:
    if gpkg_path.exists():
        gpkg_path.unlink()

    conn = sqlite3.connect(gpkg_path)
    conn.execute("PRAGMA application_id = 1196444487")
    conn.execute("PRAGMA user_version   = 10300")

    conn.executescript("""
        CREATE TABLE gpkg_spatial_ref_sys (
            srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
            organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
            definition TEXT NOT NULL, description TEXT
        );
        INSERT INTO gpkg_spatial_ref_sys VALUES
          ('WGS 84', 4326, 'EPSG', 4326,
           'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
           'WGS 84 geographic'),
          ('Undefined geographic', 0,  'NONE', 0,  'undefined', ''),
          ('Undefined Cartesian',  -1, 'NONE', -1, 'undefined', '');

        CREATE TABLE gpkg_contents (
            table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
            identifier TEXT, description TEXT DEFAULT '',
            last_change DATETIME NOT NULL
                DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            min_x REAL, min_y REAL, max_x REAL, max_y REAL, srs_id INTEGER
        );
        CREATE TABLE gpkg_geometry_columns (
            table_name TEXT NOT NULL, column_name TEXT NOT NULL,
            geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
            z TINYINT NOT NULL, m TINYINT NOT NULL,
            CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name)
        );
        CREATE TABLE gpkg_extensions (
            table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL,
            definition TEXT NOT NULL, scope TEXT NOT NULL,
            CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name)
        );

        -- Capa: polígono vacío para digitalizar la anomalía
        CREATE TABLE anomalia (
            fid   INTEGER PRIMARY KEY AUTOINCREMENT,
            geom  BLOB,
            notas TEXT
        );
        INSERT INTO gpkg_contents VALUES
          ('anomalia','features','Anomalía SO₂','Polígono de la anomalía volcánica',
           strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL,NULL,NULL,NULL, 4326);
        INSERT INTO gpkg_geometry_columns VALUES
          ('anomalia','geom','POLYGON',4326,0,0);

        -- Capa: puntos de volcanes OVDAS
        CREATE TABLE volcanes (
            fid    INTEGER PRIMARY KEY AUTOINCREMENT,
            geom   BLOB,
            nombre TEXT,
            lat    REAL,
            lon    REAL
        );
        INSERT INTO gpkg_contents VALUES
          ('volcanes','features','Volcanes OVDAS','Volcanes monitoreados OVDAS',
           strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL,NULL,NULL,NULL, 4326);
        INSERT INTO gpkg_geometry_columns VALUES
          ('volcanes','geom','POINT',4326,0,0);
    """)

    for v in volcanoes:
        conn.execute(
            "INSERT INTO volcanes (geom, nombre, lat, lon) VALUES (?,?,?,?)",
            (_gpkg_point_blob(v["lon"], v["lat"]), v["name"], v["lat"], v["lon"])
        )

    conn.commit()
    conn.close()
    print(f"  GeoPackage creado: {gpkg_path.name}")

# ── Proyecto QGIS (.qgs dentro de .qgz) ──────────────────────────────────────

_WGS84_WKT = (
    'GEOGCRS["WGS 84",'
    'DATUM["World Geodetic System 1984",'
    'ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],'
    'PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],'
    'CS[ellipsoidal,2],'
    'AXIS["geodetic latitude (Lat)",north,ORDER[1],ANGLEUNIT["degree",0.0174532925199433]],'
    'AXIS["geodetic longitude (Lon)",east,ORDER[2],ANGLEUNIT["degree",0.0174532925199433]],'
    'ID["EPSG",4326]]'
)

def _srs_xml(indent="      "):
    return f"""{indent}<spatialrefsys nativeFormat="Wkt">
{indent}  <wkt>{_WGS84_WKT}</wkt>
{indent}  <proj4>+proj=longlat +datum=WGS84 +no_defs</proj4>
{indent}  <srsid>3452</srsid><srid>4326</srid>
{indent}  <authid>EPSG:4326</authid>
{indent}  <description>WGS 84</description>
{indent}  <projectionacronym>longlat</projectionacronym>
{indent}  <ellipsoidacronym>EPSG:7030</ellipsoidacronym>
{indent}  <geographicflag>true</geographicflag>
{indent}</spatialrefsys>"""

# Paleta SO₂: valor DU → R,G,B,A
_RAMP = [
    (0.00,  255, 255, 255,   0),
    (0.10,  200, 210, 255, 180),
    (0.20,  120, 160, 220, 220),
    (0.40,   60, 190, 200, 240),
    (0.70,   60, 200, 120, 255),
    (1.00,  230, 200,  50, 255),
    (2.00,  240, 140,  30, 255),
    (3.50,  239,  68,  68, 255),
    (6.00,  200,  20, 200, 255),
    (10.0,  255,   0,   0, 255),
]

def generate_qgz(qgz_path: Path, tif_path: Path, gpkg_path: Path,
                 v_lat: float, v_lon: float,
                 volcano_name: str, date_str: str) -> None:

    rid = "so2_"      + uuid.uuid4().hex[:8]
    aid = "anomalia_" + uuid.uuid4().hex[:8]
    vid = "volcanes_" + uuid.uuid4().hex[:8]

    delta = 2.0
    x1, y1 = v_lon - delta, v_lat - delta
    x2, y2 = v_lon + delta, v_lat + delta

    tif_abs  = str(tif_path.resolve()).replace("\\", "/")
    gpkg_abs = str(gpkg_path.resolve()).replace("\\", "/")

    ramp_items = "\n".join(
        f'              <item alpha="{a}" value="{v}" label="{v} DU"'
        f' color="#{r:02x}{g:02x}{b:02x}"/>'
        for v, r, g, b, a in _RAMP
    )

    qgs = f"""<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.40.7-Bratislava" saveDateTime="{datetime.utcnow().isoformat()}">
  <homePath path=""/>
  <title>SO₂ {date_str} — {volcano_name}</title>
  <autotransaction active="0"/>
  <evaluateDefaultValues active="0"/>
  <trust active="0"/>
  <projectCrs>
{_srs_xml("    ")}
  </projectCrs>

  <layer-tree-group>
    <custom-order enabled="0"/>
    <layer-tree-layer id="{aid}" name="Anomalía SO₂" checked="Qt::Checked"
      source="{gpkg_abs}|layername=anomalia" providerKey="ogr"/>
    <layer-tree-layer id="{vid}" name="Volcanes OVDAS" checked="Qt::Checked"
      source="{gpkg_abs}|layername=volcanes" providerKey="ogr"/>
    <layer-tree-layer id="{rid}" name="SO₂ {date_str}" checked="Qt::Checked"
      source="{tif_abs}" providerKey="gdal"/>
  </layer-tree-group>

  <mapcanvas name="theMapCanvas" annotationsVisible="1">
    <units>degrees</units>
    <extent><xmin>{x1}</xmin><ymin>{y1}</ymin><xmax>{x2}</xmax><ymax>{y2}</ymax></extent>
    <rotation>0</rotation>
    <destinationsrs>
{_srs_xml("      ")}
    </destinationsrs>
    <rendermaptile>0</rendermaptile>
  </mapcanvas>

  <projectlayers>

    <!-- ── Raster SO₂ ── -->
    <maplayer type="raster" autoRefreshEnabled="0">
      <id>{rid}</id>
      <datasource>{tif_abs}</datasource>
      <layername>SO₂ {date_str}</layername>
      <srs>{_srs_xml("        ")}</srs>
      <noData><noDataList bandNo="1" useSrcNoData="1"/></noData>
      <pipe>
        <provider>
          <resampling enabled="false" zoomedInResamplingMethod="nearestNeighbour"
            zoomedOutResamplingMethod="nearestNeighbour" maxOversampling="2"/>
        </provider>
        <rasterrenderer type="singlebandpseudocolor" band="1"
            opacity="0.85" nodataColor="">
          <rasterTransparency/>
          <rastershader>
            <colorrampshader colorRampType="INTERPOLATED" classificationMode="2"
                clip="0" minimumValue="0" maximumValue="10">
{ramp_items}
            </colorrampshader>
          </rastershader>
        </rasterrenderer>
        <brightnesscontrast brightness="0" contrast="0" gamma="1"/>
        <rasterresampler maxOversampling="2"/>
      </pipe>
    </maplayer>

    <!-- ── Volcanes OVDAS ── -->
    <maplayer type="vector" geometry="Point" autoRefreshEnabled="0">
      <id>{vid}</id>
      <datasource>{gpkg_abs}|layername=volcanes</datasource>
      <layername>Volcanes OVDAS</layername>
      <srs>{_srs_xml("        ")}</srs>
      <vectorjoins/>
      <layerGeometryType>0</layerGeometryType>
      <renderer-v2 type="singleSymbol" forceraster="0">
        <symbols>
          <symbol type="marker" name="0" clip_to_extent="1" alpha="1">
            <layer class="SimpleMarker" pass="0" enabled="1" locked="0">
              <Option type="Map">
                <Option name="color"          type="QString" value="231,113,72,255"/>
                <Option name="name"           type="QString" value="triangle"/>
                <Option name="outline_color"  type="QString" value="35,35,35,255"/>
                <Option name="outline_width"  type="QString" value="0.4"/>
                <Option name="size"           type="QString" value="4"/>
                <Option name="size_unit"      type="QString" value="MM"/>
              </Option>
            </layer>
          </symbol>
        </symbols>
      </renderer-v2>
      <labeling type="simple">
        <settings>
          <text-style fontFamily="Arial" fontSize="8" textColor="255,255,255,255"
            textOpacity="1" fontItalic="0" fontBold="0"
            namedStyle="Regular" fieldName="nombre" isExpression="0"/>
          <text-buffer bufferDraw="1" bufferSize="1" bufferColor="0,0,0,255" bufferOpacity="0.7"/>
          <placement placement="2" offsetType="0" dist="2" distUnits="MM"/>
          <rendering scaleVisibility="1" scaleMin="1" scaleMax="10000000"
            minFeatureSize="0"/>
        </settings>
      </labeling>
    </maplayer>

    <!-- ── Anomalía SO₂ (vacía, lista para digitalizar) ── -->
    <maplayer type="vector" geometry="Polygon" autoRefreshEnabled="0">
      <id>{aid}</id>
      <datasource>{gpkg_abs}|layername=anomalia</datasource>
      <layername>Anomalía SO₂</layername>
      <srs>{_srs_xml("        ")}</srs>
      <vectorjoins/>
      <layerGeometryType>2</layerGeometryType>
      <renderer-v2 type="singleSymbol" forceraster="0">
        <symbols>
          <symbol type="fill" name="0" clip_to_extent="1" alpha="1">
            <layer class="SimpleFill" pass="0" enabled="1" locked="0">
              <Option type="Map">
                <Option name="color"         type="QString" value="251,191,36,70"/>
                <Option name="outline_color" type="QString" value="251,191,36,255"/>
                <Option name="outline_style" type="QString" value="solid"/>
                <Option name="outline_width" type="QString" value="0.8"/>
                <Option name="style"         type="QString" value="solid"/>
              </Option>
            </layer>
          </symbol>
        </symbols>
      </renderer-v2>
    </maplayer>

  </projectlayers>

  <layerorder>
    <layer id="{aid}"/>
    <layer id="{vid}"/>
    <layer id="{rid}"/>
  </layerorder>

  <snapping-settings enabled="1" mode="2" type="1" tolerance="12" unit="1"
    maxScale="0" minScale="0" self-snapping="0" intersectionSnapping="0"
    scaleDependencyMode="0" maxScaleEnabled="0" minScaleEnabled="0">
    <individual-layer-settings/>
  </snapping-settings>

  <relations/>
  <properties/>
  <dataDefinedServerProperties/>
  <visibility-presets/>
  <transformContext/>
  <projectMetadata>
    <title>SO₂ {date_str} — {volcano_name}</title>
    <creation>{datetime.utcnow().isoformat()}</creation>
  </projectMetadata>
</qgis>
"""

    # Empaquetar en .qgz
    qgs_name = qgz_path.stem + ".qgs"
    with zipfile.ZipFile(qgz_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(qgs_name, qgs.encode("utf-8"))

    print(f"  Proyecto generado: {qgz_path.name}")

# ── Búsqueda de volcán ────────────────────────────────────────────────────────

def find_volcano(volcanoes: list, query: str) -> dict | None:
    q = query.lower().strip()
    # Coincidencia exacta primero
    for v in volcanoes:
        if v["name"].lower() == q:
            return v
    # Coincidencia parcial
    matches = [v for v in volcanoes if q in v["name"].lower()]
    if len(matches) == 1:
        print(f"  Volcán encontrado: {matches[0]['name']}")
        return matches[0]
    if len(matches) > 1:
        print(f"Coincidencias múltiples: {[m['name'] for m in matches]}")
        print("Especifica el nombre completo.")
        return None
    print(f"Volcán '{query}' no encontrado.")
    print(f"Disponibles (primeros 10): {[v['name'] for v in volcanoes[:10]]}")
    return None

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print("Uso: python scripts/prepare_day.py YYYY-MM-DD 'Nombre Volcán'")
        sys.exit(1)

    date_str     = sys.argv[1]
    volcano_name = " ".join(sys.argv[2:])

    try:
        d = date.fromisoformat(date_str)
    except ValueError:
        print(f"Fecha inválida: {date_str}  (formato esperado: YYYY-MM-DD)")
        sys.exit(1)

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

    QGIS_DIR.mkdir(parents=True, exist_ok=True)
    gpkg_path = QGIS_DIR / f"{ds}_{safe_name}.gpkg"
    qgz_path  = QGIS_DIR / f"{ds}_{safe_name}.qgz"

    print(f"\nPreparando  {v['name']}  ·  {date_str}")
    print("─" * 55)

    tif_path = prepare_l2_raster(date_str, v["name"])

    create_gpkg(gpkg_path, volcanoes)
    generate_qgz(qgz_path, tif_path, gpkg_path, v["lat"], v["lon"], v["name"], date_str)

    print(f"""
✓ Listo. El raster usa datos L2 TROPOMI con sustracción de fondo espacial.
  Los valores en DU representan la anomalía sobre el fondo regional.

Pasos siguientes:
  1. Abre en QGIS:  {qgz_path}
  2. Selecciona la capa "Anomalía SO₂" en el panel de capas
  3. Layer → Toggle Editing  (o ícono lápiz en barra de herramientas)
  4. Digitaliza el polígono sobre la anomalía visible (valores > 0 DU)
  5. Guarda la capa: Ctrl+S
  6. Cierra QGIS
  7. Ejecuta: python scripts/save_polygon.py {date_str} "{v['name']}"
""")


if __name__ == "__main__":
    main()
