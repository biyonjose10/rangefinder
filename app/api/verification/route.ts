import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

/**
 * Sentinel-2 NDVI verification for a single point.
 *
 * Deliberately scoped to the one location it was actually computed for. The
 * chips and the NDVI figures come from two specific Sentinel-2 scenes read at
 * build time; showing them against any other target would be presenting one
 * fire's satellite evidence as though it were another's, which in an
 * enforcement context is exactly the kind of error this project exists to
 * avoid. The UI matches on coordinates and shows nothing when there is no
 * match.
 */
export interface Verification {
  point: { lat: number; lon: number };
  ndvi_available: boolean;
  before: { scene_date: string; cloud_cover_pct: number; mean_ndvi: number };
  after: { scene_date: string; cloud_cover_pct: number; mean_ndvi: number };
  ndvi_delta_after_minus_before: number;
  source: string;
}

export async function GET() {
  try {
    const raw = await readFile(path.join(process.cwd(), "data", "ndvi.json"), "utf8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json(null);
  }
}
