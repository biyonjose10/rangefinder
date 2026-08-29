import type { RoadGraph } from "./route";
import type { RangerPost, ScoredTarget } from "./types";

/**
 * PATROL SEQUENCING
 * =================
 * The score ranks targets independently, but a crew drives one loop. Two
 * mediocre targets 5 km apart are worth more than one excellent target 200 km
 * the other way, and a ranking cannot express that.
 *
 * It showed up concretely in the patrol order, which reported total transit as
 * the *sum of independent round trips* — post→A plus post→B plus post→C. Nobody
 * drives like that, so the figure a crew planned their day around was not a
 * journey anyone could take.
 *
 * This plans the actual journey: post → targets → post, sequenced to minimise
 * driving, trimmed to fit a working day.
 *
 * WHAT THIS IS NOT. The travel model underneath is an estimate — assumed speeds
 * by road class, an OSM network missing plenty of real tracks, and no modelling
 * of rivers, ferries or seasonal closures. Optimising to the minute on that
 * foundation would be false precision, so the output is reported as an estimate
 * with its assumptions stated, and the ranking remains visible alongside it. A
 * ranger should still be able to see why each target was chosen, not only what
 * order to drive them in.
 */

/** Assumptions, stated rather than buried. Surfaced in the UI and the PDF. */
export const TOUR_ASSUMPTIONS = {
  /** A crew's driving day, hours. Excludes time spent at each site. */
  maxDrivingHours: 9,
  /** Time on the ground per target, hours. */
  hoursOnSite: 0.75,
  /** Unsealed-road diesel consumption, litres per 100 km. */
  litresPer100km: 18,
} as const;

export interface TourLeg {
  /** null for the leg leaving the ranger post. */
  fromTargetId: string | null;
  /** null for the leg returning to the post. */
  toTargetId: string | null;
  km: number;
  hours: number;
  /**
   * The road polyline for this leg, in GeoJSON order.
   *
   * Carried here because the router already produced it while costing the leg.
   * An earlier version discarded it and had the browser re-request every leg
   * from /api/route-to, which meant the drawn loop depended on a fan of extra
   * round trips that could partly fail and leave the map silently blank.
   */
  geometry: [number, number][];
}

export interface TourPlan {
  /** Target ids in the order they should be driven. */
  sequence: string[];
  legs: TourLeg[];
  totalKm: number;
  /** Driving only. */
  drivingHours: number;
  /** Driving plus time on the ground. */
  totalHours: number;
  litres: number;
  fitsWorkingDay: boolean;
  /**
   * Ranked targets left out, with the reason. A target excluded for being
   * unreachable is a different fact from one excluded because the day ran out,
   * and the crew needs to know which.
   */
  excluded: { id: string; reason: "no road route" | "would not fit the day" }[];
  /** Sum of separate return trips — what the order used to report. */
  naiveRoundTripHours: number;
}

type Point = { lat: number; lon: number };

/**
 * Exact shortest tour by brute force over permutations.
 *
 * With five tasked targets there are 4! = 24 orderings, and even eight gives
 * only 5,040 — trivial to evaluate exactly. A heuristic here would add
 * approximation error for no measurable saving, so we simply try them all and
 * take the best.
 */
function bestOrder(n: number, cost: (a: number, b: number) => number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let best: number[] = idx;
  let bestCost = Infinity;

  const permute = (arr: number[], k: number) => {
    if (k === arr.length) {
      // POST is index -1; walk post → arr[0] → ... → arr[last] → post.
      let c = cost(-1, arr[0]);
      for (let i = 0; i < arr.length - 1; i++) c += cost(arr[i], arr[i + 1]);
      c += cost(arr[arr.length - 1], -1);
      if (c < bestCost) {
        bestCost = c;
        best = [...arr];
      }
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      permute(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };

  permute([...idx], 0);
  return best;
}

/**
 * Plan the day.
 *
 * Targets are considered in ranked order and kept while the resulting loop
 * still fits a working day — a prize-collecting approach, so the highest-value
 * targets are never dropped in favour of merely convenient ones.
 */
export function planTour(
  post: RangerPost,
  targets: ScoredTarget[],
  graph: RoadGraph | null,
  opts: { maxDrivingHours?: number } = {}
): TourPlan {
  const maxHours = opts.maxDrivingHours ?? TOUR_ASSUMPTIONS.maxDrivingHours;

  const excluded: TourPlan["excluded"] = [];
  const naiveRoundTripHours = targets.reduce((s, t) => s + t.driveTimeHours * 2, 0);

  // Only targets a vehicle can actually reach can be in a driving loop.
  const drivable = targets.filter((t) => {
    if (t.routed) return true;
    excluded.push({ id: t.id, reason: "no road route" });
    return false;
  });

  const empty: TourPlan = {
    sequence: [],
    legs: [],
    totalKm: 0,
    drivingHours: 0,
    totalHours: 0,
    litres: 0,
    fitsWorkingDay: true,
    excluded,
    naiveRoundTripHours,
  };
  if (!graph || drivable.length === 0) return empty;

  const at = (i: number): Point =>
    i === -1 ? { lat: post.lat, lon: post.lon } : { lat: drivable[i].lat, lon: drivable[i].lon };

  // Pairwise legs are the expensive part, so memoise: an n-target tour asks for
  // the same pair repeatedly across permutations.
  const cache = new Map<string, { km: number; hours: number; geometry: [number, number][] }>();
  const leg = (a: number, b: number) => {
    // Direction matters for the drawn line even though cost is symmetric, so
    // the cache is keyed on the ordered pair and the reverse is mirrored.
    const key = `${a}:${b}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const rev = cache.get(`${b}:${a}`);
    if (rev) {
      const flipped = { ...rev, geometry: [...rev.geometry].reverse() };
      cache.set(key, flipped);
      return flipped;
    }

    const r = graph.route(at(a), at(b));
    // An unreachable pair must never look free, or the optimiser will happily
    // route through it.
    const val = r
      ? { km: r.roadMetres / 1000, hours: r.driveHours, geometry: r.geometry }
      : { km: Infinity, hours: Infinity, geometry: [] as [number, number][] };
    cache.set(key, val);
    return val;
  };

  // Add targets in ranked order while the optimal loop still fits the day.
  let bestPlan: { order: number[]; km: number; hours: number } | null = null;

  for (let n = 1; n <= drivable.length; n++) {
    const order = bestOrder(n, (a, b) => leg(a, b).hours);

    let km = 0;
    let hours = 0;
    let prev = -1;
    for (const i of order) {
      const l = leg(prev, i);
      km += l.km;
      hours += l.hours;
      prev = i;
    }
    const back = leg(prev, -1);
    km += back.km;
    hours += back.hours;

    if (!Number.isFinite(hours)) {
      excluded.push({ id: drivable[n - 1].id, reason: "no road route" });
      continue;
    }
    if (hours + n * TOUR_ASSUMPTIONS.hoursOnSite > maxHours) {
      excluded.push({ id: drivable[n - 1].id, reason: "would not fit the day" });
      continue;
    }
    bestPlan = { order, km, hours };
  }

  if (!bestPlan) {
    // Even one target does not fit — report honestly rather than pretend.
    for (const t of drivable) {
      if (!excluded.some((e) => e.id === t.id)) {
        excluded.push({ id: t.id, reason: "would not fit the day" });
      }
    }
    return { ...empty, excluded };
  }

  const legs: TourLeg[] = [];
  let prev = -1;
  for (const i of bestPlan.order) {
    const l = leg(prev, i);
    legs.push({
      fromTargetId: prev === -1 ? null : drivable[prev].id,
      toTargetId: drivable[i].id,
      km: l.km,
      hours: l.hours,
      geometry: l.geometry,
    });
    prev = i;
  }
  const back = leg(prev, -1);
  legs.push({
    fromTargetId: drivable[prev].id,
    toTargetId: null,
    km: back.km,
    hours: back.hours,
    geometry: back.geometry,
  });

  const onSite = bestPlan.order.length * TOUR_ASSUMPTIONS.hoursOnSite;

  return {
    sequence: bestPlan.order.map((i) => drivable[i].id),
    legs,
    totalKm: bestPlan.km,
    drivingHours: bestPlan.hours,
    totalHours: bestPlan.hours + onSite,
    litres: Math.round((bestPlan.km * TOUR_ASSUMPTIONS.litresPer100km) / 100),
    fitsWorkingDay: bestPlan.hours + onSite <= maxHours,
    excluded,
    naiveRoundTripHours,
  };
}
