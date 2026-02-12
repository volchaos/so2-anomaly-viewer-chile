"""Fetch SO2 daily composite timestamp for a UTC date from EOC STAC; fallback to dateT05:00:00Z."""
from __future__ import annotations
import sys, datetime as dt, requests

def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).isoformat().replace("+00:00","Z")

def fetch(stac: str, collection: str, date_str: str) -> str:
    d = dt.datetime.strptime(date_str, "%Y-%m-%d").date()
    t0 = dt.datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=dt.timezone.utc)
    t1 = t0 + dt.timedelta(days=1)
    url = f"{stac.rstrip('/')}/search"
    payload = {"collections":[collection], "datetime": f"{iso(t0)}/{iso(t1)}", "limit": 10}
    r = requests.post(url, json=payload, timeout=60); r.raise_for_status()
    feats = r.json().get("features", [])
    for f in feats:
        p = f.get("properties", {}) or {}
        dts = f.get("datetime") or p.get("datetime") or p.get("start_datetime")
        if not dts: 
            continue
        try:
            t = dt.datetime.fromisoformat(dts.replace("Z","+00:00")).astimezone(dt.timezone.utc)
        except Exception:
            continue
        if t0 <= t < t1:
            return iso(t)
    return f"{date_str}T05:00:00Z"

def main():
    if len(sys.argv) != 4:
        print("Usage: python fetch_so2_time.py <stac_endpoint> <collection> <YYYY-MM-DD>", file=sys.stderr)
        sys.exit(2)
    stac, col, date_str = sys.argv[1:]
    try:
        print(fetch(stac, col, date_str))
    except Exception as e:
        print(f"{date_str}T05:00:00Z")
        print(f"[warn] STAC fetch failed: {e}", file=sys.stderr)

if __name__ == "__main__":
    main()
