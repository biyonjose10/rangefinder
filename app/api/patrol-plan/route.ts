import { NextResponse } from "next/server";

import { buildTargets } from "@/lib/pipeline";
import { PATROL_ORDER_SIZE } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The sequenced patrol for one area.
 *
 * Served separately from /api/targets because sequencing needs a road route
 * between every pair of tasked targets — fifteen A* traversals for five
 * targets, against five for the plain queue. The list must stay responsive, so
 * the interface asks for the plan only when someone actually wants the day laid
 * out.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const size = Math.min(
    8,
    Math.max(1, Number(params.get("size")) || PATROL_ORDER_SIZE)
  );

  const data = await buildTargets(params.get("aoi"), size);
  if (!data) {
    return NextResponse.json(
      { error: "No areas of operation are configured." },
      { status: 503 }
    );
  }

  return NextResponse.json({
    aoi: data.aoi,
    post: data.post,
    tour: data.tour,
    // Only what the plan needs, so the payload stays small.
    targets: data.targets.slice(0, size).map((t) => ({
      id: t.id,
      lat: t.lat,
      lon: t.lon,
      score: t.score,
      count: t.count,
      protectedArea: t.protectedArea,
      routed: t.routed,
    })),
  });
}
