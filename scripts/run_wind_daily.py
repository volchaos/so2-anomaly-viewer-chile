from __future__ import annotations
import sys, json, subprocess

def main():
    if len(sys.argv) != 2:
        print("Usage: python run_wind_daily.py <YYYY-MM-DD>", file=sys.stderr)
        sys.exit(2)
    date_str = sys.argv[1]
    cfg = json.load(open("wind_config.json", "r", encoding="utf-8"))
    so2_iso = subprocess.check_output([sys.executable, "scripts/fetch_so2_time.py", cfg["stac_endpoint"], cfg["so2_collection"], date_str], text=True).strip()
    subprocess.check_call([sys.executable, "scripts/build_wind_json.py", date_str, so2_iso, "wind_config.json"])
    print(f"OK: data/wind/{date_str}/ generated")

if __name__ == "__main__":
    main()
