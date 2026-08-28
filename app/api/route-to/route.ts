import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getRoadGraph } from "@/lib/route";
import { AOI } from "@/lib/config";
import type { RangerPost, RoadSegment } from "@/lib/types";

export const runtime = "nodejs";

/**
 * The road route from the ranger post to an arbitrary point.
 *
 * Served separately from /api/targets because the polyline is large and only
 * one target is ever displayed at a time. Sending ten routes with every list
 * refresh would multiply the payload for geometry nobody is looking at.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon are required" }, { status: 400 });
  }

  const dir = path.join(process.cwd(), "data");
  const read = async <T,>(f: string, fallback: T): Promise<T> => {
    try {
      return JSON.parse(await readFile(path.join(dir, f), "utf8")) as T;
    } catch {
      return fallback;
    }
  };

  const [roads, post] = await Promise.all([
    read<RoadSegment[]>("roads-routing.json", []),
    read<RangerPost>("ranger-post.json", {
      name: "Field Station (unset)",
      lat: (AOI.south + AOI.north) / 2,
      lon: (AOI.west + AOI.east) / 2,
    }),
  ]);

  if (!roads.length) {
    return NextResponse.json({ routed: false, reason: "no road network loaded" });
  }

  const result = getRoadGraph(roads).route(post, { lat, lon });

  if (!result) {
    // Not an error. A target with no vehicle route is a real operational
    // finding — it means air or river access — and the UI says so.
    return NextResponse.json({
      routed: false,
      reason: "no road route exists between the ranger post and this target",
      post,
    });
  }

  return NextResponse.json({
    routed: true,
    post,
    roadKm: result.roadMetres / 1000,
    driveHours: result.driveHours,
    offRoadKm: result.offRoadMetres / 1000,
    detourRatio: result.detourRatio,
    geometry: result.geometry,
  });
}
