"""
Age-correct a forest-grid.json baseline with post-2021 tree-cover loss.

data/aoi/*/forest-grid.json holds percentage tree cover per 0.01-degree cell,
derived from ESA WorldCover 2021 (see build_forest_grid.py). The fire
detections it is compared against are from 2026, so anything cleared between
2022 and 2025 is still recorded as intact forest -- a farmer burning stubble
on land cleared in 2023 currently reads as "100% FOREST BASELINE" and ranks
as top-priority deforestation, which is exactly the failure mode the forest
factor was added to prevent.

This script adds a second, independent field -- "lossSinceBaseline" -- built
from Hansen Global Forest Change v1.12 (2024), lossyear band. It does NOT
touch "data" (the original WorldCover 2021 percentages) or any of rows/cols/
bbox/cellDeg; the app (or a future scoring pass) can subtract lossSinceBaseline
from data to get an age-corrected tree-cover estimate.

Source: https://storage.googleapis.com/earthenginepartners-hansen/GFC-2024-v1.12/
Hansen_GFC-2024-v1.12_lossyear_{TILE}.tif, opened via GDAL's /vsicurl/ virtual
filesystem (keyless, no auth needed) -- same pattern as build_forest_grid.py
and validate_landcover.py. Tiles are 10x10 degrees, named by their NW corner,
e.g. "10S_060W", "00N_110E". Pixel values: 0 = no loss detected; 1-24 = loss
in year 2001-2024 respectively. Loss since the WorldCover 2021 baseline is
any pixel with value >= 21 (loss recorded in 2021, 2022, 2023 or 2024).

Because reading full 30m resolution over the grid's bounding box would be a
huge number of pixels, each tile is read at a DECIMATED resolution (via
rasterio's out_shape + nearest-neighbor resampling, served efficiently from
the COG's built-in overviews) -- the same approach build_forest_grid.py uses
for the 10m WorldCover tiles. Within each 0.01-degree cell this gives a
~20x20 = 400-point evenly-spaced sample (SAMPLES_PER_CELL_EDGE), and the
reported loss percentage is the loss fraction of that sample, not an exact
pixel census.

A cell may span two (or four) Hansen tiles; each tile's overlap with the
target grid is accumulated separately (loss_count / total_count per cell),
so results mosaic correctly. If a tile fails to fetch, the cells it would
have covered are left at NODATA (-1) rather than crashing the run, unless
another tile also covers them.

Usage:
    python scripts/add_forest_loss.py --grid data/aoi/upper-xingu/forest-grid.json
    python scripts/add_forest_loss.py --grid data/aoi/kalimantan-sebangau/forest-grid.json

Re-running is safe: lossSinceBaseline/lossMeta are recomputed fresh and
overwrite only themselves; "data", "rows", "cols", "bbox", "cellDeg" and
"_meta" are read from the existing file and written back unchanged.
"""
import argparse
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

BASE_URL = "https://storage.googleapis.com/earthenginepartners-hansen/GFC-2024-v1.12"
TILE_FILE = "Hansen_GFC-2024-v1.12_lossyear_{tile}.tif"

SAMPLES_PER_CELL_EDGE = 20     # -> ~400 sample points per output cell
NODATA = -1

BASELINE_YEAR = 2021
LOSS_THROUGH_YEAR = 2024
LOSS_YEAR_CODE_MIN = BASELINE_YEAR - 2000   # 21: lossyear codes >= this are >=2021

EPS = 1e-9

SOURCE_META = {
    "source": "Hansen Global Forest Change v1.12 lossyear band",
    "url": "https://glad.umd.edu/dataset/global-2010-forest-change-1-00",
    "licence": "CC BY 4.0 - Hansen/UMD/Google/USGS/NASA",
    "baselineYear": BASELINE_YEAR,
    "lossThroughYear": LOSS_THROUGH_YEAR,
    "note": (
        "Percentage of each cell showing tree-cover loss in 2021 or later. "
        "Subtract from `data` to age-correct the ESA WorldCover 2021 baseline. "
        "Loss during 2025-2026 is not yet published and remains uncorrected. "
        f"Estimated from a decimated ~{SAMPLES_PER_CELL_EDGE}x{SAMPLES_PER_CELL_EDGE} "
        "sample of 30m pixels per cell (not an exact pixel census)."
    ),
}


# --------------------------------------------------------------- tiling ---

def tile_north_edge(lat):
    """North edge (deg) of the 10x10 Hansen tile containing lat. Tile spans
    [north_edge - 10, north_edge)."""
    return math.ceil(lat / 10) * 10


def tile_west_edge(lon):
    """West edge (deg) of the 10x10 Hansen tile containing lon. Tile spans
    [west_edge, west_edge + 10)."""
    return math.floor(lon / 10) * 10


def tile_name(north_edge, west_edge):
    ns = f"{abs(north_edge):02d}{'N' if north_edge >= 0 else 'S'}"
    ew = f"{abs(west_edge):03d}{'E' if west_edge >= 0 else 'W'}"
    return f"{ns}_{ew}"


def tile_nw_corners(bbox):
    """Enumerate NW corners (north_edge, west_edge) of every 10x10 degree
    Hansen tile that intersects bbox."""
    lo_n = tile_north_edge(bbox["south"])
    hi_n = tile_north_edge(bbox["north"] - EPS)
    lo_w = tile_west_edge(bbox["west"])
    hi_w = tile_west_edge(bbox["east"] - EPS)

    corners = []
    n = hi_n
    while n >= lo_n:
        w = lo_w
        while w <= hi_w:
            corners.append((n, w))
            w += 10
        n -= 10
    return corners


def tile_url(n, w):
    return f"/vsicurl/{BASE_URL}/{TILE_FILE.format(tile=tile_name(n, w))}"


# ----------------------------------------------------------------- main ---

def _parse_cli():
    ap = argparse.ArgumentParser(
        description="Add post-2021 (Hansen GFC) tree-cover-loss percentages to a forest-grid.json."
    )
    ap.add_argument("--grid", required=True, help="path to the forest-grid.json to update in place")
    ap.add_argument("--samples-per-cell-edge", type=int, default=SAMPLES_PER_CELL_EDGE,
                     help="decimated sample grid per cell edge (default %(default)s)")
    return ap.parse_args()


def main():
    args = _parse_cli()
    grid_path = args.grid
    samples_per_cell_edge = args.samples_per_cell_edge

    with open(grid_path, "r", encoding="utf-8") as f:
        grid = json.load(f)

    bbox = grid["bbox"]
    cell_deg = grid["cellDeg"]
    rows = grid["rows"]
    cols = grid["cols"]
    south, west, north, east = bbox["south"], bbox["west"], bbox["north"], bbox["east"]

    # snapshot of the fields that must not change, for the post-write assertion
    before = {
        "data": list(grid["data"]),
        "rows": rows,
        "cols": cols,
        "bbox": dict(bbox),
        "cellDeg": cell_deg,
    }

    print(f"grid: {grid_path}")
    print(f"grid: {rows} rows x {cols} cols = {rows*cols} cells (cellDeg={cell_deg}, bbox={bbox})")

    loss_count = np.zeros((rows, cols), dtype=np.int64)
    total_count = np.zeros((rows, cols), dtype=np.int64)

    corners = tile_nw_corners(bbox)
    print(f"tiles to fetch: {[tile_name(n, w) for n, w in corners]}")

    samp_deg = cell_deg / samples_per_cell_edge
    t_start = time.time()

    any_tile_ok = False
    for n, w in corners:
        tile_north, tile_south = n, n - 10
        tile_west, tile_east = w, w + 10

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

        url = tile_url(n, w)
        t0 = time.time()
        try:
            with rasterio.open(url) as src:
                win = from_bounds(ov_west, ov_south, ov_east, ov_north, src.transform)
                arr = src.read(1, window=win, out_shape=(out_h, out_w),
                                resampling=Resampling.nearest)
            print(f"  {tile_name(n, w)}: read {out_h}x{out_w} samples in {time.time()-t0:.1f}s")
            any_tile_ok = True
        except Exception as e:
            print(f"  {tile_name(n, w)}: FAILED ({type(e).__name__}: {str(e)[:80]}) "
                  f"-> cells left as no-data unless covered by another tile")
            continue

        lat_arr = ov_north - (np.arange(out_h) + 0.5) * (h_deg / out_h)
        lon_arr = ov_west + (np.arange(out_w) + 0.5) * (w_deg / out_w)

        row_idx = np.floor((north - lat_arr) / cell_deg).astype(np.int64)
        col_idx = np.floor((lon_arr - west) / cell_deg).astype(np.int64)
        row_idx = np.clip(row_idx, 0, rows - 1)
        col_idx = np.clip(col_idx, 0, cols - 1)

        row_grid, col_grid = np.meshgrid(row_idx, col_idx, indexing="ij")
        flat_idx = (row_grid * cols + col_grid).ravel()

        vals = arr.ravel()
        # lossyear band has no declared nodata; every 0-24 value is valid data.
        valid = np.ones_like(vals, dtype=bool)
        loss = valid & (vals >= LOSS_YEAR_CODE_MIN) & (vals <= 24)

        total_bins = np.bincount(flat_idx[valid], minlength=rows * cols)
        loss_bins = np.bincount(flat_idx[loss], minlength=rows * cols)

        total_count += total_bins.reshape(rows, cols)
        loss_count += loss_bins.reshape(rows, cols)

    print(f"all tiles processed in {time.time()-t_start:.1f}s")
    if not any_tile_ok:
        print("WARNING: no tile could be fetched; lossSinceBaseline will be all no-data.")

    has_data = total_count > 0
    pct = np.full((rows, cols), NODATA, dtype=np.int64)
    pct[has_data] = np.round(100.0 * loss_count[has_data] / total_count[has_data]).astype(np.int64)

    loss_list = pct.ravel().tolist()

    loss_meta = dict(SOURCE_META)
    loss_meta["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    grid["lossSinceBaseline"] = loss_list
    grid["lossMeta"] = loss_meta

    with open(grid_path, "w", encoding="utf-8") as f:
        json.dump(grid, f, separators=(",", ":"))

    # ------------------------------------------------------------ verify --
    with open(grid_path, "r", encoding="utf-8") as f:
        after_full = json.load(f)

    ok = (
        after_full["data"] == before["data"]
        and after_full["rows"] == before["rows"]
        and after_full["cols"] == before["cols"]
        and after_full["bbox"] == before["bbox"]
        and after_full["cellDeg"] == before["cellDeg"]
        and len(after_full["lossSinceBaseline"]) == before["rows"] * before["cols"]
    )
    print()
    print(f"verify: data/rows/cols/bbox/cellDeg unchanged, lossSinceBaseline length correct -> "
          f"{'PASS' if ok else 'FAIL'}")
    if not ok:
        raise SystemExit("VERIFICATION FAILED -- see above")

    # ------------------------------------------------------------ summary -
    n_cells = rows * cols
    n_with_data = int(has_data.sum())
    mean_loss = float(np.mean(pct[has_data])) if n_with_data else float("nan")
    n_gt10 = int(np.sum((pct != NODATA) & (pct > 10)))

    print()
    print(f"wrote {grid_path}")
    print(f"grid size: {rows} rows x {cols} cols = {n_cells} cells")
    print(f"cells with data: {n_with_data}/{n_cells} ({100*n_with_data/n_cells:.1f}%)")
    print(f"mean loss-since-baseline (over cells with data): {mean_loss:.2f}%")
    print(f"cells with >10% loss since baseline: {n_gt10}")

    # top cells by loss %, for spot-checking
    order = np.argsort(pct.ravel())[::-1]
    print()
    print("top cells by loss-since-baseline %:")
    shown = 0
    for idx in order:
        v = int(pct.ravel()[idx])
        if v <= 0:
            break
        r, c = divmod(int(idx), cols)
        lat = north - (r + 0.5) * cell_deg
        lon = west + (c + 0.5) * cell_deg
        base_pct = before["data"][idx]
        print(f"  row={r} col={c} lat={lat:.4f} lon={lon:.4f}  "
              f"lossSinceBaseline={v}%  baselineTree(data)={base_pct}%")
        shown += 1
        if shown >= 10:
            break
    if shown == 0:
        print("  (no cells with loss > 0)")


if __name__ == "__main__":
    main()
