import { NextResponse } from "next/server";

import { clusterAlerts } from "@/lib/cluster";
import { rankTargets } from "@/lib/score";
import { getRoadGraph } from "@/lib/route";
import { analyseRobustness } from "@/lib/sensitivity";
import { treeCoverAt } from "@/lib/forest";
import { listAois, loadAoiData, loadCachedAlerts, resolveAoi } from "@/lib/aoi";
import { fetchLiveAlerts } from "@/lib/sources/firms";
import { DEMO_MODE } from "@/lib/config";
import type { Alert } from "@/lib/types";
import type { AoiMeta } from "@/lib/aoi";

export const runtime = "nodejs";
export const revalidate = 900;

async function loadAlerts(
  meta: AoiMeta
): Promise<{ alerts: Alert[]; live: boolean; note?: string }> {
  if (DEMO_MODE) {
    return { alerts: await loadCachedAlerts(meta), live: false, note: "DEMO_MODE is on." };
  }

  try {
    const alerts = await fetchLiveAlerts(meta.region, meta.bbox, AbortSignal.timeout(20000));
    if (alerts.length > 0) return { alerts, live: true };
    // An empty area is entirely possible — rain, cloud, nothing burning. Fall
    // back to the snapshot so the interface still has something to show,
    // clearly labelled.
    return {
      alerts: await loadCachedAlerts(meta),
      live: false,
      note: "No live detections in this area right now — showing the last cached snapshot.",
    };
  } catch (err) {
    return {
      alerts: await loadCachedAlerts(meta),
      live: false,
      note: `Live FIRMS fetch failed (${(err as Error).message}) — served from cache.`,
    };
  }
}

export async function GET(request: Request) {
  const started = Date.now();
  const requested = new URL(request.url).searchParams.get("aoi");

  const meta = await resolveAoi(requested);
  if (!meta) {
    return NextResponse.json(
      { error: "No areas of operation are configured. Run scripts/setup_aoi.py." },
      { status: 503 }
    );
  }

  const [{ alerts, live, note }, data, available] = await Promise.all([
    loadAlerts(meta),
    loadAoiData(meta),
    listAois(),
  ]);

  const clusters = clusterAlerts(alerts);

  // The graph is cached per area — switching areas must not serve the previous
  // area's road network.
  const graph = data.roads.length ? getRoadGraph(meta.slug, data.roads) : null;

  const targets = rankTargets(clusters, {
    post: meta.post,
    roads: data.roads,
    protectedAreas: data.protectedAreas,
    context: (c) => ({ treeCoverPct: treeCoverAt(data.forestGrid, c.lat, c.lon) }),
    route: (c) => (graph ? graph.route(meta.post, { lat: c.lat, lon: c.lon }) : null),
  });

  const robustness = analyseRobustness(targets, 5);
  for (const t of targets) t.robustness = robustness.get(t.id);

  return NextResponse.json({
    aoi: { ...meta.bbox, label: meta.label, subtitle: meta.subtitle, slug: meta.slug },
    // The picker is populated from what is actually on disk, so a newly
    // generated area appears without any code change.
    available: available.map((a) => ({
      slug: a.slug,
      label: a.label,
      subtitle: a.subtitle,
    })),
    post: meta.post,
    live,
    note,
    counts: {
      detections: alerts.length,
      events: clusters.length,
      roadSegments: data.roads.length,
      protectedAreas: data.protectedAreas.length,
      routingNodes: graph?.size ?? 0,
      routed: targets.filter((t) => t.routed).length,
    },
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    targets,
  });
}
