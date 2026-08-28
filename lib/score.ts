import { haversineM, distanceToNearestRoadM, pointInRings } from "./geo";
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
  extent: 0.28, // how much forest is actually coming down
  protection: 0.22, // is this land legally protected
  recency: 0.2, // can we still catch them on site
  access: 0.15, // can a vehicle physically get there
  confidence: 0.1, // how much do we trust the detection
  proximity: 0.05, // fuel and hours
};

const CONFIDENCE_VALUE = { low: 0.4, nominal: 0.75, high: 1.0 } as const;

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

  out.push(
    `${t.distanceFromPostKm.toFixed(0)} km from the ranger post; ` +
      `est. ${t.driveTimeHours.toFixed(1)} h one way.`
  );

  return out;
}

export function scoreCluster(
  cluster: Cluster,
  ctx: {
    post: RangerPost;
    roads: RoadSegment[];
    protectedAreas: ProtectedArea[];
    now?: Date;
  }
): ScoredTarget {
  const now = ctx.now ?? new Date();

  const distanceToRoadM = distanceToNearestRoadM(cluster.lat, cluster.lon, ctx.roads);
  const distanceFromPostKm =
    haversineM(cluster.lat, cluster.lon, ctx.post.lat, ctx.post.lon) / 1000;
  const area = findProtectedArea(cluster.lat, cluster.lon, ctx.protectedAreas);

  const breakdown: ScoreBreakdown = {
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
    driveTimeHours: estimateDriveTimeHours(distanceFromPostKm, distanceToRoadM),
    protectedArea: area?.name ?? null,
  };

  return { ...partial, rationale: buildRationale(partial, area) };
}

/** Score every cluster and return the ranked patrol queue. */
export function rankTargets(
  clusters: Cluster[],
  ctx: Parameters<typeof scoreCluster>[1]
): ScoredTarget[] {
  return clusters
    .map((c) => scoreCluster(c, ctx))
    .sort((a, b) => b.score - a.score);
}

export const SCORE_WEIGHTS = WEIGHTS;
