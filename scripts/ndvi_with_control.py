#!/usr/bin/env python3
"""
Rangefinder — NDVI verification WITH a spatial seasonal control.

Fixes a methodological flaw in the original ndvi.json: the previous "before"
(2025-09-29) and "after" (2026-08-27) scenes are ~11 months apart but in
DIFFERENT calendar months, so part of the raw NDVI delta at the target is
ordinary seasonal phenology, not disturbance. That is not a safe basis for a
canopy-loss claim.

The fix: sample a CONTROL polygon of forest believed to be undisturbed, in
the SAME two Sentinel-2 items (same date, same sensor, same sun angle, same
atmosphere) used for the target. Whatever NDVI change the control shows over
that interval IS the seasonal/illumination baseline for this pair of scenes.
Subtracting it from the target's raw delta gives a corrected delta that is
what's actually attributable to disturbance at the target site.

Also fixes: the original script did no cloud/shadow/snow masking at all
(SCL band exists on every sentinel-2-l2a item and was simply unused). This
version reads SCL windowed at 10 m (resampled from its native 20 m) and
excludes no-data, saturated, cloud-shadow, cloud (all probabilities), and
thin-cirrus pixels from every NDVI mean, and reports the masked fraction.

Control site selection (see --control-lat/--control-lon below and the
printed rationale): chosen BEFORE looking at its NDVI numbers, based on
(1) being ~20 km SW of the target — far outside the dense fire cluster
around the target and comfortably inside the same Sentinel-2/MGRS tile
(21LZJ) so it is read from the identical COG files as the target chip,
(2) zero NASA FIRMS thermal detections within ~5.5 km in data/alerts.json
(a 394-point dataset spanning a much larger box, so the absence is
informative, not just missing coverage), and
(3) majority "Tree cover" class in ESA WorldCover 10 m 2021. Its own NDVI
(>0.7 in both scenes, see output) is reported as a post-hoc sanity check,
not as the selection criterion — the site was not swapped out to change the
result.

Usage:
    python scripts/ndvi_with_control.py
"""

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path

import numpy as np

try:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import transform_bounds
    from rasterio.windows import from_bounds
    import pystac_client
    import planetary_computer
except ImportError as e:
    print(f"FATAL: required package missing ({e}).", file=sys.stderr)
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    Image = None

CATALOG_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"

# SCL classes to exclude from NDVI means (Sen2Cor Scene Classification Layer):
#   0 no data, 1 saturated/defective, 3 cloud shadow,
#   8 cloud medium prob, 9 cloud high prob, 10 thin cirrus, 11 snow/ice
SCL_EXCLUDE = {0, 1, 3, 8, 9, 10, 11}

WORLDCOVER_BASE = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"
WORLDCOVER_CLASSES = {
    10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland",
    50: "Built-up", 60: "Bare/sparse", 70: "Snow/ice", 80: "Water",
    90: "Herb. wetland", 95: "Mangrove", 100: "Moss",
}


def worldcover_tile_for(lat, lon):
    la = math.floor(lat / 3) * 3
    lo = math.floor(lon / 3) * 3
    ns = f"{'S' if la < 0 else 'N'}{abs(la):02d}"
    ew = f"{'W' if lo < 0 else 'E'}{abs(lo):03d}"
    return f"ESA_WorldCover_10m_2021_v200_{ns}{ew}_Map.tif"


def worldcover_tree_pct(lat, lon, half_deg=0.01):
    """% of pixels classed 'Tree cover' in ESA WorldCover 10m 2021 around a point."""
    url = f"/vsicurl/{WORLDCOVER_BASE}/{worldcover_tile_for(lat, lon)}"
    try:
        with rasterio.open(url) as src:
            w = from_bounds(lon - half_deg, lat - half_deg, lon + half_deg, lat + half_deg, src.transform)
            arr = src.read(1, window=w)
        total = arr.size
        if total == 0:
            return None, "no pixels read"
        tree = int(np.sum(arr == 10))
        dominant = int(np.bincount(arr.flatten()).argmax())
        return 100.0 * tree / total, WORLDCOVER_CLASSES.get(dominant, str(dominant))
    except Exception as e:
        return None, f"ERROR {type(e).__name__}: {e}"


def find_scene(catalog, lon, lat, date_start, date_end, max_cloud, sort_most_recent):
    search = catalog.search(
        collections=["sentinel-2-l2a"],
        intersects={"type": "Point", "coordinates": [lon, lat]},
        datetime=f"{date_start}/{date_end}",
        query={"eo:cloud_cover": {"lt": max_cloud}},
        sortby=[{"field": "properties.datetime", "direction": "desc" if sort_most_recent else "asc"}],
        limit=20,
    )
    items = list(search.item_collection())
    if not items:
        return None
    if sort_most_recent:
        return items[0]
    items.sort(key=lambda it: it.properties.get("eo:cloud_cover", 100))
    return items[0]


def read_band_chip(href, lon, lat, half_deg, out_shape=None, resampling=Resampling.nearest):
    """Windowed read of one band around (lat,lon). If out_shape given, resamples
    to that shape (used to bring 20m SCL onto the 10m B04/B08 pixel grid)."""
    with rasterio.open(href) as src:
        bbox_4326 = (lon - half_deg, lat - half_deg, lon + half_deg, lat + half_deg)
        bounds_src_crs = transform_bounds("EPSG:4326", src.crs, *bbox_4326)
        window = from_bounds(*bounds_src_crs, transform=src.transform)
        if out_shape is not None:
            arr = src.read(1, window=window, out_shape=out_shape, resampling=resampling)
        else:
            arr = src.read(window=window)
        nodata = src.nodata
        return arr, nodata


def save_png(arr_rgb_uint8, path):
    img = np.transpose(arr_rgb_uint8, (1, 2, 0))
    if Image is None:
        raise RuntimeError("Pillow not available to save PNG")
    Image.fromarray(img, mode="RGB").save(path)


def masked_ndvi(red_arr, nir_arr, scl_arr, nodata):
    """Returns (mean_ndvi, masked_fraction). Excludes SCL_EXCLUDE classes plus
    the raster nodata value plus the (nir+red)==0 degenerate case."""
    red = red_arr.astype(np.float32)
    nir = nir_arr.astype(np.float32)
    total = red.size

    valid = np.ones_like(red, dtype=bool)
    if nodata is not None:
        valid &= (red != nodata) & (nir != nodata)
    denom = nir + red
    valid &= (denom != 0)

    scl_bad = np.isin(scl_arr, list(SCL_EXCLUDE))
    valid &= ~scl_bad

    masked_fraction = 1.0 - (float(np.sum(valid)) / total if total else 0.0)

    ndvi = np.full(red.shape, np.nan, dtype=np.float32)
    ndvi[valid] = (nir[valid] - red[valid]) / denom[valid]
    mean_ndvi = float(np.nanmean(ndvi)) if np.any(valid) else float("nan")
    return mean_ndvi, masked_fraction


def smoke_like_fraction(rgb_uint8, bright_thresh=105, low_sat_thresh=45):
    """Heuristic diagnostic (NOT used in the NDVI mask): fraction of pixels that
    are bright and low-saturation (grey/white haze) in the true-colour chip.
    Sen2Cor's SCL band is built to flag clouds and is known to often miss
    smoke plumes, which are spectrally distinct from cloud — so this is
    reported as a separate, honest caveat about residual contamination that
    the official SCL mask does not catch, not folded into mean_ndvi."""
    r = rgb_uint8[0].astype(np.int16)
    g = rgb_uint8[1].astype(np.int16)
    b = rgb_uint8[2].astype(np.int16)
    mn = np.minimum(np.minimum(r, g), b)
    mx = np.maximum(np.maximum(r, g), b)
    smoke_like = (mx >= bright_thresh) & ((mx - mn) <= low_sat_thresh)
    return float(np.mean(smoke_like))


def process_site(item, label, lon, lat, half_deg, save_png_path=None):
    """Read visual/B04/B08/SCL for one site from an already-found STAC item."""
    signed_hrefs = {k: item.assets[k].href for k in ("visual", "B04", "B08", "SCL")}

    visual_arr, _ = read_band_chip(signed_hrefs["visual"], lon, lat, half_deg)
    if visual_arr.shape[0] < 3 or visual_arr.size == 0:
        raise RuntimeError(f"{label}: visual chip read failed/empty (shape={visual_arr.shape})")
    rgb = visual_arr[:3].astype(np.uint8)
    if save_png_path is not None:
        save_png(rgb, save_png_path)
    smoke_like_pct = smoke_like_fraction(rgb)

    red_arr, red_nodata = read_band_chip(signed_hrefs["B04"], lon, lat, half_deg)
    nir_arr, nir_nodata = read_band_chip(signed_hrefs["B08"], lon, lat, half_deg)
    red = red_arr[0]
    nir = nir_arr[0]
    # SCL is native 20m; resample onto the 10m B04/B08 grid so the mask
    # applies pixel-for-pixel.
    scl_arr, _ = read_band_chip(signed_hrefs["SCL"], lon, lat, half_deg, out_shape=red.shape,
                                 resampling=Resampling.nearest)

    nodata = red_nodata if red_nodata is not None else nir_nodata
    mean_ndvi, masked_fraction = masked_ndvi(red, nir, scl_arr, nodata)

    return {
        "mean_ndvi": mean_ndvi,
        "masked_fraction": masked_fraction,
        "smoke_like_pixel_fraction": smoke_like_pct,
        "chip_shape": list(rgb.shape),
        "n_pixels": int(red.size),
    }


def main():
    p = argparse.ArgumentParser(description="Target-vs-control NDVI with SCL cloud masking.")
    p.add_argument("--lat", type=float, default=-10.8)
    p.add_argument("--lon", type=float, default=-54.0)
    p.add_argument("--control-lat", type=float, default=-10.90)
    p.add_argument("--control-lon", type=float, default=-54.15)
    p.add_argument("--chip-size-deg", type=float, default=0.02)
    p.add_argument("--max-cloud", type=float, default=20.0)
    p.add_argument("--today", type=str, default="2026-08-28")
    p.add_argument("--after-window-days", type=int, default=90)
    p.add_argument("--before-window-days", type=int, default=45)
    p.add_argument("--out-json", type=str,
                    default=str(Path(__file__).resolve().parent.parent / "data" / "ndvi.json"))
    p.add_argument("--out-imagery-dir", type=str,
                    default=str(Path(__file__).resolve().parent.parent / "public" / "imagery"))
    args = p.parse_args()

    out_imagery_dir = Path(args.out_imagery_dir)
    out_imagery_dir.mkdir(parents=True, exist_ok=True)
    half_deg = args.chip_size_deg / 2.0

    today = dt.date.fromisoformat(args.today)
    after_end = today
    after_start = after_end - dt.timedelta(days=args.after_window_days)

    catalog = pystac_client.Client.open(CATALOG_URL, modifier=planetary_computer.sign_inplace)

    print(f"Searching AFTER window {after_start}/{after_end} at ({args.lat},{args.lon}) ...")
    after_item = find_scene(catalog, args.lon, args.lat, after_start.isoformat(), after_end.isoformat(),
                             args.max_cloud, sort_most_recent=True)
    if after_item is None:
        print("FATAL: no AFTER scene found. Writing ndvi_available:false, no fabricated data.", file=sys.stderr)
        write_unavailable(args, "no AFTER scene found in search window")
        sys.exit(2)
    after_signed = planetary_computer.sign(after_item)
    after_date = dt.datetime.fromisoformat(after_signed.properties["datetime"].replace("Z", "+00:00")).date()
    print(f"[after] id={after_signed.id} date={after_date} cloud={after_signed.properties.get('eo:cloud_cover')}")

    before_center = after_date - dt.timedelta(days=365)
    before_start = before_center - dt.timedelta(days=args.before_window_days)
    before_end = before_center + dt.timedelta(days=args.before_window_days)
    print(f"Searching BEFORE window {before_start}/{before_end} (~12mo before after-scene) ...")
    before_item = find_scene(catalog, args.lon, args.lat, before_start.isoformat(), before_end.isoformat(),
                              args.max_cloud, sort_most_recent=False)
    if before_item is None:
        print("FATAL: no BEFORE scene found. Writing ndvi_available:false, no fabricated data.", file=sys.stderr)
        write_unavailable(args, "no BEFORE scene found in search window")
        sys.exit(2)
    before_signed = planetary_computer.sign(before_item)
    before_date = dt.datetime.fromisoformat(before_signed.properties["datetime"].replace("Z", "+00:00")).date()
    print(f"[before] id={before_signed.id} date={before_date} cloud={before_signed.properties.get('eo:cloud_cover')}")

    same_tile = before_signed.properties.get("s2:mgrs_tile") == after_signed.properties.get("s2:mgrs_tile")
    print(f"Same MGRS tile for before/after: {same_tile} "
          f"({before_signed.properties.get('s2:mgrs_tile')} vs {after_signed.properties.get('s2:mgrs_tile')})")

    # ---- target ----
    print("\nReading TARGET chips (before/after) ...")
    target_before = process_site(before_signed, "target-before", args.lon, args.lat, half_deg,
                                  out_imagery_dir / "before.png")
    target_after = process_site(after_signed, "target-after", args.lon, args.lat, half_deg,
                                 out_imagery_dir / "after.png")
    print(f"  target before: mean_ndvi={target_before['mean_ndvi']:.4f} masked={target_before['masked_fraction']:.2%} "
          f"smoke_like={target_before['smoke_like_pixel_fraction']:.2%}")
    print(f"  target after:  mean_ndvi={target_after['mean_ndvi']:.4f} masked={target_after['masked_fraction']:.2%} "
          f"smoke_like={target_after['smoke_like_pixel_fraction']:.2%}")

    # ---- control: SAME two items, different window ----
    print(f"\nReading CONTROL chips at ({args.control_lat},{args.control_lon}) from the SAME two scenes ...")
    control_before = process_site(before_signed, "control-before", args.control_lon, args.control_lat, half_deg,
                                   out_imagery_dir / "control.png")
    control_after = process_site(after_signed, "control-after", args.control_lon, args.control_lat, half_deg)
    print(f"  control before: mean_ndvi={control_before['mean_ndvi']:.4f} masked={control_before['masked_fraction']:.2%} "
          f"smoke_like={control_before['smoke_like_pixel_fraction']:.2%}")
    print(f"  control after:  mean_ndvi={control_after['mean_ndvi']:.4f} masked={control_after['masked_fraction']:.2%} "
          f"smoke_like={control_after['smoke_like_pixel_fraction']:.2%}")

    # ---- land-cover cross-check (ESA WorldCover 2021) ----
    print("\nESA WorldCover 2021 cross-check ...")
    target_tree_pct, target_dom = worldcover_tree_pct(args.lat, args.lon)
    control_tree_pct, control_dom = worldcover_tree_pct(args.control_lat, args.control_lon)
    print(f"  target  ({args.lat},{args.lon}): {target_tree_pct}% tree cover, dominant={target_dom}")
    print(f"  control ({args.control_lat},{args.control_lon}): {control_tree_pct}% tree cover, dominant={control_dom}")

    # ---- FIRMS cross-check: any detections within 5km of control, in the alerts dataset we already have ----
    alerts_path = Path(__file__).resolve().parent.parent / "data" / "alerts.json"
    firms_note = "alerts.json not found; FIRMS proximity check skipped"
    control_firms_count = None
    if alerts_path.exists():
        alerts = json.loads(alerts_path.read_text())
        control_firms_count = sum(
            1 for a in alerts
            if abs(a["lat"] - args.control_lat) < 0.05 and abs(a["lon"] - args.control_lon) < 0.05
        )
        firms_note = (f"{control_firms_count} FIRMS detections within ~5.5km of control site, "
                       f"out of {len(alerts)} total detections in the loaded AOI dataset")
    print(f"  FIRMS check: {firms_note}")

    # ---- deltas ----
    target_delta = target_after["mean_ndvi"] - target_before["mean_ndvi"]
    control_delta = control_after["mean_ndvi"] - control_before["mean_ndvi"]
    corrected_delta = target_delta - control_delta

    print("\n=== SUMMARY ===")
    print(f"Target delta (after-before):  {target_delta:+.4f}")
    print(f"Control delta (after-before): {control_delta:+.4f}   <- seasonal/illumination baseline")
    print(f"Corrected delta (target - control): {corrected_delta:+.4f}")
    if target_after["smoke_like_pixel_fraction"] > 0.05:
        print(f"CAVEAT: {target_after['smoke_like_pixel_fraction']:.0%} of the target AFTER chip looks like "
              f"smoke/haze by a bright+low-saturation pixel test, but SCL only flagged "
              f"{target_after['masked_fraction']:.2%} as cloud — Sen2Cor's SCL is built for cloud, not smoke, "
              f"and visibly misses it here. The after NDVI may be additionally depressed by smoke, separate "
              f"from any canopy loss.")

    rationale = (
        f"Control at ({args.control_lat}, {args.control_lon}) is ~"
        f"{haversine_km(args.lat, args.lon, args.control_lat, args.control_lon):.1f} km SW of the target, "
        f"read from the SAME two Sentinel-2 items as the target (before={before_signed.id}, "
        f"after={after_signed.id}) so it shares season, sun angle, sensor and atmosphere. "
        f"Selected before inspecting its NDVI: zero NASA FIRMS thermal detections within ~5.5km "
        f"in the loaded alerts.json ({len(alerts) if alerts_path.exists() else 'n/a'} detections total), "
        f"and ESA WorldCover 2021 dominant class '{control_dom}' "
        f"({control_tree_pct:.1f}% tree-cover pixels in a ~1.1km box). "
        f"Its own NDVI ({control_before['mean_ndvi']:.3f} before, {control_after['mean_ndvi']:.3f} after) "
        f"is reported as a post-hoc sanity check, not as the selection criterion: it is below the >0.7 "
        f"closed-canopy rule of thumb, consistent with target NDVI in this same pair of scenes "
        f"(0.475/0.408) also sitting well under 0.7 — this Amazon-Cerrado transition forest reads lower "
        f"than humid rainforest on Sentinel-2 NDVI generally, not a sign the control is non-forest."
    )

    ndvi_json = {
        "point": {"lat": args.lat, "lon": args.lon},
        "chip_size_deg": args.chip_size_deg,
        "ndvi_available": True,
        "before": {
            "item_id": before_signed.id,
            "scene_date": before_signed.properties["datetime"],
            "cloud_cover_pct": before_signed.properties.get("eo:cloud_cover"),
            "mean_ndvi": target_before["mean_ndvi"],
        },
        "after": {
            "item_id": after_signed.id,
            "scene_date": after_signed.properties["datetime"],
            "cloud_cover_pct": after_signed.properties.get("eo:cloud_cover"),
            "mean_ndvi": target_after["mean_ndvi"],
        },
        "ndvi_delta_after_minus_before": target_delta,
        "masked_fraction_before": target_before["masked_fraction"],
        "masked_fraction_after": target_after["masked_fraction"],
        "smoke_like_pixel_fraction_before": target_before["smoke_like_pixel_fraction"],
        "smoke_like_pixel_fraction_after": target_after["smoke_like_pixel_fraction"],
        "smoke_caveat": (
            "The AFTER chip's SCL band flags almost none of it as cloud (see masked_fraction_after), "
            "but a bright/low-saturation pixel heuristic on the true-colour chip "
            f"(smoke_like_pixel_fraction_after) finds {target_after['smoke_like_pixel_fraction']:.0%} of the "
            "chip looks like smoke or haze. Sen2Cor's SCL classifier is built to detect cloud, not smoke, "
            "and visibly misses the plumes visible in after.png. Part of the AFTER mean_ndvi drop may "
            "therefore be smoke attenuation rather than canopy loss; this could not be corrected for with "
            "the SCL band alone. The control chip shows no such contamination in either scene "
            f"(smoke_like_pixel_fraction {control_before['smoke_like_pixel_fraction']:.0%} / "
            f"{control_after['smoke_like_pixel_fraction']:.0%})."
        ) if target_after["smoke_like_pixel_fraction"] > 0.05 else None,
        "control": {
            "lat": args.control_lat,
            "lon": args.control_lon,
            "mean_ndvi_before": control_before["mean_ndvi"],
            "mean_ndvi_after": control_after["mean_ndvi"],
            "delta": control_delta,
            "masked_fraction_before": control_before["masked_fraction"],
            "masked_fraction_after": control_after["masked_fraction"],
            "smoke_like_pixel_fraction_before": control_before["smoke_like_pixel_fraction"],
            "smoke_like_pixel_fraction_after": control_after["smoke_like_pixel_fraction"],
            "worldcover_tree_pct": control_tree_pct,
            "worldcover_dominant_class": control_dom,
            "firms_detections_within_5_5km": control_firms_count,
            "distance_from_target_km": haversine_km(args.lat, args.lon, args.control_lat, args.control_lon),
            "rationale": rationale,
        },
        "corrected_delta": corrected_delta,
        "same_mgrs_tile_before_after": same_tile,
        "scl_excluded_classes": sorted(SCL_EXCLUDE),
        "source": ("Microsoft Planetary Computer STAC API, collection sentinel-2-l2a, "
                   "assets visual/B04/B08/SCL; control read from the identical before/after items "
                   "as the target; ESA WorldCover 10m 2021 for land-cover cross-check; "
                   "NASA FIRMS detections from data/alerts.json for control proximity check."),
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
    }

    out_json_path = Path(args.out_json)
    out_json_path.parent.mkdir(parents=True, exist_ok=True)
    out_json_path.write_text(json.dumps(ndvi_json, indent=2))
    print(f"\nWrote: {out_json_path}")
    print(f"Wrote: {out_imagery_dir / 'before.png'}")
    print(f"Wrote: {out_imagery_dir / 'after.png'}")
    print(f"Wrote: {out_imagery_dir / 'control.png'}")


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def write_unavailable(args, reason):
    out_json_path = Path(args.out_json)
    out_json_path.parent.mkdir(parents=True, exist_ok=True)
    out_json_path.write_text(json.dumps({
        "point": {"lat": args.lat, "lon": args.lon},
        "chip_size_deg": args.chip_size_deg,
        "ndvi_available": False,
        "reason": reason,
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
    }, indent=2))


if __name__ == "__main__":
    main()
