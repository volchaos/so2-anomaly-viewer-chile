# SO₂ Anomaly Viewer — Chile

**🌋 [Abrir visor →](https://volchaos.github.io/so2-anomaly-viewer-chile/)**

Visor web interactivo de SO₂ volcánico sobre Chile, basado en datos Sentinel-5P/TROPOMI del servicio EOC Geoservice (DLR). Incluye un monitor de videowall y herramientas de cálculo de masa en el navegador.

---

## Funcionalidades principales

### Visor principal (`index.html`)
- **Capa SO₂ WMS** — TROPOMI L3 diario desde EOC/DLR, con selector de fecha y opacidad
- **Volcanes OVDAS** (44) y volcanes no monitoreados, con etiquetas permanentes zoom-gated
- **Fundiciones** (13) con símbolo diferenciado
- **Límite fronterizo Chile** — Natural Earth 1:10 m (~400 KB, carga local sin dependencia externa)
- **Overlays de viento** opcionales a 5 niveles de presión (10 m, 900 hPa, 500 hPa, 400 hPa, 150 hPa)
- **Fecha predeterminada = ayer** — evita mostrar mapa vacío cuando los datos del día aún no están disponibles (~20:00 UTC)

### Pestaña GIF & NASA
- Generación de GIF animado de SO₂ en el navegador para un volcán y rango de fechas
- Overlays configurables: borde Chile, volcanes OVDAS, fundiciones, leyenda, viento
- Previsualización en tiempo real y descarga directa

### Pestaña Masa SO₂ (`src/masa.js`)
Cálculo interactivo de masa SO₂ directamente en el navegador:
1. Selecciona fecha y carga el raster L2 (`data/qgis/so2_l2_YYYYMMDD.tif`)
2. Dibuja un polígono sobre la pluma con Leaflet.draw
3. Obtiene: masa en toneladas, DU máximo, área km², nº de píxeles, centroide
4. Exporta el resultado como GeoJSON

> Requiere servidor local (`python -m http.server 8080`) y el raster generado por `prepare_day.py`.

### Monitor de videowall (`monitor.html`)
Vista optimizada para TV en portrait (una zona a la vez):

```
monitor.html?zona=norte    # Taapaca → Villarrica/Llaima
monitor.html?zona=sur      # Antuco → Monte Burney
```

- Capa SO₂ WMS a pantalla completa con HUD de información
- Volcanes OVDAS con símbolo diferenciado (sin fundiciones para mayor claridad)
- Etiquetas con halo blanco — legibles sobre mapa claro y sobre SO₂
- Nombres largos abreviados (ej. "Puyehue-Cordón Caulle" → "Puyehue-C.C.")
- Leyenda de capas integrada en el HUD
- Escala SO₂ en DU (bottom-left)
- **Fecha inteligente**: muestra siempre ayer (último dato garantizado); el usuario puede avanzar con → si quiere verificar el día actual
- **Refresco automático**: cada 30 min + refresh programado a las 20:15 UTC (sincronizado con la actualización EOC)
- Ambas zonas comparten traslape en ~37°–40° S (Antuco, Copahue, Llaima, Villarrica visibles en ambas pantallas)

---

## Pipeline L2 (cálculo de masa)

Para usar la pestaña **Masa SO₂** se necesita generar el raster L2 local:

### 1. Credenciales Copernicus Dataspace

Registro gratuito en **[dataspace.copernicus.eu](https://dataspace.copernicus.eu)**. Una vez registrado:

```bash
# Windows
set CDSE_USER=tu@email.com
set CDSE_PASS=tu_contraseña

# Linux / macOS
export CDSE_USER=tu@email.com
export CDSE_PASS=tu_contraseña
```

### 2. Generar raster para una fecha y volcán

```bash
python scripts/prepare_day.py 2026-05-17 Lascar
```

Genera:
- `data/qgis/so2_l2_20260517.tif` — anomalía SO₂ en DU (L2, fondo sustraído)
- `data/qgis/20260517_Lascar.gpkg` — capa vacía para digitalizar en QGIS
- `data/qgis/20260517_Lascar.qgz` — proyecto QGIS listo para abrir

### 3. Flujo de scripts

| Script | Función |
|--------|---------|
| `fetch_l2_so2.py` | Descarga datos L2 desde Copernicus Dataspace |
| `process_l2_so2.py` | Aplica QA y sustracción de fondo espacial |
| `prepare_day.py` | Orquesta fetch + process + genera QGIS project |
| `save_polygon.py` | Exporta polígono digitalizado en QGIS al repositorio |
| `build_gif.py` | Genera GIF animado desde WMS (también disponible en browser) |
| `build_wind_json.py` | Genera JSON de viento desde GFS 0.25° |

---

## Estructura de datos

```
data/
  volcanoes.geojson            # 92 volcanes (Point, EPSG:4326, campo: name)
  volcanoes_ovdas_44.geojson   # 44 volcanes monitoreados OVDAS
  smelters_13.geojson          # 13 fundiciones
  chile_border_10m.geojson     # Límite Chile — Natural Earth 1:10 m
  chile_border.geojson         # Límite Chile — Natural Earth 1:110 m (respaldo)
  wind/YYYY-MM-DD/             # JSON de viento por nivel (generado por GitHub Actions)
  qgis/                        # Rasters L2 y proyectos QGIS (no versionados)
  plumes/                      # GeoJSON de plumas exportadas
src/
  config.js    # URLs WMS, rutas de datos, zoom thresholds
  app.js       # Lógica principal del visor
  masa.js      # Módulo cálculo de masa SO₂ en browser
  gifmaker.js  # Generador de GIF en browser
  validator.js # Validación de datos
```

---

## Configuración (`src/config.js`)

| Parámetro | Valor actual |
|-----------|-------------|
| WMS URL | `https://geoservice.dlr.de/eoc/atmosphere/wms` |
| Capa | `S5P_TROPOMI_L3_P1D_SO2_v2` |
| Zoom etiquetas OVDAS | 6 |
| Zoom etiquetas otros | 9 |

---

## GitHub Actions — viento automático

El workflow `.github/workflows/` genera JSON de viento (GFS 0.25°) diariamente:
- **Ejecución**: 20:10 UTC diario + manual
- **Niveles**: 10 m, 900 hPa, 500 hPa, 400 hPa, 150 hPa
- **Lookback**: últimos 14 días (configurable en `wind_config.json`)
- **Permisos**: Settings → Actions → General → Workflow permissions → Read and write

---

## GitHub Pages

1. Push del repositorio a GitHub
2. Settings → Pages → Source: **Deploy from a branch** → `main` / `/ (root)`
3. El visor queda disponible en `https://<usuario>.github.io/<repositorio>/`
