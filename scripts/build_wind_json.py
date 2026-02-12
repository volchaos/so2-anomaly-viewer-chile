from __future__ import annotations
import os, sys, json, math, tempfile
import datetime as dt
import requests
import numpy as np
import xarray as xr

def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).isoformat().replace("+00:00","Z")

def parse_iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z","+00:00")).astimezone(dt.timezone.utc)

def lon_to_0_360(lon: float) -> float:
    return lon % 360.0

def nomads_url(date_yyyymmdd: str, cycle_hh: str, fhr: int, roi: dict, want_10m: bool, want_levels: list[int]) -> str:
    leftlon = lon_to_0_360(roi["min_lon"])
    rightlon = lon_to_0_360(roi["max_lon"])
    if rightlon < leftlon:
        rightlon += 360.0
    params = {
        "file": f"gfs.t{cycle_hh}z.pgrb2.0p25.f{fhr:03d}",
        "var_UGRD": "on",
        "var_VGRD": "on",
        "subregion": "",
        "leftlon": f"{leftlon:.3f}",
        "rightlon": f"{rightlon:.3f}",
        "toplat": f"{roi['max_lat']:.3f}",
        "bottomlat": f"{roi['min_lat']:.3f}",
        "dir": f"/gfs.{date_yyyymmdd}/{cycle_hh}/atmos",
    }
    if want_10m:
        params["lev_10_m_above_ground"] = "on"
    for hpa in want_levels:
        params[f"lev_{hpa}_mb"] = "on"
    qs = "&".join([f"{k}={requests.utils.quote(str(v))}" for k,v in params.items()])
    return f"https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?{qs}"

def choose_gfs_time(t_target: dt.datetime, tol_min: int) -> tuple[str,str,int,dt.datetime]:
    tol = dt.timedelta(minutes=tol_min)
    # evaluate a small set of candidate cycles (00/06/12/18 of same day and neighbours)
    candidates = []
    for day_off in (-1,0,1):
        d = (t_target + dt.timedelta(days=day_off)).date()
        for hh in (0,6,12,18):
            cyc = dt.datetime(d.year, d.month, d.day, hh, tzinfo=dt.timezone.utc)
            # fhr guess range around target
            hrs = int(round((t_target - cyc).total_seconds()/3600))
            for fhr in range(max(0, hrs-6), max(0, hrs+7)):
                valid = cyc + dt.timedelta(hours=fhr)
                delta = abs(valid - t_target)
                if delta <= tol:
                    candidates.append((delta, cyc, fhr, valid))
    if not candidates:
        cyc = dt.datetime(t_target.year, t_target.month, t_target.day, (t_target.hour//6)*6, tzinfo=dt.timezone.utc)
        fhr = max(0, int(round((t_target-cyc).total_seconds()/3600)))
        return cyc.strftime("%Y%m%d"), f"{cyc.hour:02d}", fhr, (cyc+dt.timedelta(hours=fhr))
    candidates.sort(key=lambda x: x[0])
    _, cyc, fhr, valid = candidates[0]
    return cyc.strftime("%Y%m%d"), f"{cyc.hour:02d}", int(fhr), valid

def download(url: str, out_path: str) -> None:
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(out_path, "wb") as f:
            for ch in r.iter_content(chunk_size=1024*1024):
                if ch:
                    f.write(ch)

def sample_points(roi: dict, spacing_km: float) -> list[tuple[float,float]]:
    km_per_deg_lat = 111.32
    dlat = spacing_km / km_per_deg_lat
    pts = []
    lat = roi["min_lat"]
    while lat <= roi["max_lat"] + 1e-9:
        km_per_deg_lon = km_per_deg_lat * max(0.15, math.cos(math.radians(lat)))
        dlon = spacing_km / km_per_deg_lon
        lon = roi["min_lon"]
        while lon <= roi["max_lon"] + 1e-9:
            pts.append((round(lat,5), round(lon,5)))
            lon += dlon
        lat += dlat
    return pts

def nearest_idx(arr: np.ndarray, val: float) -> int:
    return int(np.abs(arr - val).argmin())

def extract_uv(ds: xr.Dataset, level: dict):
    if "u" not in ds or "v" not in ds:
        raise ValueError("Missing u/v in decoded GRIB.")
    u = ds["u"]; v = ds["v"]
    if level["kind"] == "10m" and "heightAboveGround" in u.dims:
        u = u.sel(heightAboveGround=10, method="nearest")
        v = v.sel(heightAboveGround=10, method="nearest")
    if level["kind"] == "isobaric":
        u = u.sel(isobaricInhPa=level["hpa"], method="nearest")
        v = v.sel(isobaricInhPa=level["hpa"], method="nearest")
    return ds["latitude"].values, ds["longitude"].values, u.values, v.values

def write_json(path: str, meta: dict, points: list[dict]):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "points": points}, f, ensure_ascii=False)

def build(date_str: str, so2_iso: str, cfg_path: str):
    cfg = json.load(open(cfg_path, "r", encoding="utf-8"))
    roi = cfg["roi"]; spacing_km = float(cfg["sampling_km"]); tol_min = int(cfg["tolerance_minutes"])
    t_so2 = parse_iso(so2_iso)
    date_yyyymmdd, cycle_hh, fhr, t_valid = choose_gfs_time(t_so2, tol_min)
    delta_min = int(abs((t_valid - t_so2).total_seconds())/60)
    pts = sample_points(roi, spacing_km)

    for level in cfg["levels"]:
        want_10m = level["kind"] == "10m"
        want_lvls = [level["hpa"]] if level["kind"] == "isobaric" else []
        url = nomads_url(date_yyyymmdd, cycle_hh, fhr, roi, want_10m, want_lvls)

        with tempfile.TemporaryDirectory() as td:
            grib = os.path.join(td, "wind.grib2")
            download(url, grib)
            ds = xr.open_dataset(grib, engine="cfgrib")
            lats, lons, U, V = extract_uv(ds, level)
            lats = np.array(lats); lons = np.array(lons)

            out_pts = []
            for lat, lon in pts:
                lon_q = lon_to_0_360(lon) if (lons.min() >= 0 and lons.max() > 180) else lon
                i = nearest_idx(lats, lat)
                j = nearest_idx(lons, lon_q)
                out_pts.append({"lat": lat, "lon": lon, "u": float(U[i,j]), "v": float(V[i,j])})

        meta = {
            "source": "NOAA GFS 0.25 (NOMADS filter)",
            "cycle": f"{date_yyyymmdd}{cycle_hh}",
            "fhr": int(fhr),
            "valid_utc": iso(t_valid),
            "t_so2_utc": iso(t_so2),
            "delta_minutes": delta_min,
            "roi": roi,
            "sampling_km": spacing_km,
            "level": level,
        }
        out_path = os.path.join("data","wind",date_str,f"{level['key']}.json")
        write_json(out_path, meta, out_pts)

def main():
    if len(sys.argv) != 4:
        print("Usage: python build_wind_json.py <YYYY-MM-DD> <SO2_ISO_UTC> <wind_config.json>", file=sys.stderr)
        sys.exit(2)
    build(sys.argv[1], sys.argv[2], sys.argv[3])

if __name__ == "__main__":
    main()
