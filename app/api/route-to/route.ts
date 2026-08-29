import { NextResponse } from "next/server";

import { getRoadGraph } from "@/lib/route";
import { loadAoiData, resolveAoi } from "@/lib/aoi";

export const runtime = "nodejs";

/**
 * The road route from an area's ranger post to an arbitrary point.
 *
 * Served separately from /api/targets because the polyline is large and only
 * one target is ever displayed at a time. Sending ten routes with every list
 * refresh would multiply the payload for geometry nobody is looking at.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon are required" }, { status: 400 });
  }

  // Optional origin. Without it the route starts at the ranger post, which is
  // what a single target needs; a leg of a planned day starts at the previous
  // target instead.
  const fromLat = Number(params.get("fromLat"));
  const fromLon = Number(params.get("fromLon"));
  const hasOrigin = Number.isFinite(fromLat) && Number.isFinite(fromLon);

  const meta = await resolveAoi(params.get("aoi"));
  if (!meta) return NextResponse.json({ routed: false, reason: "no area configured" });

  const { roads } = await loadAoiData(meta);
  if (!roads.length) {
    return NextResponse.json({ routed: false, reason: "no road network for this area" });
  }

  const origin = hasOrigin ? { lat: fromLat, lon: fromLon } : meta.post;
  const result = getRoadGraph(meta.slug, roads).route(origin, { lat, lon });

  if (!result) {
    // Not an error. A target with no vehicle route is a real operational
    // finding — it means air or river access — and the UI says so.
    return NextResponse.json({
      routed: false,
      reason: hasOrigin
        ? "no road route exists between these two points"
        : "no road route exists between the ranger post and this target",
      post: meta.post,
    });
  }

  return NextResponse.json({
    routed: true,
    post: meta.post,
    roadKm: result.roadMetres / 1000,
    driveHours: result.driveHours,
    offRoadKm: result.offRoadMetres / 1000,
    detourRatio: result.detourRatio,
    geometry: result.geometry,
  });
}
