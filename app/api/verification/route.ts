import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { aoiDir, resolveAoi } from "@/lib/aoi";

export const runtime = "nodejs";

/**
 * Sentinel-2 NDVI corroboration for one point in one area.
 *
 * Deliberately scoped to the single location it was computed for. The chips and
 * figures come from two specific scenes; showing them against any other target
 * would present one fire's satellite evidence as another's, which in an
 * enforcement context is exactly the error this project exists to avoid. The
 * UI matches on coordinates and shows nothing when there is no match.
 */
export async function GET(request: Request) {
  const meta = await resolveAoi(new URL(request.url).searchParams.get("aoi"));
  if (!meta) return NextResponse.json(null);

  try {
    const raw = await readFile(path.join(aoiDir(meta.slug), "ndvi.json"), "utf8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    // Most areas will not ship imagery. Absence is normal, not an error.
    return NextResponse.json(null);
  }
}
