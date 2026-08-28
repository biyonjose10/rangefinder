/**
 * Baseline forest cover lookup.
 *
 * NASA FIRMS reports thermal anomalies. It cannot tell a rainforest being
 * cleared from a cane field being burned off, and during the burning season
 * this landscape is full of the latter. Without a forest baseline, a fire-based
 * triage tool ranks routine agricultural burns as urgent deforestation and
 * presents them with total confidence.
 *
 * `data/aoi/<slug>/forest-grid.json` holds percentage tree cover per 0.01° cell
 * from ESA WorldCover 10m (2021), plus the percentage of each cell cleared
 * since that baseline, from Hansen Global Forest Change through 2024.
 *
 * Both halves are necessary. A 2021 baseline is deliberate — land that was
 * already cropland five years ago cannot be undergoing deforestation today —
 * but on its own it is five years stale, so anything cleared between 2022 and
 * 2025 still reads as intact forest. The app would then render a confident
 * "100% FOREST BASELINE" badge over a field cleared in 2023 and rank a stubble
 * burn there as urgent deforestation, which is precisely the failure the forest
 * factor exists to prevent.
 *
 * Subtracting the loss layer closes three of those five years. Hansen has not
 * published 2025 or 2026, so the correction is conservative rather than
 * complete, and `treeCoverAt` says so via `corrected`.
 */

export interface ForestGrid {
  bbox: { south: number; west: number; north: number; east: number };
  cellDeg: number;
  rows: number;
  cols: number;
  nodata: number;
  data: number[];
  /** Percentage of each cell cleared since the baseline year, if available. */
  lossSinceBaseline?: number[];
  lossMeta?: { baselineYear: number; lossThroughYear: number };
}

/**
 * Percentage tree cover at a point, or null outside the grid / where the
 * source had no data.
 *
 * Indexing contract, which must match the generator in
 * `scripts/build_forest_grid.py`: rows run north→south, columns west→east.
 */
function cellIndex(grid: ForestGrid, lat: number, lon: number): number | null {
  const { bbox, cellDeg, rows, cols } = grid;
  if (lat > bbox.north || lat < bbox.south || lon < bbox.west || lon > bbox.east) {
    return null;
  }
  const row = Math.floor((bbox.north - lat) / cellDeg);
  const col = Math.floor((lon - bbox.west) / cellDeg);
  if (row < 0 || row >= rows || col < 0 || col >= cols) return null;
  return row * cols + col;
}

/**
 * Tree cover at a point, corrected for clearing since the baseline.
 *
 * Returns null outside the grid or where the source had no data.
 */
export function treeCoverAt(
  grid: ForestGrid | null,
  lat: number,
  lon: number
): number | null {
  if (!grid) return null;
  const i = cellIndex(grid, lat, lon);
  if (i === null) return null;

  const base = grid.data[i];
  if (base === undefined || base === grid.nodata || base < 0) return null;

  const lost = grid.lossSinceBaseline?.[i];
  if (lost === undefined || lost < 0) return base;

  // Clearing removes cover; it cannot create it, and cannot take it below zero.
  return Math.max(0, Math.round(base * (1 - lost / 100)));
}

/** How much cover this cell has lost since the baseline, for the rationale. */
export function forestLossAt(
  grid: ForestGrid | null,
  lat: number,
  lon: number
): number | null {
  if (!grid?.lossSinceBaseline) return null;
  const i = cellIndex(grid, lat, lon);
  if (i === null) return null;
  const v = grid.lossSinceBaseline[i];
  return v === undefined || v < 0 ? null : v;
}
