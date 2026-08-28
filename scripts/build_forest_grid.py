"""
Precompute a forest-cover lookup grid for Rangefinder.

NASA FIRMS detects heat, not forest loss. A fire on land that was already
pasture/cropland in 2021 is agricultural burning, not deforestation. This
script builds a fast runtime lookup of baseline (2021) tree-cover percentage
so the scoring function can down-weight fires on already-cleared land,
without querying the remote ESA WorldCover raster per-request (see
scripts/validate_landcover.py for that slower, per-point approach).

Source: ESA WorldCover 10m v200 (2021), public COGs on S3, opened via
GDAL's /vsicurl/ virtual filesystem (keyless, no auth needed). Tiles are
3x3 degree, named by SW corner (e.g. S12W054). Class 10 = "Tree cover".

Because reading full 10m resolution over the whole bounding box would be
hundreds of millions of pixels, each tile is read at a DECIMATED resolution
(via rasterio's out_shape + nearest-neighbor resampling, which GDAL serves
efficiently from the COG's built-in overviews). Within each 0.01-degree
output cell this gives a ~20x20 = 400-point evenly-spaced sample of the
10m pixels, and the reported percentage is the tree-cover fraction of that
sample -- an estimate, not an exact pixel census.

Output schema (data/forest-grid.json) -- rows count from NORTH to SOUTH,
cols count from WEST to EAST:
    row = floor((north - lat) / cellDeg)
    col = floor((lon - west) / cellDeg)
    flat index = row * cols + col
"""
import json
import math
import os
import time
from datetime import datetime, timezone

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from rasterio.enums import Resampling

# ---------------------------------------------------------------- config --

BBOX = {"south": -12.75, "west": -55.30, "north": -10.05, "east": -52.85}
CELL_DEG = 0.01
SAMPLES_PER_CELL_EDGE = 20          # -> ~400 sample points per output cell
NODATA = -1
TREE_CLASS = 10

BASE_URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"
TILE_NAME = "ESA_WorldCover_10m_2021_v200_{ns}{ew}_Map.tif"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(SCRIPT_DIR, "..", "data", "forest-grid.json")

# Spot-check points: (lat, lon, expected %tree from validate_landcover.py)
SPOT_CHECKS = [
    (-11.7363, -54.5342, 98),
    (-10.7751, -54.0103, 100),
    (-12.1673, -53.4352, 87),
]

EPS = 1e-9


def tile_sw_corners(bbox):
    """Enumerate the SW corners (la, lo) of every 3x3 degree WorldCover
    tile that intersects bbox."""
    la0 = math.floor(bbox["south"] / 3) * 3
    la1 = math.floor((bbox["north"] - EPS) / 3) * 3
    lo0 = math.floor(bbox["west"] / 3) * 3
    lo1 = math.floor((bbox["east"] - EPS) / 3) * 3
    corners = []
    la = la0
    while la <= la1:
        lo = lo0
        while lo <= lo1:
            corners.append((la, lo))
            lo += 3
        la += 3
    return corners


def tile_url(la, lo):
    ns = f"{'S' if la < 0 else 'N'}{abs(la):02d}"
    ew = f"{'W' if lo < 0 else 'E'}{abs(lo):03d}"
    return f"/vsicurl/{BASE_URL}/{TILE_NAME.format(ns=ns, ew=ew)}"


def main():
    south, west, north, east = BBOX["south"], BBOX["west"], BBOX["north"], BBOX["east"]
    rows = round((north - south) / CELL_DEG)
    cols = round((east - west) / CELL_DEG)
    print(f"grid: {rows} rows x {cols} cols = {rows*cols} cells "
          f"(cellDeg={CELL_DEG}, bbox={BBOX})")

    tree_count = np.zeros((rows, cols), dtype=np.int64)
    total_count = np.zeros((rows, cols), dtype=np.int64)

    corners = tile_sw_corners(BBOX)
    print(f"tiles to fetch: {[f'S{abs(la):02d}W{abs(lo):03d}' for la, lo in corners]}")

    samp_deg = CELL_DEG / SAMPLES_PER_CELL_EDGE
    t_start = time.time()

    for la, lo in corners:
        tile_south, tile_north = la, la + 3
        tile_west, tile_east = lo, lo + 3

        ov_west = max(tile_west, west)
        ov_east = min(tile_east, east)
        ov_south = max(tile_south, south)
        ov_north = min(tile_north, north)
        if ov_west >= ov_east or ov_south >= ov_north:
            continue  # no overlap with target bbox

        w_deg = ov_east - ov_west
        h_deg = ov_north - ov_south
        out_w = max(1, round(w_deg / samp_deg))
        out_h = max(1, round(h_deg / samp_deg))

        url = tile_url(la, lo)
        t0 = time.time()
        try:
            with rasterio.open(url) as src:
                win = from_bounds(ov_west, ov_south, ov_east, ov_north, src.transform)
                arr = src.read(1, window=win, out_shape=(out_h, out_w),
                                resampling=Resampling.nearest)
            print(f"  {url.split('/')[-1]}: read {out_h}x{out_w} samples "
                  f"in {time.time()-t0:.1f}s")
        except Exception as e:
            print(f"  {url.split('/')[-1]}: FAILED ({type(e).__name__}: {str(e)[:80]}) "
                  f"-> cells left as no-data unless covered by another tile")
            continue

        # geo coords of each decimated sample (pixel centers)
        lat_arr = ov_north - (np.arange(out_h) + 0.5) * (h_deg / out_h)
        lon_arr = ov_west + (np.arange(out_w) + 0.5) * (w_deg / out_w)

        row_idx = np.floor((north - lat_arr) / CELL_DEG).astype(np.int64)
        col_idx = np.floor((lon_arr - west) / CELL_DEG).astype(np.int64)
        row_idx = np.clip(row_idx, 0, rows - 1)
        col_idx = np.clip(col_idx, 0, cols - 1)

        row_grid, col_grid = np.meshgrid(row_idx, col_idx, indexing="ij")
        flat_idx = (row_grid * cols + col_grid).ravel()

        valid = arr.ravel() != 0  # WorldCover nodata value is 0
        tree = valid & (arr.ravel() == TREE_CLASS)

        total_bins = np.bincount(flat_idx[valid], minlength=rows * cols)
        tree_bins = np.bincount(flat_idx[tree], minlength=rows * cols)

        total_count += total_bins.reshape(rows, cols)
        tree_count += tree_bins.reshape(rows, cols)

    print(f"all tiles processed in {time.time()-t_start:.1f}s")

    has_data = total_count > 0
    pct = np.full((rows, cols), NODATA, dtype=np.int64)
    pct[has_data] = np.round(100.0 * tree_count[has_data] / total_count[has_data]).astype(np.int64)

    data = pct.ravel().tolist()

    meta = {
        "source": "ESA WorldCover 10m v200 (2021)",
        "url": "https://esa-worldcover.org/",
        "licence": "CC BY 4.0 - (c) ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "description": (
            "Percentage tree cover (WorldCover class 10) per 0.01 degree cell, "
            "estimated from a decimated ~20x20 sample of 10m pixels per cell "
            "(not an exact pixel census). rows count NORTH to SOUTH, cols count "
            "WEST to EAST: row = floor((north - lat) / cellDeg), "
            "col = floor((lon - west) / cellDeg), flat index = row * cols + col."
        ),
    }
    out = {
        "_meta": meta,
        "bbox": BBOX,
        "cellDeg": CELL_DEG,
        "rows": rows,
        "cols": cols,
        "nodata": NODATA,
        "data": data,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    size_bytes = os.path.getsize(OUT_PATH)

    n_cells = rows * cols
    n_with_data = int(has_data.sum())
    mean_tree = float(np.mean(pct[has_data])) if n_with_data else float("nan")

    print()
    print(f"wrote {OUT_PATH}")
    print(f"grid: {rows} rows x {cols} cols = {n_cells} cells")
    print(f"file size: {size_bytes} bytes ({size_bytes/1024/1024:.3f} MB)")
    print(f"cells with data: {n_with_data}/{n_cells} ({100*n_with_data/n_cells:.1f}%)")
    print(f"mean tree cover (over cells with data): {mean_tree:.1f}%")

    print()
    print("spot checks (row = floor((north-lat)/cellDeg), col = floor((lon-west)/cellDeg)):")
    for lat, lon, expected in SPOT_CHECKS:
        r = math.floor((north - lat) / CELL_DEG)
        c = math.floor((lon - west) / CELL_DEG)
        if 0 <= r < rows and 0 <= c < cols:
            val = data[r * cols + c]
            diff = "?" if val == NODATA else f"{val - expected:+d}pp"
            print(f"  lat={lat} lon={lon}: row={r} col={c} -> grid={val}%  "
                  f"expected~{expected}%  diff={diff}")
        else:
            print(f"  lat={lat} lon={lon}: row={r} col={c} -> OUT OF GRID BOUNDS")


if __name__ == "__main__":
    main()
