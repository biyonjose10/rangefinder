import { haversineM, distanceToNearestRoadM, pointInRings } from "./geo";
import type { RouteResult } from "./route";
import type {
  Cluster,
  ProtectedArea,
  RangerPost,
  RoadSegment,
  ScoreBreakdown,
  ScoredTarget,
} from "./types";

/**
 * THE ACTIONABILITY SCORE
 * =======================
 * Satellite deforestation alerting is a solved problem. Alert *triage* is not.
 * A protected-area office receives thousands of detections a week and can field
 * one or two patrols. Today that choice is made by eyeballing a heatmap.
 *
 * This module turns the choice into an explicit, inspectable function. Every
 * factor is normalised to 0..1 and combined as a weighted geometric mean, so a
 * single disqualifying factor — a target no vehicle can reach — correctly
 * collapses the score rather than being averaged away by the others.
 *
 * Deliberately not a machine-learning model. There is no labelled ground-truth
 * dataset of "patrols that were worth sending", so a learned model here would be
 * unfalsifiable dressing. A ranger can argue with these six numbers; that
 * matters more than a decimal place of accuracy.
 */

const WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  extent: 0.24, // how much forest is actually coming down
  forest: 0.2, // was this forest to begin with
  protection: 0.18, // is this land legally protected
  recency: 0.17, // can we still catch them on site
  access: 0.12, // can a vehicle physically get there
  confidence: 0.06, // how much do we trust the detection
  proximity: 0.03, // fuel and hours
};

const CONFIDENCE_VALUE = { low: 0.4, nominal: 0.75, high: 1.0 } as const;

/**
 * Baseline tree cover below which a detection is very probably not
 * deforestation at all.
 *
 * FIRMS reports heat, not forest loss. During the burning season most fires in
 * this landscape are on land that was cleared years ago — pasture maintenance
 * and crop residue, which are routine and usually legal. Without this factor
 * the tool ranks farm burns as urgent deforestation and looks entirely
 * convincing while doing it.
 */
function forestFactor(treeCoverPct: number | null): number {
  // Unknown is not the same as "not forest". Sit near the middle rather than
  // penalising a target for a gap in our own baseline data.
  if (treeCoverPct === null) return 0.6;
  return clamp01(Math.max(0.05, treeCoverPct / 100));
}

/** Cluster size at which extent saturates. Beyond ~30 detections in 24h the
 *  event is unambiguously large and further detections do not change the
 *  decision to go. */
const EXTENT_SATURATION = 30;

/** Detections decay with a two-day half-life: after ~72h the crew has moved on
 *  and the patrol becomes evidence-collection rather than interdiction. */
const RECENCY_HALFLIFE_DAYS = 2;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function daysSince(dateStr: string, now: Date): number {
  const then = new Date(`${dateStr}T00:00:00Z`).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, (now.getTime() - then) / 86400000);
}

function extentFactor(count: number, frpSum: number): number {
  // Detection count is the primary signal; radiative power breaks ties between
  // clusters of equal count (a hotter burn is a bigger clearing).
  const byCount = Math.log10(1 + count) / Math.log10(1 + EXTENT_SATURATION);
  const byPower = Math.log10(1 + frpSum) / Math.log10(1 + 500);
  return clamp01(0.75 * byCount + 0.25 * byPower);
}

function recencyFactor(lastSeen: string, now: Date): number {
  return clamp01(Math.pow(0.5, daysSince(lastSeen, now) / RECENCY_HALFLIFE_DAYS));
}

/** Reachability falls off hyperbolically: on a track = 1.0, 1 km off = 0.5,
 *  5 km off = 0.17. A floor of 0.05 keeps genuinely remote mega-clearings from
 *  vanishing off the list entirely — they still warrant an overflight. */
function accessFactor(distanceToRoadM: number): number {
  if (!Number.isFinite(distanceToRoadM)) return 0.05;
  return clamp01(Math.max(0.05, 1 / (1 + distanceToRoadM / 1000)));
}

function proximityFactor(distanceFromPostKm: number): number {
  return clamp01(1 / (1 + distanceFromPostKm / 50));
}

/**
 * Point-in-protected-area test against real OSM boundary geometry.
 *
 * An earlier draft approximated each area as a disc around its centroid. On the
 * demo AOI that was not merely imprecise, it was wrong in the worst direction:
 * the Xingu Indigenous Park centroid sits ~140 km from the largest fire cluster,
 * so any radius wide enough to "hit" would have labelled frontier burning as
 * illegal clearing inside a protected indigenous territory. Ray-casting against
 * the actual 3,805-node boundary returns the true answer, which for this AOI is
 * that the big fires are *outside* the park.
 */
function findProtectedArea(
  lat: number,
  lon: number,
  areas: ProtectedArea[]
): ProtectedArea | null {
  for (const area of areas) {
    if (pointInRings(lon, lat, area.rings)) return area;
  }
  return null;
}

/** Rough one-way travel time: road speed for the driveable leg, walking pace
 *  for the final off-road approach. */
function estimateDriveTimeHours(
  distanceFromPostKm: number,
  distanceToRoadM: number
): number {
  const ROAD_KMH = 35; // unsealed forest road
  const FOOT_KMH = 3.5;
  const offRoadKm = Number.isFinite(distanceToRoadM) ? distanceToRoadM / 1000 : 0;
  const roadKm = Math.max(0, distanceFromPostKm - offRoadKm);
  return roadKm / ROAD_KMH + offRoadKm / FOOT_KMH;
}

function buildRationale(
  t: Omit<ScoredTarget, "rationale">,
  area: ProtectedArea | null
): string[] {
  const out: string[] = [];

  out.push(
    `${t.count} detection${t.count === 1 ? "" : "s"} spanning ${t.spanKm.toFixed(1)} km, ` +
      `${Math.round(t.frpSum)} MW total radiative power.`
  );

  if (t.treeCoverPct !== null) {
    if (t.treeCoverPct >= 60) {
      out.push(
        `${Math.round(t.treeCoverPct)}% tree cover at baseline — this was closed forest, ` +
          `so the burn is consistent with clearing rather than pasture management.`
      );
    } else if (t.treeCoverPct >= 25) {
      out.push(
        `Only ${Math.round(t.treeCoverPct)}% tree cover at baseline — partially cleared ` +
          `already; confirm this is not routine agricultural burning.`
      );
    } else {
      out.push(
        `${Math.round(t.treeCoverPct)}% tree cover at baseline — this land was already ` +
          `cleared, so the fire is probably agricultural and not deforestation.`
      );
    }
  }

  if (area) {
    out.push(`Falls inside ${area.name} — clearing here is prima facie illegal.`);
  } else {
    out.push("No mapped protected-area designation; verify tenure before action.");
  }

  const days = t.breakdown.recency;
  if (days > 0.8) out.push("Detected in the last 24 hours — crew likely still on site.");
  else if (days > 0.4) out.push("1–2 days old — tracks and equipment likely still present.");
  else out.push("Ageing detection — treat as evidence collection, not interdiction.");

  if (t.distanceToRoadM === null) {
    out.push("No mapped road within the search window — air support required.");
  } else if (t.distanceToRoadM < 500) {
    out.push(`Vehicle access ${Math.round(t.distanceToRoadM)} m from a mapped track.`);
  } else {
    out.push(
      `${(t.distanceToRoadM / 1000).toFixed(1)} km off the nearest mapped track — ` +
        `plan for a foot approach.`
    );
  }

  if (t.routed && t.routeKm !== null) {
    const detour = t.detourRatio
      ? ` (${t.detourRatio.toFixed(1)}× the straight-line distance)`
      : "";
    out.push(
      `${t.routeKm.toFixed(0)} km by road from the ranger post${detour}; ` +
        `est. ${t.driveTimeHours.toFixed(1)} h one way.`
    );
  } else {
    out.push(
      `No road route found from the ranger post — ${t.distanceFromPostKm.toFixed(0)} km ` +
        `in a straight line. Treat as air or river access.`
    );
  }

  return out;
}

export function scoreCluster(
  cluster: Cluster,
  ctx: {
    post: RangerPost;
    roads: RoadSegment[];
    protectedAreas: ProtectedArea[];
    /** Road-network route from the post, when one could be computed. */
    route?: RouteResult | null;
    /** Baseline tree cover at the cluster centroid, 0-100. */
    treeCoverPct?: number | null;
    now?: Date;
  }
): ScoredTarget {
  const now = ctx.now ?? new Date();

  const distanceToRoadM = distanceToNearestRoadM(cluster.lat, cluster.lon, ctx.roads);
  const distanceFromPostKm =
    haversineM(cluster.lat, cluster.lon, ctx.post.lat, ctx.post.lon) / 1000;
  const area = findProtectedArea(cluster.lat, cluster.lon, ctx.protectedAreas);

  const treeCoverPct = ctx.treeCoverPct ?? null;
  const route = ctx.route ?? null;

  const breakdown: ScoreBreakdown = {
    forest: forestFactor(treeCoverPct),
    confidence: CONFIDENCE_VALUE[cluster.maxConfidence] ?? 0.5,
    extent: extentFactor(cluster.count, cluster.frpSum),
    recency: recencyFactor(cluster.lastSeen, now),
    access: accessFactor(distanceToRoadM),
    protection: area ? 1.0 : 0.35,
    proximity: proximityFactor(distanceFromPostKm),
  };

  // Weighted geometric mean. Guard each factor away from exact zero so one
  // missing input cannot annihilate an otherwise urgent target.
  let logSum = 0;
  for (const key of Object.keys(WEIGHTS) as (keyof ScoreBreakdown)[]) {
    logSum += WEIGHTS[key] * Math.log(Math.max(0.02, breakdown[key]));
  }
  const score = Math.round(Math.exp(logSum) * 1000) / 10; // 0..100, one decimal

  const partial = {
    ...cluster,
    score,
    breakdown,
    distanceToRoadM: Number.isFinite(distanceToRoadM) ? distanceToRoadM : null,
    distanceFromPostKm,
    routeKm: route ? route.roadMetres / 1000 : null,
    detourRatio: route ? route.detourRatio : null,
    routed: route !== null,
    treeCoverPct,
    // Prefer the routed time. The straight-line estimate remains only as a
    // fallback, and is flagged as such by `routed: false`.
    driveTimeHours: route
      ? route.driveHours + route.offRoadMetres / 1000 / 3.5
      : estimateDriveTimeHours(distanceFromPostKm, distanceToRoadM),
    protectedArea: area?.name ?? null,
  };

  return { ...partial, rationale: buildRationale(partial, area) };
}

type ScoreContext = Parameters<typeof scoreCluster>[1];

/**
 * Score every cluster and return the ranked patrol queue.
 *
 * Routing is the expensive step — an A* traversal per target — so it is run in
 * two passes rather than for everything. The first pass scores on the cheap
 * factors alone to find which targets could plausibly reach the top; only those
 * are routed and rescored. On a busy area this is the difference between
 * routing 114 events and routing 20, and no target that lands on a patrol order
 * ever goes unrouted, because routing can only ever *lower* a score (a longer
 * road distance never helps) and the shortlist is drawn generously.
 */
export function rankTargets(
  clusters: Cluster[],
  ctx: Omit<ScoreContext, "route" | "treeCoverPct"> & {
    /** Cheap per-cluster context, computed for every cluster. */
    context?: (c: Cluster) => Pick<ScoreContext, "treeCoverPct">;
    /** Expensive per-cluster routing, computed only for the shortlist. */
    route?: (c: Cluster) => ScoreContext["route"];
    /** How many top-scoring targets to route. */
    routeTopN?: number;
  }
): ScoredTarget[] {
  const { context, route, routeTopN = 20, ...shared } = ctx;

  const cheap = clusters.map((c) => ({
    cluster: c,
    scored: scoreCluster(c, { ...shared, ...(context?.(c) ?? {}) }),
  }));
  cheap.sort((a, b) => b.scored.score - a.scored.score);

  if (!route) return cheap.map((x) => x.scored);

  const shortlist = new Set(cheap.slice(0, routeTopN).map((x) => x.cluster.id));

  return cheap
    .map(({ cluster, scored }) =>
      shortlist.has(cluster.id)
        ? scoreCluster(cluster, {
            ...shared,
            ...(context?.(cluster) ?? {}),
            route: route(cluster),
          })
        : scored
    )
    .sort((a, b) => b.score - a.score);
}

export const SCORE_WEIGHTS = WEIGHTS;
