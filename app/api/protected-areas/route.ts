import { NextResponse } from "next/server";

import { loadAoiData, resolveAoi } from "@/lib/aoi";

export const runtime = "nodejs";

/** Boundary geometry for one area. Served separately from /api/targets because
 *  it runs to thousands of nodes and the map needs it once per area, not on
 *  every refresh of the target list. */
export async function GET(request: Request) {
  const meta = await resolveAoi(new URL(request.url).searchParams.get("aoi"));
  if (!meta) return NextResponse.json([]);
  const { protectedAreas } = await loadAoiData(meta);
  return NextResponse.json(protectedAreas);
}
