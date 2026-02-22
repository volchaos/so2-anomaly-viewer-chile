#!/usr/bin/env python3
import json
import math
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests
from PIL import Image, ImageDraw, ImageFont, ImageStat


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


# ---------------- Auto-skip logic (NEW) ----------------
def _frame_coverage_stats(img: Image.Image, sample_step: int = 6) -> Tuple[float, float, float]:
    """
    Returns:
      alpha_frac: fraction of sampled pixels with alpha > 0
      mean_luma: mean brightness (0..255) on sampled opaque pixels (approx)
      std_luma: std brightness on sampled opaque pixels (approx)
    """
    if img.mode != "RGBA":
        img = img.convert("RGBA")

    w, h = img.size
    px = img.load()

    n = 0
    n_opaque = 0
    lumas = []

    # sample grid to be fast
    for y in range(0, h, sample_step):
        for x in range(0, w, sample_step):
            r, g, b, a = px[x, y]
            n += 1
            if a > 0:
                n_opaque += 1
                # simple luma
                l = 0.2126 * r + 0.7152 * g + 0.0722 * b
                lumas.append(l)

    alpha_frac = (n_opaque / n) if n else 0.0
    if not lumas:
        return alpha_frac, 0.0, 0.0

    # compute mean/std
    mean = sum(lumas) / len(lumas)
    var = sum((v - mean) ** 2 for v in lumas) / max(1, (len(lumas) - 1))
    std = math.sqrt(var)
    return alpha_frac, float(mean), float(std)


def _is_frame_valid(img: Image.Image, cfg: Dict) -> Tuple[bool, str]:
    """
    Decide if a frame contains meaningful data.
    Heuristics:
      - if almost all pixels are transparent -> invalid
      - if opaque but almost uniform / very dark -> invalid (common 'no-data' appearance)
    """
    sample_step = int(cfg.get("skip_sample_step", 6))
    min_alpha_frac = float(cfg.get("min_alpha_frac", 0.015))  # 1.5% opaque pixels
    min_std_luma = float(cfg.get("min_std_luma", 2.0))         # variability threshold
    max_dark_mean = float(cfg.get("max_dark_mean", 12.0))      # "mostly black" cutoff

    alpha_frac, mean_luma, std_luma = _frame_coverage_stats(img, sample_step=sample_step)

    if alpha_frac < min_alpha_frac:
        return False, f"skip: low alpha coverage (alpha_frac={alpha_frac:.4f})"

    # If it's very dark AND very uniform, it's probably an empty/invalid frame
    if mean_luma <= max_dark_mean and std_luma < min_std_luma:
        return False, f"skip: dark+uniform (mean={mean_luma:.1f}, std={std_luma:.1f}, alpha={alpha_frac:.3f})"

    # Also skip near-uniform (even if not dark) – often a blank tile
    if std_luma < (min_std_luma * 0.75):
        return False, f"skip: near-uniform (std={std_luma:.1f}, alpha={alpha_frac:.3f})"

    return True, f"ok (alpha={alpha_frac:.3f}, mean={mean_luma:.1f}, std={std_luma:.1f})"


def build_gif_from_job(job_path: Path) -> Path:
    job = json.loads(job_path.read_text(encoding="utf-8"))

    # Resolve dates
    if "dates" in job and isinstance(job["dates"], list) and job["dates"]:
        dates = job["dates"]
    else:
        dates = _daterange_inclusive(job["date_from"], job["date_to"])

    # Optional sampling to cap frames (server-side safety)
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

    # ROI bbox
    roi_bbox = job.get("roi_bbox")
    if not roi_bbox:
        roi_bbox = _compute_roi_bbox(lat, lon, roi_km)
        job["roi_bbox"] = roi_bbox

    # Output path
    out_rel = job.get("output_relpath")
    if out_rel:
        out_path = Path(out_rel)
    else:
        out_dir = Path("data") / "gifs" / safe_volcano
        _ensure_dir(out_dir)
        out_name = f"SO2_{safe_volcano}_{dates[0].replace('-','')}-{dates[-1].replace('-','')}_{int(roi_km)}km_{size_px}px.gif"
        out_path = out_dir / out_name

    _ensure_dir(out_path.parent)

    # Legend (optional)
    legend_img = None
    legend_url = _build_legend_url(job)
    if legend_url:
        try:
            legend_img = _download_png(legend_url, timeout=120)
        except Exception:
            legend_img = None

    # Auto-skip config
    skip_cfg = job.get("skip_empty_frames", {})
    if skip_cfg is True:
        skip_cfg = {}
    if skip_cfg is False:
        skip_cfg = {"enabled": False}
    enabled = bool(skip_cfg.get("enabled", True))

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

            if enabled:
                ok, reason = _is_frame_valid(frame, skip_cfg)
                if not ok:
                    skipped.append({"date": d, "reason": reason})
                    print(f"  -> {reason}")
                    continue
                else:
                    print(f"  -> {reason}")

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

    # Save GIF (adaptive palette)
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
        "skip_empty_frames": {"enabled": enabled, **skip_cfg} if isinstance(skip_cfg, dict) else {"enabled": enabled},
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
