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
  // Presence first, then value. Number(null) is 0 and 0 is finite, so
  // converting before checking would accept a request with no coordinates at
  // all and route to (0, 0) instead of rejecting it.
  const latRaw = params.get("lat");
  const lonRaw = params.get("lon");
  const lat = Number(latRaw);
  const lon = Number(lonRaw);

  if (
    latRaw === null ||
    lonRaw === null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return NextResponse.json(
      { error: "lat and lon are required and must be valid coordinates" },
      { status: 400 }
    );
  }

  // Optional origin. Without it the route starts at the ranger post, which is
  // what a single target needs; a leg of a planned day starts at the previous
  // target instead.
  // Test for the parameter's presence before converting. Number(null) is 0,
  // and Number.isFinite(0) is true, so converting first silently treats a
  // missing origin as the Gulf of Guinea — where there are no roads, so the
  // leg comes back unroutable. That is exactly what broke the outbound leg of
  // the planned day while the return leg, which had a real origin, worked.
  const fromLatRaw = params.get("fromLat");
  const fromLonRaw = params.get("fromLon");
  const fromLat = Number(fromLatRaw);
  const fromLon = Number(fromLonRaw);
  const hasOrigin =
    fromLatRaw !== null &&
    fromLonRaw !== null &&
    Number.isFinite(fromLat) &&
    Number.isFinite(fromLon);

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
