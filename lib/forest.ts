/**
 * Baseline forest cover lookup.
 *
 * NASA FIRMS reports thermal anomalies. It cannot tell a rainforest being
 * cleared from a cane field being burned off, and during the burning season
 * this landscape is full of the latter. Without a forest baseline, a fire-based
 * triage tool ranks routine agricultural burns as urgent deforestation and
 * presents them with total confidence.
 *
 * `data/forest-grid.json` holds percentage tree cover per 0.01° cell, derived
 * from ESA WorldCover 10m (2021). A 2021 baseline is deliberate: land that was
 * already cropland or grassland five years ago cannot be undergoing
 * deforestation today.
 */

export interface ForestGrid {
  bbox: { south: number; west: number; north: number; east: number };
  cellDeg: number;
  rows: number;
  cols: number;
  nodata: number;
  data: number[];
}

/**
 * Percentage tree cover at a point, or null outside the grid / where the
 * source had no data.
 *
 * Indexing contract, which must match the generator in
 * `scripts/build_forest_grid.py`: rows run north→south, columns west→east.
 */
export function treeCoverAt(
  grid: ForestGrid | null,
  lat: number,
  lon: number
): number | null {
  if (!grid) return null;

  const { bbox, cellDeg, rows, cols, nodata, data } = grid;
  if (lat > bbox.north || lat < bbox.south || lon < bbox.west || lon > bbox.east) {
    return null;
  }

  const row = Math.floor((bbox.north - lat) / cellDeg);
  const col = Math.floor((lon - bbox.west) / cellDeg);
  if (row < 0 || row >= rows || col < 0 || col >= cols) return null;

  const v = data[row * cols + col];
  if (v === undefined || v === nodata || v < 0) return null;
  return v;
}
