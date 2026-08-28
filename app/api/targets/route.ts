import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { clusterAlerts } from "@/lib/cluster";
import { rankTargets } from "@/lib/score";
import { getRoadGraph } from "@/lib/route";
import { analyseRobustness } from "@/lib/sensitivity";
import { treeCoverAt, type ForestGrid } from "@/lib/forest";
import { fetchLiveAlerts, parseFirmsCsv } from "@/lib/sources/firms";
import { AOI, AOI_REGION, AOI_LABEL, DEMO_MODE } from "@/lib/config";
import type { Alert, ProtectedArea, RangerPost, RoadSegment } from "@/lib/types";

export const runtime = "nodejs";
export const revalidate = 900;

const DATA_DIR = path.join(process.cwd(), "data");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf8")) as T;
  } catch {
    // A missing context fixture degrades the score's precision but must never
    // take the endpoint down — an unreachable road file is not a reason to
    // withhold the alert list from a ranger.
    return fallback;
  }
}

async function loadAlerts(): Promise<{ alerts: Alert[]; live: boolean; note?: string }> {
  if (!DEMO_MODE) {
    try {
      const alerts = await fetchLiveAlerts(AOI_REGION, AOI, AbortSignal.timeout(20000));
      if (alerts.length > 0) return { alerts, live: true };
      // A genuinely empty AOI is possible (rain, cloud, no burning). Fall through
      // to the cached snapshot so the interface still has something to show,
      // clearly labelled as such.
      return {
        alerts: await loadCachedAlerts(),
        live: false,
        note: "No live detections in AOI right now — showing last cached snapshot.",
      };
    } catch (err) {
      return {
        alerts: await loadCachedAlerts(),
        live: false,
        note: `Live FIRMS fetch failed (${(err as Error).message}) — served from cache.`,
      };
    }
  }
  return { alerts: await loadCachedAlerts(), live: false, note: "DEMO_MODE is on." };
}

async function loadCachedAlerts(): Promise<Alert[]> {
  const cached = await readJson<Alert[] | null>("alerts.json", null);
  if (cached && cached.length) return cached;

  // Last resort: a raw CSV snapshot committed to the repo.
  try {
    const csv = await readFile(path.join(DATA_DIR, "firms-snapshot.csv"), "utf8");
    return parseFirmsCsv(csv, AOI);
  } catch {
    return [];
  }
}

export async function GET() {
  const started = Date.now();

  const [{ alerts, live, note }, roads, routingRoads, protectedAreas, post, forestGrid] =
    await Promise.all([
      loadAlerts(),
      readJson<RoadSegment[]>("roads.json", []),
      // A separate, wider extract restricted to vehicle-navigable classes. The
      // presentation network is clipped to the AOI and so does not even contain
      // the ranger post, which sits outside it.
      readJson<RoadSegment[]>("roads-routing.json", []),
      readJson<ProtectedArea[]>("protected-areas.json", []),
      readJson<RangerPost>("ranger-post.json", {
        name: "Field Station (unset)",
        lat: (AOI.south + AOI.north) / 2,
        lon: (AOI.west + AOI.east) / 2,
      }),
      readJson<ForestGrid | null>("forest-grid.json", null),
    ]);

  const clusters = clusterAlerts(alerts);

  const graph = routingRoads.length ? getRoadGraph(routingRoads) : null;

  const targets = rankTargets(clusters, {
    post,
    roads,
    protectedAreas,
    perCluster: (c) => ({
      route: graph ? graph.route(post, { lat: c.lat, lon: c.lon }) : null,
      treeCoverPct: treeCoverAt(forestGrid, c.lat, c.lon),
    }),
  });

  // Attach robustness so the interface can distinguish a target that leads
  // under any reasonable weighting from one that only leads under ours.
  const robustness = analyseRobustness(targets, 5);
  for (const t of targets) t.robustness = robustness.get(t.id);

  return NextResponse.json({
    aoi: { ...AOI, label: AOI_LABEL },
    post,
    live,
    note,
    counts: {
      detections: alerts.length,
      events: clusters.length,
      roadSegments: roads.length,
      protectedAreas: protectedAreas.length,
      routingNodes: graph?.size ?? 0,
      routed: targets.filter((t) => t.routed).length,
    },
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    targets,
  });
}
