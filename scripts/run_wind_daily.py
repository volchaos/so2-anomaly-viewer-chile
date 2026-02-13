#!/usr/bin/env python
import sys
import json
from pathlib import Path
from datetime import datetime, timezone, timedelta

from build_wind_json import build_all_levels

def _today_utc():
    return datetime.now(timezone.utc).date()

def _parse_date(s: str):
    return datetime.strptime(s, "%Y-%m-%d").date()

def main():
    run_date = _parse_date(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else _today_utc()

    cfg_path = Path("wind_config.json")
    if not cfg_path.exists():
        raise FileNotFoundError("wind_config.json no existe en la raíz del repo.")

    with cfg_path.open("r", encoding="utf-8") as f:
        cfg = json.load(f)

    lookback_days = int(cfg.get("lookback_days", 14))
    target_time = cfg.get("target_time_utc", "06:00:00Z")

    # Genera overlays para run_date y los N-1 días anteriores
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
