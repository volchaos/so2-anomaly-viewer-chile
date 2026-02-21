#!/usr/bin/env python
import json
import math
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Tuple, List

import numpy as np
import requests
import xarray as xr
import cfgrib  # noqa: F401

NOMADS_FILTER = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"


@dataclass
class GfsPick:
    run_date: str
    cycle: int
    fhr: int
    valid_dt: datetime
    delta_minutes: float


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _candidate_runs(target_dt: datetime):
    d0 = target_dt.date()
    d1 = (target_dt - timedelta(days=1)).date()
    for d in [d0, d1]:
        ymd = d.strftime("%Y%m%d")
        for cyc in [18, 12, 6, 0]:
            yield ymd, cyc


def _best_gfs_pick(target_dt: datetime, tol_min: int) -> GfsPick:
    best = None
    for ymd, cyc in _candidate_runs(target_dt):
        run_dt = datetime.strptime(ymd, "%Y%m%d").replace(tzinfo=timezone.utc) + timedelta(hours=cyc)
        approx = int(round((target_dt - run_dt).total_seconds() / 3600))
        for fhr in range(max(0, approx - 3), approx + 4):
            valid = run_dt + timedelta(hours=fhr)
            delta = abs((valid - target_dt).total_seconds()) / 60.0
            if delta <= tol_min:
                pick = GfsPick(run_date=ymd, cycle=cyc, fhr=fhr, valid_dt=valid, delta_minutes=delta)
                if best is None or pick.delta_minutes < best.delta_minutes:
                    best = pick

    if best is None:
        for ymd, cyc in _candidate_runs(target_dt):
            run_dt = datetime.strptime(ymd, "%Y%m%d").replace(tzinfo=timezone.utc) + timedelta(hours=cyc)
            approx = int(round((target_dt - run_dt).total_seconds() / 3600))
            for fhr in range(max(0, approx - 12), approx + 13):
                valid = run_dt + timedelta(hours=fhr)
                delta = abs((valid - target_dt).total_seconds()) / 60.0
                pick = GfsPick(run_date=ymd, cycle=cyc, fhr=fhr, valid_dt=valid, delta_minutes=delta)
                if best is None or pick.delta_minutes < best.delta_minutes:
                    best = pick

    return best


def _request_with_retries(session: requests.Session, url: str, params: Dict, timeout: int = 180,
                          max_tries: int = 6) -> requests.Response:
    """
    NOMADS puede devolver 403 si haces muchas requests seguidas.
    Esto mete backoff exponencial con jitter y un User-Agent explícito.
    """
    headers = {
        "User-Agent": "SO2-Anomaly-Check-Chile/1.0 (GitHub Actions; contact: user)",
        "Accept": "*/*",
    }

    last_exc = None
    for attempt in range(1, max_tries + 1):
        try:
            r = session.get(url, params=params, timeout=timeout, headers=headers)
            # 403 / 429 / 5xx -> reintentar
            if r.status_code in (403, 429) or 500 <= r.status_code < 600:
                wait = min(90, (2 ** (attempt - 1)) + (0.25 * attempt))
                # Si es 403, esperamos un poco más para bajar la probabilidad de bloqueo
                if r.status_code == 403:
                    wait = max(wait, 15)
                time.sleep(wait)
                last_exc = RuntimeError(f"NOMADS HTTP {r.status_code}")
                continue

            r.raise_for_status()
            return r

        except Exception as e:
            last_exc = e
            wait = min(90, (2 ** (attempt - 1)) + (0.25 * attempt))
            time.sleep(wait)

    raise RuntimeError(f"Fallo tras {max_tries} intentos: {last_exc}")


def _download_gfs_grib_multilevel(pick: GfsPick, bbox: Dict[str, float], level_mbs: List[int], out_path: Path) -> None:
    """
    Descarga 1 solo GRIB2 recortado a bbox que incluye UGRD/VGRD en varios niveles isobáricos.
    Esto reduce requests (anti-403) frente a 1 request por nivel.
    """
    ymd = pick.run_date
    cyc = f"{pick.cycle:02d}"
    fhr = f"{pick.fhr:03d}"

    file = f"gfs.t{cyc}z.pgrb2.0p25.f{fhr}"
    dir_ = f"/gfs.{ymd}/{cyc}/atmos"

    params = {
        "file": file,
        "dir": dir_,
        "subregion": "",
        "leftlon": str(bbox["leftlon"]),
        "rightlon": str(bbox["rightlon"]),
        "toplat": str(bbox["toplat"]),
        "bottomlat": str(bbox["bottomlat"]),
        "var_UGRD": "on",
        "var_VGRD": "on",
    }

    # Marcamos múltiples niveles en una sola descarga
    for mb in level_mbs:
        params[f"lev_{mb}_mb"] = "on"

    out_path.parent.mkdir(parents=True, exist_ok=True)

    with requests.Session() as session:
        r = _request_with_retries(session, NOMADS_FILTER, params=params, timeout=240, max_tries=6)
        out_path.write_bytes(r.content)


def _open_grib_any(path: Path) -> xr.Dataset:
    """
    Abre el GRIB con cfgrib. Si hay múltiples datasets internos, elige el que tenga u/v.
    """
    try:
        return xr.open_dataset(path, engine="cfgrib")
    except Exception:
        dsets = cfgrib.open_datasets(str(path))
        for ds in dsets:
            if _has_uv(ds):
                return ds
        raise


def _has_uv(ds: xr.Dataset) -> bool:
    keys = set(ds.data_vars.keys())
    return ("u" in keys and "v" in keys) or ("UGRD" in keys and "VGRD" in keys)


def _extract_uv_at_level(ds: xr.Dataset, level_mb: int) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Extrae lat2d, lon2d, u2d, v2d para un nivel isobárico (mb) desde un GRIB multilevel.
    Compatible con nombres de variables y coordenadas comunes de cfgrib.
    """
    lat_name = "latitude" if "latitude" in ds.coords else ("lat" if "lat" in ds.coords else None)
    lon_name = "longitude" if "longitude" in ds.coords else ("lon" if "lon" in ds.coords else None)
    if lat_name is None or lon_name is None:
        raise ValueError("No se encontraron coords lat/lon en el GRIB decodificado.")

    # variables u/v
    if "u" in ds.data_vars and "v" in ds.data_vars:
        u = ds["u"]
        v = ds["v"]
    elif "UGRD" in ds.data_vars and "VGRD" in ds.data_vars:
        u = ds["UGRD"]
        v = ds["VGRD"]
    else:
        raise ValueError("Missing u/v in decoded GRIB.")

    # coord de nivel isobárico
    lvl_coord = None
    for cand in ["isobaricInhPa", "isobaricInPa", "isobaric"]:
        if cand in u.coords:
            lvl_coord = cand
            break
    if lvl_coord is None:
        # a veces viene como dimensión sin coord explícita
        for cand in ["isobaricInhPa", "isobaricInPa", "isobaric"]:
            if cand in u.dims:
                lvl_coord = cand
                break
    if lvl_coord is None:
        raise ValueError("No se encontró coord/dim de nivel isobárico (isobaricInhPa).")

    # Seleccionamos el nivel
    # cfgrib suele usar hPa (inhPa). Para seguridad, convertimos si fuera Pa.
    try:
        u_lvl = u.sel({lvl_coord: level_mb})
        v_lvl = v.sel({lvl_coord: level_mb})
    except Exception:
        # Si el coord está en Pa, probamos *100
        u_lvl = u.sel({lvl_coord: level_mb * 100})
        v_lvl = v.sel({lvl_coord: level_mb * 100})

    # Drop extra dims (time/step/etc.)
    for dim in list(u_lvl.dims):
        if dim not in (lat_name, lon_name):
            u_lvl = u_lvl.isel({dim: 0})
    for dim in list(v_lvl.dims):
        if dim not in (lat_name, lon_name):
            v_lvl = v_lvl.isel({dim: 0})

    lats = ds[lat_name].values
    lons = ds[lon_name].values

    if lats.ndim == 1 and lons.ndim == 1:
        lat2d, lon2d = np.meshgrid(lats, lons, indexing="ij")
    else:
        lat2d, lon2d = lats, lons

    u2d = u_lvl.values.astype(float)
    v2d = v_lvl.values.astype(float)

    # Normaliza lon a [-180,180]
    lon2d = ((lon2d + 180) % 360) - 180

    return lat2d.astype(float), lon2d.astype(float), u2d, v2d


def build_all_levels(run_date: str, target_dt: datetime, cfg: Dict, out_dir: Path) -> None:
    """
    Genera 900/500/250/150 usando UNA descarga por fecha (anti-403).
    """
    bbox = cfg["roi_bbox"]
    tol = int(cfg.get("tolerance_minutes", 90))
    step = int(cfg.get("sampling_step_grid", 2))

    levels = [
        ("900hPa", 900),
        ("500hPa", 500),
        ("250hPa", 250),
        ("150hPa", 150),
    ]
    level_mbs = [mb for _, mb in levels]

    pick = _best_gfs_pick(target_dt, tol)

    out_dir.mkdir(parents=True, exist_ok=True)
    grib_path = out_dir / "_tmp_all_levels.grib2"

    try:
        # 1) 1 sola descarga con 4 niveles
        _download_gfs_grib_multilevel(pick, bbox, level_mbs, grib_path)

        # 2) abrir dataset una vez
        ds = _open_grib_any(grib_path)

        # 3) por cada nivel, extraer, submuestrear y escribir JSON
        for level_key, level_mb in levels:
            try:
                lat2d, lon2d, u2d, v2d = _extract_uv_at_level(ds, level_mb)

                lat2d = lat2d[::step, ::step]
                lon2d = lon2d[::step, ::step]
                u2d = u2d[::step, ::step]
                v2d = v2d[::step, ::step]

                points = []
                for i in range(lat2d.shape[0]):
                    for j in range(lat2d.shape[1]):
                        lat = float(lat2d[i, j])
                        lon = float(lon2d[i, j])
                        u = float(u2d[i, j])
                        v = float(v2d[i, j])
                        if not (math.isfinite(lat) and math.isfinite(lon) and math.isfinite(u) and math.isfinite(v)):
                            continue
                        points.append({"lat": lat, "lon": lon, "u": u, "v": v})

                out = {
                    "meta": {
                        "source": "GFS 0.25 (NOMADS) [multilevel]",
                        "run_date": pick.run_date,
                        "cycle_utc": f"{pick.cycle:02d}Z",
                        "forecast_hour": pick.fhr,
                        "t_target_utc": _iso(target_dt),
                        "t_gfs_valid_utc": _iso(pick.valid_dt),
                        "delta_minutes": float(pick.delta_minutes),
                        "level_key": level_key,
                        "level_mb": level_mb
                    },
                    "points": points
                }

                (out_dir / f"{level_key}.json").write_text(json.dumps(out), encoding="utf-8")

            except Exception as e_lvl:
                out = {
                    "meta": {
                        "source": "GFS 0.25 (NOMADS) [multilevel]",
                        "t_target_utc": _iso(target_dt),
                        "level_key": level_key,
                        "level_mb": level_mb,
                        "error": str(e_lvl)
                    },
                    "points": []
                }
                (out_dir / f"{level_key}.json").write_text(json.dumps(out), encoding="utf-8")

    except Exception as e_all:
        # Si la descarga principal falla (ej 403), dejamos 4 JSON de error (uno por nivel)
        for level_key, level_mb in levels:
            out = {
                "meta": {
                    "source": "GFS 0.25 (NOMADS) [multilevel]",
                    "t_target_utc": _iso(target_dt),
                    "level_key": level_key,
                    "level_mb": level_mb,
                    "error": str(e_all)
                },
                "points": []
            }
            (out_dir / f"{level_key}.json").write_text(json.dumps(out), encoding="utf-8")

    finally:
        try:
            grib_path.unlink(missing_ok=True)
        except Exception:
            pass
