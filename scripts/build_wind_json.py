#!/usr/bin/env python3
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Tuple, List, Optional

import numpy as np
import requests
import xarray as xr
import cfgrib  # noqa: F401

# 1) NOMADS filter (subset server-side) — rápido pero ventana corta
NOMADS_FILTER = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"

# 2) AWS Open Data (30-day trailing window) — fallback robusto :contentReference[oaicite:1]{index=1}
AWS_BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"


@dataclass
class GfsPick:
    run_date: str   # YYYYMMDD
    cycle: int      # 0/6/12/18
    fhr: int        # forecast hour
    valid_dt: datetime
    delta_minutes: float


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _candidate_runs(target_dt: datetime, days_back: int = 2):
    """
    Generate candidate (ymd, cycle) for target day and previous days.
    days_back=2 is a good balance; AWS can handle further but we keep it small.
    """
    for dd in range(0, days_back + 1):
        d = (target_dt - timedelta(days=dd)).date()
        ymd = d.strftime("%Y%m%d")
        for cyc in [18, 12, 6, 0]:
            yield ymd, cyc


def _probe_nomads_filter_exists(ymd: str, cyc: int, fhr: int) -> bool:
    """
    Quick existence check for NOMADS filter endpoint.
    Uses a lightweight request (small bbox) and one variable/level.
    If directory/file doesn't exist -> usually 404.
    """
    cyc2 = f"{cyc:02d}"
    fhr3 = f"{fhr:03d}"
    file = f"gfs.t{cyc2}z.pgrb2.0p25.f{fhr3}"
    dir_ = f"/gfs.{ymd}/{cyc2}/atmos"

    params = {
        "file": file,
        "dir": dir_,
        # tiny bbox to keep response minimal
        "leftlon": "-72",
        "rightlon": "-71",
        "toplat": "-33",
        "bottomlat": "-34",
        "var_UGRD": "on",
        "lev_500_mb": "on",
    }
    try:
        r = requests.get(NOMADS_FILTER, params=params, timeout=45)
        return r.status_code == 200
    except Exception:
        return False


def _best_gfs_pick(target_dt: datetime, tol_min: int) -> GfsPick:
    """
    Choose best pick by delta time, BUT prefer picks that exist on NOMADS if possible.
    If NOMADS availability is spotty, AWS fallback will still work.
    """
    best: Optional[GfsPick] = None
    candidates: List[GfsPick] = []

    # Build candidate picks with time deltas (±12h around approx)
    for ymd, cyc in _candidate_runs(target_dt, days_back=2):
        run_dt = datetime.strptime(ymd, "%Y%m%d").replace(tzinfo=timezone.utc) + timedelta(hours=cyc)
        approx = int(round((target_dt - run_dt).total_seconds() / 3600))
        for fhr in range(max(0, approx - 12), approx + 13):
            valid = run_dt + timedelta(hours=fhr)
            delta = abs((valid - target_dt).total_seconds()) / 60.0
            candidates.append(GfsPick(run_date=ymd, cycle=cyc, fhr=fhr, valid_dt=valid, delta_minutes=delta))

    # Sort by delta time
    candidates.sort(key=lambda p: p.delta_minutes)

    # 1) first try: pick that is within tol AND exists on NOMADS filter
    for p in candidates:
        if p.delta_minutes <= tol_min:
            if _probe_nomads_filter_exists(p.run_date, p.cycle, p.fhr):
                return p

    # 2) otherwise: just take best delta (AWS might still have it)
    best = candidates[0]
    return best


def _download_nomads_subset(pick: GfsPick, bbox: Dict[str, float], level_mb: int, out_path: Path) -> None:
    """
    Download a GRIB2 subset using NOMADS filter (fast when available).
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
        f"lev_{level_mb}_mb": "on",
    }

    r = requests.get(NOMADS_FILTER, params=params, timeout=180)
    r.raise_for_status()
    out_path.write_bytes(r.content)


def _aws_object_url(pick: GfsPick) -> str:
    """
    AWS object URL pattern (Herbie docs show this exact format). :contentReference[oaicite:2]{index=2}
    """
    ymd = pick.run_date
    cyc = f"{pick.cycle:02d}"
    fhr = f"{pick.fhr:03d}"
    return f"{AWS_BASE}/gfs.{ymd}/{cyc}/atmos/gfs.t{cyc}z.pgrb2.0p25.f{fhr}"


def _aws_idx_url(obj_url: str) -> str:
    return obj_url + ".idx"


_IDX_LINE = re.compile(r"^(?P<idx>\d+):(?P<offset>\d+):d=.+?:"
                       r"(?P<var>[A-Z0-9_]+):(?P<level>[^:]*):(?P<rest>.*)$")


def _parse_idx(idx_text: str) -> List[Tuple[int, str, str, str]]:
    """
    Returns list of (byte_offset, var, level, full_line)
    """
    out = []
    for line in idx_text.splitlines():
        m = _IDX_LINE.match(line.strip())
        if not m:
            continue
        off = int(m.group("offset"))
        var = m.group("var")
        level = m.group("level")
        out.append((off, var, level, line.strip()))
    return out


def _download_aws_ranges_for_uv(obj_url: str, level_mb: int, out_path: Path) -> None:
    """
    Download only the UGRD/VGRD messages for a given isobaric level from AWS using .idx + HTTP Range.
    This avoids downloading the full global GRIB (huge).
    """
    idx_url = _aws_idx_url(obj_url)
    idx_r = requests.get(idx_url, timeout=60)
    idx_r.raise_for_status()
    entries = _parse_idx(idx_r.text)
    if not entries:
        raise RuntimeError(f"AWS idx vacío: {idx_url}")

    # find byte ranges for UGRD/VGRD at level like "500 mb"
    target_level = f"{level_mb} mb"
    wanted_offsets = []
    for off, var, level, _line in entries:
        if var in ("UGRD", "VGRD") and level.strip() == target_level:
            wanted_offsets.append(off)

    if len(wanted_offsets) < 2:
        raise RuntimeError(f"No se encontraron UGRD/VGRD {target_level} en idx: {idx_url}")

    # build ranges using next offsets
    wanted_offsets = sorted(set(wanted_offsets))
    offsets_sorted = sorted([e[0] for e in entries])

    def next_offset(o: int) -> Optional[int]:
        # next offset in file after o
        for x in offsets_sorted:
            if x > o:
                return x
        return None  # last record

    ranges = []
    for o in wanted_offsets:
        nxt = next_offset(o)
        if nxt is None:
            ranges.append((o, None))
        else:
            ranges.append((o, nxt - 1))

    # download ranges and concatenate
    chunks = []
    for start, end in ranges:
        headers = {"Range": f"bytes={start}-" if end is None else f"bytes={start}-{end}"}
        rr = requests.get(obj_url, headers=headers, timeout=180)
        rr.raise_for_status()
        chunks.append(rr.content)

    out_path.write_bytes(b"".join(chunks))


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
    return ("u" in keys and "v" in keys) or ("UGRD" in keys and "VGRD" in keys)


def _extract_uv(ds: xr.Dataset) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    lat_name = "latitude" if "latitude" in ds.coords else ("lat" if "lat" in ds.coords else None)
    lon_name = "longitude" if "longitude" in ds.coords else ("lon" if "lon" in ds.coords else None)
    if lat_name is None or lon_name is None:
        raise ValueError("No se encontraron coords lat/lon en el GRIB decodificado.")

    if "u" in ds.data_vars and "v" in ds.data_vars:
        u = ds["u"]; v = ds["v"]
    elif "UGRD" in ds.data_vars and "VGRD" in ds.data_vars:
        u = ds["UGRD"]; v = ds["VGRD"]
    else:
        raise ValueError("Missing u/v in decoded GRIB.")

    # Drop extra dims
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

    # convert lon to [-180, 180]
    lon2d = ((lon2d + 180) % 360) - 180
    return lat2d.astype(float), lon2d.astype(float), u2d, v2d


def _download_gfs_grib_with_fallback(pick: GfsPick, bbox: Dict[str, float], level_mb: int, out_path: Path) -> Dict[str, str]:
    """
    Try NOMADS filter first; on 404 or failure, fallback to AWS ranges via .idx.
    Returns meta dict with source details.
    """
    # Try NOMADS
    try:
        _download_nomads_subset(pick, bbox, level_mb, out_path)
        return {"source": "GFS 0.25 (NOMADS filter)", "download": "nomads_filter"}
    except requests.HTTPError as e:
        # Common failure: 404
        nomads_err = str(e)
        # Fallback AWS
        obj_url = _aws_object_url(pick)
        try:
            _download_aws_ranges_for_uv(obj_url, level_mb, out_path)
            return {"source": "GFS 0.25 (AWS Open Data)", "download": "aws_range_idx", "aws_url": obj_url, "nomads_error": nomads_err}
        except Exception as e2:
            raise RuntimeError(f"NOMADS falló ({nomads_err}) y AWS falló ({e2})") from e2
    except Exception as e:
        # Non-HTTP error, still try AWS
        obj_url = _aws_object_url(pick)
        try:
            _download_aws_ranges_for_uv(obj_url, level_mb, out_path)
            return {"source": "GFS 0.25 (AWS Open Data)", "download": "aws_range_idx", "aws_url": obj_url, "nomads_error": str(e)}
        except Exception as e2:
            raise RuntimeError(f"NOMADS falló ({e}) y AWS falló ({e2})") from e2


def build_level(run_date: str, target_dt: datetime, cfg: Dict, out_dir: Path, level_key: str, level_mb: int) -> None:
    bbox = cfg["roi_bbox"]
    tol = int(cfg.get("tolerance_minutes", 90))
    step = int(cfg.get("sampling_step_grid", 2))

    pick = _best_gfs_pick(target_dt, tol)
    grib_path = out_dir / f"_tmp_{level_key}.grib2"

    src_meta = _download_gfs_grib_with_fallback(pick, bbox, level_mb, grib_path)

    ds = _open_grib_any(grib_path)
    lat2d, lon2d, u2d, v2d = _extract_uv(ds)

    # downsample
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
            **src_meta,
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

    try:
        grib_path.unlink(missing_ok=True)
    except Exception:
        pass


def build_all_levels(run_date: str, target_dt: datetime, cfg: Dict, out_dir: Path) -> None:
    levels = [
        ("900hPa", 900),
        ("500hPa", 500),
        ("250hPa", 250),
        ("150hPa", 150),
    ]

    for level_key, level_mb in levels:
        try:
            build_level(run_date, target_dt, cfg, out_dir, level_key, level_mb)
        except Exception as e:
            out = {
                "meta": {
                    "source": "GFS 0.25 (fallback)",
                    "t_target_utc": _iso(target_dt),
                    "level_key": level_key,
                    "level_mb": level_mb,
                    "error": str(e)
                },
                "points": []
            }
            (out_dir / f"{level_key}.json").write_text(json.dumps(out), encoding="utf-8")


def _today_utc() -> datetime:
    return datetime.now(timezone.utc).date()


def _parse_date_arg(s: str) -> datetime.date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def main():
    import sys

    run_date = _parse_date_arg(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else _today_utc()

    cfg_path = Path("wind_config.json")
    if not cfg_path.exists():
        raise FileNotFoundError("wind_config.json no existe en la raíz del repo.")

    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))

    lookback_days = int(cfg.get("lookback_days", 10))
    target_time = cfg.get("target_time_utc", "06:00:00Z")

    for i in range(lookback_days):
        d = run_date - timedelta(days=i)
        date_str = d.isoformat()

        target_iso = f"{date_str}T{target_time.replace('Z','')}+00:00"
        target_dt = datetime.fromisoformat(target_iso)

        out_dir = Path("data") / "wind" / date_str
        out_dir.mkdir(parents=True, exist_ok=True)

        build_all_levels(run_date=date_str, target_dt=target_dt, cfg=cfg, out_dir=out_dir)


if __name__ == "__main__":
    main()
