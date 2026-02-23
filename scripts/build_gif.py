#!/usr/bin/env python3
import json
import math
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests
from PIL import Image, ImageDraw, ImageFont


# ---------------- Utils ----------------
def _safe_name(s: str) -> str:
    out = []
    for ch in s:
        if ch.isalnum() or ch in ("_", "-", "."):
            out.append(ch)
        else:
            out.append("_")
    return "".join(out).strip("_") or "volcano"


def _ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def _parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def _daterange_inclusive(d0: str, d1: str) -> List[str]:
    a = _parse_date(d0)
    b = _parse_date(d1)
    if b < a:
        a, b = b, a
    out = []
    cur = a
    while cur <= b:
        out.append(cur.date().isoformat())
        cur += timedelta(days=1)
    return out


def _to_wms_time(date_str: str, time_format: str) -> str:
    if time_format == "date":
        return date_str
    return f"{date_str}T05:00:00Z"


def _wms_bbox_epsg4326_axis_order_latlon(b: Dict[str, float]) -> str:
    # WMS 1.3.0 EPSG:4326 expects minLat,minLon,maxLat,maxLon
    return f"{b['south']},{b['west']},{b['north']},{b['east']}"


def _build_getmap_url(job: Dict, date_str: str) -> str:
    wms = job["wms"]
    bbox = job["roi_bbox"]
    size = int(job.get("size_px", 512))

    params = {
        "service": "WMS",
        "version": wms.get("version", "1.3.0"),
        "request": "GetMap",
        "layers": wms["layers"],
        "styles": wms.get("styles", ""),
        "format": "image/png",
        "transparent": "true",
        "crs": "EPSG:4326",
        "bbox": _wms_bbox_epsg4326_axis_order_latlon(bbox),
        "width": str(size),
        "height": str(size),
        "time": _to_wms_time(date_str, wms.get("timeFormat", "isoZ")),
    }
    qs = "&".join([f"{k}={requests.utils.quote(str(v), safe='')}" for k, v in params.items()])
    return f"{wms['url']}?{qs}"


def _build_legend_url(job: Dict) -> Optional[str]:
    wms = job.get("wms", {})
    if not wms.get("legend", True):
        return None
    params = {
        "service": "WMS",
        "version": wms.get("version", "1.3.0"),
        "request": "GetLegendGraphic",
        "format": "image/png",
        "layer": wms.get("layers", ""),
        "transparent": "true",
    }
    style = wms.get("styles", "")
    if style:
        params["style"] = style
    qs = "&".join([f"{k}={requests.utils.quote(str(v), safe='')}" for k, v in params.items()])
    return f"{wms['url']}?{qs}"


def _download_png(url: str, timeout: int = 180) -> Image.Image:
    r = requests.get(url, timeout=timeout)
    r.raise_for_status()
    return Image.open(BytesIO(r.content)).convert("RGBA")


def _download_json_url(url: str, timeout: int = 180) -> Dict:
    r = requests.get(url, timeout=timeout)
    r.raise_for_status()
    return r.json()


def _compute_roi_bbox(lat: float, lon: float, roi_km: float) -> Dict[str, float]:
    half = roi_km / 2.0
    dlat = half / 111.32
    dlon = half / (111.32 * max(0.1, math.cos(math.radians(lat))))
    return {"west": lon - dlon, "south": lat - dlat, "east": lon + dlon, "north": lat + dlat}


def _load_font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size=size)
    except Exception:
        return ImageFont.load_default()


# ---------------- Stamp & legend ----------------
def _draw_marker_center(draw: ImageDraw.ImageDraw, size: int):
    cx, cy = size // 2, size // 2
    tri = [(cx, cy - 10), (cx - 8, cy + 8), (cx + 8, cy + 8)]
    draw.polygon(tri, fill=(0, 0, 0, 230))
    draw.line([tri[0], tri[1], tri[2], tri[0]], fill=(255, 0, 0, 230), width=2)


def _stamp(frame: Image.Image, volcano_name: str, date_str: str):
    draw = ImageDraw.Draw(frame)
    W, _H = frame.size
    f_title = _load_font(16)
    f_sub = _load_font(13)

    box_w, box_h = min(320, W - 20), 54
    draw.rectangle([10, 10, 10 + box_w, 10 + box_h], fill=(255, 255, 255, 215))
    draw.text((18, 18), volcano_name, fill=(17, 17, 17, 255), font=f_title)
    draw.text((18, 38), f"{date_str} (UTC)", fill=(17, 17, 17, 255), font=f_sub)

    _draw_marker_center(draw, W)


def _paste_legend(frame: Image.Image, legend: Image.Image):
    W, H = frame.size
    max_w = int(W * 0.22)
    ratio = min(1.0, max_w / legend.size[0])
    lw = int(legend.size[0] * ratio)
    lh = int(legend.size[1] * ratio)
    leg = legend.resize((lw, lh), Image.Resampling.LANCZOS)

    x = W - lw - 10
    y = H - lh - 10
    frame.alpha_composite(leg, dest=(x, y))


# ---------------- Auto-skip frames without data ----------------
def _frame_coverage_stats(img: Image.Image, sample_step: int = 6) -> Tuple[float, float, float]:
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    w, h = img.size
    px = img.load()

    n = 0
    n_opaque = 0
    lumas: List[float] = []
    for y in range(0, h, sample_step):
        for x in range(0, w, sample_step):
            r, g, b, a = px[x, y]
            n += 1
            if a > 0:
                n_opaque += 1
                l = 0.2126 * r + 0.7152 * g + 0.0722 * b
                lumas.append(l)

    alpha_frac = (n_opaque / n) if n else 0.0
    if not lumas:
        return alpha_frac, 0.0, 0.0
    mean = sum(lumas) / len(lumas)
    var = sum((v - mean) ** 2 for v in lumas) / max(1, (len(lumas) - 1))
    std = math.sqrt(var)
    return alpha_frac, float(mean), float(std)


def _is_frame_valid(img: Image.Image, cfg: Dict) -> Tuple[bool, str]:
    sample_step = int(cfg.get("skip_sample_step", 6))
    min_alpha_frac = float(cfg.get("min_alpha_frac", 0.015))
    min_std_luma = float(cfg.get("min_std_luma", 2.0))
    max_dark_mean = float(cfg.get("max_dark_mean", 12.0))

    alpha_frac, mean_luma, std_luma = _frame_coverage_stats(img, sample_step=sample_step)

    if alpha_frac < min_alpha_frac:
        return False, f"skip: low alpha coverage (alpha_frac={alpha_frac:.4f})"
    if mean_luma <= max_dark_mean and std_luma < min_std_luma:
        return False, f"skip: dark+uniform (mean={mean_luma:.1f}, std={std_luma:.1f}, alpha={alpha_frac:.3f})"
    if std_luma < (min_std_luma * 0.75):
        return False, f"skip: near-uniform (std={std_luma:.1f}, alpha={alpha_frac:.3f})"
    return True, f"ok (alpha={alpha_frac:.3f}, mean={mean_luma:.1f}, std={std_luma:.1f})"


# ---------------- Overlays: Chile border + Points + Wind ----------------
_COUNTRIES_CACHE: Optional[Dict] = None
_GEOJSON_CACHE: Dict[str, Dict] = {}


def _find_chile_feature(fc: Dict) -> Optional[Dict]:
    candidates = ["ADMIN", "name", "NAME", "COUNTRY", "SOVEREIGNT"]
    for f in fc.get("features", []):
        props = f.get("properties", {}) or {}
        for k in candidates:
            if k in props and str(props[k]).strip().lower() == "chile":
                return f
    return None


def _iter_rings(geom: Dict) -> List[List[Tuple[float, float]]]:
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    rings: List[List[Tuple[float, float]]] = []
    if gtype == "Polygon":
        for ring in coords:
            rings.append([(pt[0], pt[1]) for pt in ring])
    elif gtype == "MultiPolygon":
        for poly in coords:
            for ring in poly:
                rings.append([(pt[0], pt[1]) for pt in ring])
    return rings


def _lonlat_to_xy(lon: float, lat: float, bbox: Dict[str, float], W: int, H: int) -> Tuple[float, float]:
    west, east = bbox["west"], bbox["east"]
    south, north = bbox["south"], bbox["north"]
    x = (lon - west) / (east - west) * W
    y = (north - lat) / (north - south) * H
    return x, y


def _draw_border_chile(frame: Image.Image, bbox: Dict[str, float], overlay_cfg: Dict):
    global _COUNTRIES_CACHE
    url = overlay_cfg.get("countries_url") or "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson"
    stroke = tuple(overlay_cfg.get("stroke_rgba", [0, 0, 0, 220]))
    width = int(overlay_cfg.get("stroke_width", 2))

    if _COUNTRIES_CACHE is None:
        _COUNTRIES_CACHE = _download_json_url(url, timeout=180)

    chile = _find_chile_feature(_COUNTRIES_CACHE)
    if not chile:
        return

    geom = chile.get("geometry", {}) or {}
    rings = _iter_rings(geom)
    if not rings:
        return

    draw = ImageDraw.Draw(frame)
    W, H = frame.size
    west, east = bbox["west"], bbox["east"]
    south, north = bbox["south"], bbox["north"]

    for ring in rings:
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        if max(lons) < west or min(lons) > east or max(lats) < south or min(lats) > north:
            continue
        xy = [_lonlat_to_xy(lon, lat, bbox, W, H) for lon, lat in ring]
        draw.line(xy, fill=stroke, width=width, joint="curve")


def _load_local_geojson(path_str: str) -> Dict:
    key = path_str.replace("\\", "/")
    if key in _GEOJSON_CACHE:
        return _GEOJSON_CACHE[key]
    p = Path(key)
    if not p.exists():
        raise FileNotFoundError(f"GeoJSON no existe: {key}")
    obj = json.loads(p.read_text(encoding="utf-8"))
    _GEOJSON_CACHE[key] = obj
    return obj


def _extract_points_from_geojson(gj: Dict) -> List[Tuple[float, float]]:
    pts: List[Tuple[float, float]] = []
    for f in gj.get("features", []):
        g = f.get("geometry", {}) or {}
        if g.get("type") == "Point":
            lon, lat = g.get("coordinates", [None, None])
            if lon is None or lat is None:
                continue
            pts.append((float(lon), float(lat)))
    return pts


def _draw_triangle(draw: ImageDraw.ImageDraw, x: float, y: float, size: int,
                   fill_rgba, outline_rgba, outline_w: int):
    h = int(size * 1.1)
    pts = [(x, y - h/2), (x - size/2, y + h/2), (x + size/2, y + h/2)]
    draw.polygon(pts, fill=fill_rgba)
    if outline_w > 0:
        draw.line([pts[0], pts[1], pts[2], pts[0]], fill=outline_rgba, width=outline_w)


def _draw_circle(draw: ImageDraw.ImageDraw, x: float, y: float, r: int,
                 fill_rgba, outline_rgba=None, outline_w: int = 0):
    bb = [x - r, y - r, x + r, y + r]
    draw.ellipse(bb, fill=fill_rgba)
    if outline_w > 0 and outline_rgba is not None:
        draw.ellipse(bb, outline=outline_rgba, width=outline_w)


def _draw_points_overlay(frame: Image.Image, bbox: Dict[str, float],
                         pts_lonlat: List[Tuple[float, float]], style: Dict):
    draw = ImageDraw.Draw(frame)
    W, H = frame.size
    west, east = bbox["west"], bbox["east"]
    south, north = bbox["south"], bbox["north"]

    kind = style.get("kind", "circle")
    size = int(style.get("size", 10))
    fill = tuple(style.get("fill_rgba", [0, 0, 0, 230]))
    outline = tuple(style.get("outline_rgba", [255, 0, 0, 230]))
    outline_w = int(style.get("outline_width", 2))

    for lon, lat in pts_lonlat:
        if lon < west or lon > east or lat < south or lat > north:
            continue
        x, y = _lonlat_to_xy(lon, lat, bbox, W, H)
        if kind == "triangle":
            _draw_triangle(draw, x, y, size=size, fill_rgba=fill,
                           outline_rgba=outline, outline_w=outline_w)
        else:
            _draw_circle(draw, x, y, r=max(2, size // 2), fill_rgba=fill,
                         outline_rgba=outline, outline_w=outline_w)


def _wind_json_path(date_str: str, level_key: str) -> Path:
    return Path("data") / "wind" / date_str / f"{level_key}.json"


def _load_wind_points(date_str: str, level_key: str) -> List[Dict]:
    p = _wind_json_path(date_str, level_key)
    if not p.exists():
        return []
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
        pts = obj.get("points", []) or []
        return pts
    except Exception:
        return []


def _draw_wind_arrows(frame: Image.Image, bbox: Dict[str, float],
                      wind_points: List[Dict], style: Dict):
    if not wind_points:
        return

    draw = ImageDraw.Draw(frame)
    W, H = frame.size
    west, east = bbox["west"], bbox["east"]
    south, north = bbox["south"], bbox["north"]

    color_rgba = tuple(style.get("color_rgba", [85, 85, 85, 200]))
    width = int(style.get("width", 2))
    head_px = float(style.get("head_px", 10))
    base_len_px = float(style.get("base_len_px", 60))
    min_len_px = float(style.get("min_len_px", 20))
    max_len_px = float(style.get("max_len_px", 90))
    ref_speed = float(style.get("ref_speed", 10.0))
    stride = max(1, int(style.get("stride", 1)))

    pts = []
    for p in wind_points:
        lat = p.get("lat"); lon = p.get("lon")
        u = p.get("u"); v = p.get("v")
        if lat is None or lon is None or u is None or v is None:
            continue
        lat = float(lat); lon = float(lon)
        if lon < west or lon > east or lat < south or lat > north:
            continue
        pts.append((lon, lat, float(u), float(v)))

    if not pts:
        return
    pts = pts[::stride]

    def dest_xy(x, y, bearing_deg, length_px):
        ang = math.radians(bearing_deg)
        dx = math.sin(ang) * length_px
        dy = -math.cos(ang) * length_px
        return x + dx, y + dy

    for lon, lat, u, v in pts:
        speed = math.sqrt(u*u + v*v)
        if not math.isfinite(speed):
            continue

        # Same bearing convention as your viewer JS:
        bearing = (math.degrees(math.atan2(u, v)) + 360.0) % 360.0

        length_px = base_len_px * (speed / ref_speed)
        length_px = max(min_len_px, min(max_len_px, length_px))

        x0, y0 = _lonlat_to_xy(lon, lat, bbox, W, H)
        x1, y1 = dest_xy(x0, y0, bearing, length_px)

        xl, yl = dest_xy(x1, y1, bearing + 150.0, head_px)
        xr, yr = dest_xy(x1, y1, bearing - 150.0, head_px)

        draw.line([(x0, y0), (x1, y1)], fill=color_rgba, width=width)
        draw.line([(xl, yl), (x1, y1), (xr, yr)], fill=color_rgba, width=width)


# ---------------- Main builder ----------------
def build_gif_from_job(job_path: Path) -> Path:
    job = json.loads(job_path.read_text(encoding="utf-8"))

    if "dates" in job and isinstance(job["dates"], list) and job["dates"]:
        dates = job["dates"]
    else:
        dates = _daterange_inclusive(job["date_from"], job["date_to"])

    max_frames = int(job.get("max_frames", 30))
    if len(dates) > max_frames:
        stride = math.ceil(len(dates) / max_frames)
        sampled = dates[::stride]
        if sampled[-1] != dates[-1]:
            sampled.append(dates[-1])
        dates = sampled

    volcano_name = job.get("volcano_name", "Volcano")
    safe_volcano = _safe_name(volcano_name)

    lat = float(job["volcano_lat"])
    lon = float(job["volcano_lon"])
    roi_km = float(job.get("roi_km", 200))
    size_px = int(job.get("size_px", 512))
    fps = int(job.get("fps", 2))
    duration_ms = max(120, int(1000 / max(1, fps)))

    roi_bbox = job.get("roi_bbox")
    if not roi_bbox:
        roi_bbox = _compute_roi_bbox(lat, lon, roi_km)
        job["roi_bbox"] = roi_bbox

    out_rel = job.get("output_relpath")
    if out_rel:
        out_path = Path(out_rel)
    else:
        out_dir = Path("data") / "gifs" / safe_volcano
        _ensure_dir(out_dir)
        out_name = f"SO2_{safe_volcano}_{dates[0].replace('-','')}-{dates[-1].replace('-','')}_{int(roi_km)}km_{size_px}px.gif"
        out_path = out_dir / out_name
    _ensure_dir(out_path.parent)

    # Legend
    legend_img = None
    legend_url = _build_legend_url(job)
    if legend_url:
        try:
            legend_img = _download_png(legend_url, timeout=120)
        except Exception:
            legend_img = None

    # Skip empty frames config
    skip_cfg = job.get("skip_empty_frames", {})
    if skip_cfg is True:
        skip_cfg = {}
    if skip_cfg is False:
        skip_cfg = {"enabled": False}
    enabled_skip = bool(skip_cfg.get("enabled", True))

    overlays = job.get("overlays", {}) or {}

    draw_chile_border = bool(overlays.get("chile_border", False))
    chile_border_cfg = overlays.get("chile_border_cfg", {}) or {}

    draw_volcanoes_ovdas = bool(overlays.get("volcanoes_ovdas", False))
    volcanoes_ovdas_path = overlays.get("volcanoes_ovdas_path")

    draw_smelters = bool(overlays.get("smelters", False))
    smelters_path = overlays.get("smelters_path")

    wind_style = overlays.get("wind_style", {}) or {}
    wind_900 = bool(overlays.get("wind_900hPa", False))
    wind_500 = bool(overlays.get("wind_500hPa", False))
    wind_250 = bool(overlays.get("wind_250hPa", False))
    wind_150 = bool(overlays.get("wind_150hPa", False))

    # load point overlays once
    ovdas_pts: List[Tuple[float, float]] = []
    smelter_pts: List[Tuple[float, float]] = []
    if draw_volcanoes_ovdas and volcanoes_ovdas_path:
        try:
            ovdas_pts = _extract_points_from_geojson(_load_local_geojson(volcanoes_ovdas_path))
        except Exception as e:
            print(f"⚠ No se pudo cargar volcanes_ovdas_path={volcanoes_ovdas_path}: {e}")
    if draw_smelters and smelters_path:
        try:
            smelter_pts = _extract_points_from_geojson(_load_local_geojson(smelters_path))
        except Exception as e:
            print(f"⚠ No se pudo cargar smelters_path={smelters_path}: {e}")

    frames: List[Image.Image] = []
    skipped: List[Dict] = []
    kept_dates: List[str] = []

    for i, d in enumerate(dates, start=1):
        url = _build_getmap_url(job, d)
        print(f"[{i}/{len(dates)}] GETMAP {d}")

        try:
            frame = _download_png(url, timeout=240)
            if frame.size != (size_px, size_px):
                frame = frame.resize((size_px, size_px), Image.Resampling.BILINEAR)

            if enabled_skip:
                ok, reason = _is_frame_valid(frame, skip_cfg)
                if not ok:
                    skipped.append({"date": d, "reason": reason})
                    print(f"  -> {reason}")
                    continue
                else:
                    print(f"  -> {reason}")

            # --- overlays before stamp/legend ---
            if draw_chile_border:
                try:
                    _draw_border_chile(frame, roi_bbox, chile_border_cfg)
                except Exception as e:
                    print(f"  -> border overlay failed: {e}")

            if draw_volcanoes_ovdas and ovdas_pts:
                style = {
                    "kind": "triangle",
                    "size": 14,
                    "fill_rgba": [0, 0, 0, 230],
                    "outline_rgba": [255, 0, 0, 230],
                    "outline_width": 2
                }
                _draw_points_overlay(frame, roi_bbox, ovdas_pts, style)

            if draw_smelters and smelter_pts:
                style = {
                    "kind": "circle",
                    "size": 10,
                    "fill_rgba": [0, 0, 0, 230],
                    "outline_rgba": [0, 0, 0, 230],
                    "outline_width": 0
                }
                _draw_points_overlay(frame, roi_bbox, smelter_pts, style)

            # Wind overlays (each level independently)
            if wind_900:
                pts = _load_wind_points(d, "900hPa")
                _draw_wind_arrows(frame, roi_bbox, pts, wind_style)
            if wind_500:
                pts = _load_wind_points(d, "500hPa")
                _draw_wind_arrows(frame, roi_bbox, pts, wind_style)
            if wind_250:
                pts = _load_wind_points(d, "250hPa")
                _draw_wind_arrows(frame, roi_bbox, pts, wind_style)
            if wind_150:
                pts = _load_wind_points(d, "150hPa")
                _draw_wind_arrows(frame, roi_bbox, pts, wind_style)

            _stamp(frame, volcano_name, d)
            if legend_img is not None:
                _paste_legend(frame, legend_img)

            frames.append(frame)
            kept_dates.append(d)

        except Exception as e:
            skipped.append({"date": d, "reason": f"download/error: {e}"})
            print(f"  -> skip: error {e}")
            continue

    if not frames:
        raise RuntimeError("No frames produced (all skipped or failed). Consider relaxing skip thresholds.")

    first = frames[0].convert("P", palette=Image.Palette.ADAPTIVE)
    rest = [f.convert("P", palette=Image.Palette.ADAPTIVE) for f in frames[1:]]

    first.save(
        out_path,
        save_all=True,
        append_images=rest,
        duration=duration_ms,
        loop=0,
        optimize=False,
        disposal=2,
    )

    pointer = {
        "volcano_name": volcano_name,
        "requested_dates": dates,
        "kept_dates": kept_dates,
        "skipped": skipped,
        "roi_km": roi_km,
        "size_px": size_px,
        "fps": fps,
        "output_relpath": str(out_path).replace("\\", "/"),
        "created_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "skip_empty_frames": {"enabled": enabled_skip, **skip_cfg} if isinstance(skip_cfg, dict) else {"enabled": enabled_skip},
        "overlays": overlays,
    }
    pointer_path = out_path.with_suffix(".json")
    pointer_path.write_text(json.dumps(pointer, ensure_ascii=False, indent=2), encoding="utf-8")

    return out_path


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python scripts/build_gif.py jobs/gif_job.json")
    out = build_gif_from_job(Path(sys.argv[1]))
    print(f"GIF written: {out.as_posix()}")
