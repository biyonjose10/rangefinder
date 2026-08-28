import { clusterAlerts } from "./cluster";
import { rankTargets } from "./score";
import { getRoadGraph } from "./route";
import { analyseRobustness } from "./sensitivity";
import { treeCoverAt } from "./forest";
import { listAois, loadAoiData, loadCachedAlerts, resolveAoi, type AoiMeta } from "./aoi";
import { fetchLiveAlerts } from "./sources/firms";
import { DEMO_MODE } from "./config";
import { fetchAreaWeather, weatherNote, type AreaWeather } from "./sources/weather";
import type { Alert, RangerPost, ScoredTarget } from "./types";

/**
 * The whole triage pipeline for one area, in one place.
 *
 * This used to live inside the /api/targets handler, and /api/patrol-order
 * reached it by calling that endpoint over HTTP. That was a genuine defect
 * rather than merely inelegant: the PDF route paid for the entire pipeline a
 * second time — refetching FIRMS, rebuilding a 411,494-node road graph,
 * re-running A* — before it rendered a single page. On the larger area that
 * pushed it past the serverless duration limit and the patrol order, the whole
 * point of the application, simply never returned.
 *
 * Both routes now call this directly and pay for the work once.
 */

export interface TargetsPayload {
  aoi: {
    label: string;
    subtitle?: string;
    slug: string;
    south: number;
    west: number;
    north: number;
    east: number;
  };
  available: { slug: string; label: string; subtitle?: string }[];
  post: RangerPost;
  live: boolean;
  note?: string;
  counts: {
    detections: number;
    events: number;
    roadSegments: number;
    protectedAreas: number;
    heatSources: number;
    suppressedIndustrial: number;
    routingNodes: number;
    routed: number;
  };
  generatedAt: string;
  elapsedMs: number;
  targets: ScoredTarget[];
  /** Null when the weather service could not be reached — it is context, not a
   *  dependency, so its absence must not block the queue. */
  weather: AreaWeather | null;
  /** Plain-language caveat about observability or trafficability. */
  weatherNote: string | null;
}

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

/** Returns null when no area is configured at all. */
export async function buildTargets(slug?: string | null): Promise<TargetsPayload | null> {
  const started = Date.now();

  const meta = await resolveAoi(slug);
  if (!meta) return null;

  const centreLat = (meta.bbox.south + meta.bbox.north) / 2;
  const centreLon = (meta.bbox.west + meta.bbox.east) / 2;

  const [{ alerts, live, note }, data, available, weather] = await Promise.all([
    loadAlerts(meta),
    loadAoiData(meta),
    listAois(),
    DEMO_MODE ? Promise.resolve(null) : fetchAreaWeather(centreLat, centreLon),
  ]);

  const clusters = clusterAlerts(alerts);

  // Keyed per area — switching areas must not serve the previous area's roads.
  const graph = data.roads.length ? getRoadGraph(meta.slug, data.roads) : null;

  const targets = rankTargets(clusters, {
    post: meta.post,
    roads: data.roads,
    protectedAreas: data.protectedAreas,
    heatSources: data.heatSources,
    context: (c) => ({ treeCoverPct: treeCoverAt(data.forestGrid, c.lat, c.lon) }),
    route: (c) => (graph ? graph.route(meta.post, { lat: c.lat, lon: c.lon }) : null),
  });

  const robustness = analyseRobustness(targets, 5);
  for (const t of targets) t.robustness = robustness.get(t.id);

  return {
    aoi: { ...meta.bbox, label: meta.label, subtitle: meta.subtitle, slug: meta.slug },
    // Populated from what is actually on disk, so a newly generated area
    // appears without any code change.
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
      heatSources: data.heatSources.length,
      suppressedIndustrial: targets.filter((t) => t.industrialSource).length,
      routingNodes: graph?.size ?? 0,
      routed: targets.filter((t) => t.routed).length,
    },
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    targets,
    weather,
    weatherNote: weather ? weatherNote(weather, alerts.length) : null,
  };
}
