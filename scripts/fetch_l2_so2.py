"""
fetch_l2_so2.py  <YYYY-MM-DD>  [NRTI|OFFL]

Descarga archivos Sentinel-5P TROPOMI L2 SO₂ que cubren Chile desde
Copernicus Dataspace (CDSE). Requiere registro gratuito en
https://dataspace.copernicus.eu/

Credenciales en variables de entorno:
    CDSE_USER   tu email de registro
    CDSE_PASS   tu contraseña

Salida:
    data/l2_cache/YYYY-MM-DD/*.nc   (archivos L2, ~300-500 MB c/u)
    data/l2_cache/YYYY-MM-DD/files.json   (manifiesto de rutas)

Uso:
    python scripts/fetch_l2_so2.py 2026-05-10
    python scripts/fetch_l2_so2.py 2026-05-10 OFFL   # mayor latencia, mayor calidad
"""

import json
import os
import sys
import time
from pathlib import Path

import requests

REPO_ROOT  = Path(__file__).parent.parent
CACHE_DIR  = REPO_ROOT / "data" / "l2_cache"

# Bbox Chile con margen generoso (las órbitas son swaths anchos)
CHILE_BBOX = (-82, -58, -60, -15)   # west, south, east, north

CDSE_TOKEN_URL = (
    "https://identity.dataspace.copernicus.eu/auth/realms/CDSE"
    "/protocol/openid-connect/token"
)
CDSE_CATALOGUE = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products"
CDSE_DOWNLOAD  = "https://download.dataspace.copernicus.eu/odata/v1/Products"


# ── Autenticación ──────────────────────────────────────────────────────────────

def _get_token(user: str, passwd: str) -> tuple[str, float]:
    """Obtiene access token CDSE. Retorna (token, expiry_timestamp)."""
    r = requests.post(
        CDSE_TOKEN_URL,
        data={
            "client_id":  "cdse-public",
            "grant_type": "password",
            "username":   user,
            "password":   passwd,
        },
        timeout=30,
    )
    r.raise_for_status()
    expires_in = r.json().get("expires_in", 600)
    return r.json()["access_token"], time.time() + expires_in - 60  # 1 min margen


def _refresh_if_needed(
    token: str, expiry: float, user: str, passwd: str
) -> tuple[str, float]:
    if time.time() > expiry:
        print("  Refrescando token CDSE…")
        return _get_token(user, passwd)
    return token, expiry


# ── Búsqueda en catálogo ───────────────────────────────────────────────────────

def search_products(date_str: str, mode: str = "NRTI") -> list[dict]:
    """
    Busca productos S5P L2 SO₂ que intersecten Chile para la fecha dada.
    mode: 'NRTI' (disponible ~3h tras adquisición) o 'OFFL' (~3-5 días).
    """
    w, s, e, n = CHILE_BBOX
    # WKT polygon para OData.CSC.Intersects (sentido anti-horario)
    poly = f"POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))"

    filt = (
        f"Collection/Name eq 'SENTINEL-5P' and "
        f"Attributes/OData.CSC.StringAttribute/any("
        f"  att:att/Name eq 'productType' and "
        f"  att/OData.CSC.StringAttribute/Value eq 'L2__SO2___') and "
        f"Attributes/OData.CSC.StringAttribute/any("
        f"  att:att/Name eq 'processingMode' and "
        f"  att/OData.CSC.StringAttribute/Value eq '{mode}') and "
        f"ContentDate/Start ge {date_str}T00:00:00.000Z and "
        f"ContentDate/Start le {date_str}T23:59:59.999Z and "
        f"OData.CSC.Intersects(area=geography'SRID=4326;{poly}')"
    )

    r = requests.get(
        CDSE_CATALOGUE,
        params={"$filter": filt, "$top": 30, "$orderby": "ContentDate/Start"},
        timeout=60,
    )
    r.raise_for_status()
    return r.json().get("value", [])


# ── Descarga ───────────────────────────────────────────────────────────────────

def _download_file(product_id: str, token: str, dest: Path) -> None:
    url = f"{CDSE_DOWNLOAD}({product_id})/$value"
    headers = {"Authorization": f"Bearer {token}"}

    tmp = dest.with_suffix(".tmp")
    with requests.get(url, headers=headers, stream=True, timeout=600) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        done  = 0
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):   # 1 MB chunks
                f.write(chunk)
                done += len(chunk)
                if total:
                    print(
                        f"  {dest.name}: {done/1e6:.0f}/{total/1e6:.0f} MB"
                        f" ({done/total*100:.0f}%)    ",
                        end="\r",
                    )
    tmp.rename(dest)
    print(f"  {dest.name}: OK ({done/1e6:.0f} MB)          ")


# ── Main ───────────────────────────────────────────────────────────────────────

def fetch(date_str: str, mode: str = "NRTI") -> list[str]:
    """
    API pública: descarga y retorna lista de rutas de archivos L2.
    Se puede importar y llamar desde otros scripts.
    """
    user   = os.environ.get("CDSE_USER", "")
    passwd = os.environ.get("CDSE_PASS", "")
    if not user or not passwd:
        raise EnvironmentError(
            "Define CDSE_USER y CDSE_PASS con tus credenciales de "
            "https://dataspace.copernicus.eu/"
        )

    out_dir = CACHE_DIR / date_str
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\nBuscando L2 SO₂ ({mode}) para {date_str}…")
    products = search_products(date_str, mode)

    # Fallback automático: si NRTI no está disponible aún, probar OFFL
    if not products and mode == "NRTI":
        print("  Sin productos NRTI. Probando OFFL (mayor latencia)…")
        products = search_products(date_str, "OFFL")

    if not products:
        print("  Sin productos disponibles para esta fecha.")
        return []

    print(f"  Encontrados: {len(products)} granulos")
    token, expiry = _get_token(user, passwd)

    paths = []
    for p in products:
        name = p["Name"]
        pid  = p["Id"]
        dest = out_dir / f"{name}.nc"

        if dest.exists():
            print(f"  {dest.name}: ya descargado.")
        else:
            token, expiry = _refresh_if_needed(token, expiry, user, passwd)
            _download_file(pid, token, dest)

        paths.append(str(dest))

    # Guardar manifiesto para otros scripts
    manifest = out_dir / "files.json"
    manifest.write_text(json.dumps(paths, indent=2, ensure_ascii=False))
    print(f"\n✓ {len(paths)} archivo(s) disponibles → {out_dir}")
    return paths


def main() -> None:
    if len(sys.argv) < 2:
        print("Uso: python scripts/fetch_l2_so2.py YYYY-MM-DD [NRTI|OFFL]")
        sys.exit(1)

    date_str = sys.argv[1]
    mode     = sys.argv[2].upper() if len(sys.argv) > 2 else "NRTI"

    paths = fetch(date_str, mode)
    if not paths:
        sys.exit(1)


if __name__ == "__main__":
    main()
