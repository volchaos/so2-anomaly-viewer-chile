#!/usr/bin/env python
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Tuple

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

def _download_gfs_grib(pick: GfsPick, bbox: Dict[str, float], level_spec: Dict[str, str], out_path: Path) -> None:
    # Download a GRIB2 subset containing UGRD/VGRD for the requested level.
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

    params[f"lev_{level_spec['level']}"] = "on"

    r = requests.get(NOMADS_FILTER, params=params, timeout=180)
    r.raise_for_status()
    out_path.write_bytes(r.content)

def _open_grib_any(path: Path) -> xr.Dataset:
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
    return ("u10" in keys and "v10" in keys) or ("u" in keys and "v" in keys) or ("UGRD" in keys and "VGRD" in keys)

def _extract_uv(ds: xr.Dataset) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    lat_name = "latitude" if "latitude" in ds.coords else ("lat" if "lat" in ds.coords else None)
    lon_name = "longitude" if "longitude" in ds.coords else ("lon" if "lon" in ds.coords else None)
    if lat_name is None or lon_name is None:
        raise ValueError("No se encontraron coords lat/lon en el GRIB decodificado.")

    if "u10" in ds.data_vars and "v10" in ds.data_vars:
        u = ds["u10"]; v = ds["v10"]
    elif "u" in ds.data_vars and "v" in ds.data_vars:
        u = ds["u"]; v = ds["v"]
    elif "UGRD" in ds.data_vars and "VGRD" in ds.data_vars:
        u = ds["UGRD"]; v = ds["VGRD"]
    else:
        u = v = None
        for name, da in ds.data_vars.items():
            sn = da.attrs.get("GRIB_shortName")
            if sn in ("10u", "u", "ugrd"):
                u = da
            if sn in ("10v", "v", "vgrd"):
                v = da
        if u is None or v is None:
            raise ValueError("Missing u/v in decoded GRIB.")

    for dim in list(u.dims):
        if dim not in (lat_name, lon_name):
            u = u.isel({dim: 0})
    for dim in list(v.dims):
        if dim not in (lat_name, lon_name):
            v = v.isel({dim: 0})

    lats = ds[lat_name].values
    lons = ds[lon_name].values
    if lats.ndim == 1 and lons.ndim == 1:
        lat2d, lon2d = np.meshgrid(lats, lons, indexing="ij")
    else:
        lat2d, lon2d = lats, lons

    u2d = u.values.astype(float)
    v2d = v.values.astype(float)

    lon2d = ((lon2d + 180) % 360) - 180
    return lat2d.astype(float), lon2d.astype(float), u2d, v2d

def build_level(run_date: str, target_dt: datetime, cfg: Dict, out_dir: Path, level_key: str) -> None:
    bbox = cfg["roi_bbox"]
    levels = cfg["levels"]
    tol = int(cfg.get("tolerance_minutes", 90))
    step = int(cfg.get("sampling_step_grid", 2))

    pick = _best_gfs_pick(target_dt, tol)
    grib_path = out_dir / f"_tmp_{level_key}.grib2"

    _download_gfs_grib(pick, bbox, levels[level_key], grib_path)

    ds = _open_grib_any(grib_path)
    lat2d, lon2d, u2d, v2d = _extract_uv(ds)

    lat2d = lat2d[::step, ::step]
    lon2d = lon2d[::step, ::step]
    u2d = u2d[::step, ::step]
    v2d = v2d[::step, ::step]

    points = []
    for i in range(lat2d.shape[0]):
        for j in range(lat2d.shape[1]):
            lat = float(lat2d[i, j]); lon = float(lon2d[i, j])
            u = float(u2d[i, j]); v = float(v2d[i, j])
            if not (math.isfinite(lat) and math.isfinite(lon) and math.isfinite(u) and math.isfinite(v)):
                continue
            points.append({"lat": lat, "lon": lon, "u": u, "v": v})

    out = {
        "meta": {
            "source": "GFS 0.25 (NOMADS)",
            "run_date": pick.run_date,
            "cycle_utc": f"{pick.cycle:02d}Z",
            "forecast_hour": pick.fhr,
            "t_target_utc": _iso(target_dt),
            "t_gfs_valid_utc": _iso(pick.valid_dt),
            "delta_minutes": float(pick.delta_minutes),
            "level_key": level_key
        },
        "points": points
    }

    (out_dir / f"{level_key}.json").write_text(json.dumps(out), encoding="utf-8")

    try:
        grib_path.unlink(missing_ok=True)
    except Exception:
        pass

def build_all_levels(run_date: str, target_dt: datetime, cfg: Dict, out_dir: Path) -> None:
    for level_key in ["10m", "900hPa", "400hPa", "150hPa"]:
        try:
            build_level(run_date, target_dt, cfg, out_dir, level_key)
        except Exception as e:
            out = {
                "meta": {
                    "source": "GFS 0.25 (NOMADS)",
                    "t_target_utc": _iso(target_dt),
                    "level_key": level_key,
                    "error": str(e)
                },
                "points": []
            }
            (out_dir / f"{level_key}.json").write_text(json.dumps(out), encoding="utf-8")
