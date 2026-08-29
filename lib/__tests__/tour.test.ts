import { describe, expect, it } from "vitest";

import { RoadGraph } from "@/lib/route";
import { TOUR_ASSUMPTIONS, planTour } from "@/lib/tour";
import type { RangerPost, RoadSegment, ScoredTarget } from "@/lib/types";

/**
 * The sequencer replaces a figure that was not merely imprecise but incoherent:
 * total transit was the sum of independent return trips, post→A + post→B +
 * post→C, which is not a journey anyone drives. These tests hold the
 * replacement to being an actual loop, and — just as importantly — to never
 * losing a target silently.
 */

const POST: RangerPost = { name: "Post", lat: 0, lon: 0 };

/** A straight east-west road along the equator, so distances are predictable. */
function eastWestRoad(): RoadSegment[] {
  const coords: [number, number][] = [];
  for (let i = 0; i <= 60; i++) coords.push([i * 0.01, 0]);
  return [{ highway: "unclassified", coords }];
}

function target(id: string, lon: number, over: Partial<ScoredTarget> = {}): ScoredTarget {
  return {
    id,
    lat: 0,
    lon,
    count: 5,
    frpSum: 100,
    maxConfidence: "nominal",
    firstSeen: "2026-08-28",
    lastSeen: "2026-08-28",
    spanKm: 1,
    alerts: [],
    score: 60,
    breakdown: {
      forest: 1, confidence: 1, extent: 1, recency: 1, access: 1, protection: 1, proximity: 1,
    },
    distanceToRoadM: 10,
    distanceFromPostKm: lon * 111,
    routeKm: lon * 111,
    detourRatio: 1,
    routed: true,
    treeCoverPct: 90,
    recentLossPct: 0,
    nightFraction: 0,
    fuelLitres: 10,
    industrialSource: null,
    driveTimeHours: (lon * 111) / 35,
    protectedArea: null,
    rationale: [],
    ...over,
  };
}

describe("the planned day is a loop, not a pile of round trips", () => {
  const graph = new RoadGraph(eastWestRoad());

  it("drives a monotonic run without backtracking, whatever order they were ranked in", () => {
    // Ranked far, near, middle. On a single road the optimal loop runs straight
    // out and straight back; which end it starts from is an arbitrary tie-break
    // between two identical-cost routes, so asserting a specific permutation
    // would be testing the tie-break rather than the optimisation.
    const plan = planTour(POST, [target("far", 0.5), target("near", 0.1), target("mid", 0.3)], graph);
    expect(plan.sequence).toHaveLength(3);

    const lonOf: Record<string, number> = { near: 0.1, mid: 0.3, far: 0.5 };
    const lons = plan.sequence.map((id) => lonOf[id]);
    const ascending = lons.every((v, i) => i === 0 || lons[i - 1] < v);
    const descending = lons.every((v, i) => i === 0 || lons[i - 1] > v);
    expect(ascending || descending, `zig-zagged: ${plan.sequence.join(" -> ")}`).toBe(true);

    // And it must actually be the optimal length: out to the furthest and back.
    const outAndBack = 2 * 0.5 * 111.32;
    expect(plan.totalKm).toBeGreaterThan(outAndBack * 0.9);
    expect(plan.totalKm).toBeLessThan(outAndBack * 1.1);
  });

  it("costs far less than treating each target as its own return trip", () => {
    const targets = [target("a", 0.1), target("b", 0.2), target("c", 0.3)];
    const plan = planTour(POST, targets, graph);
    // One loop to the furthest point and back beats three separate round trips.
    expect(plan.drivingHours).toBeLessThan(plan.naiveRoundTripHours);
    expect(plan.totalKm).toBeGreaterThan(0);
  });

  it("returns to the post — the last leg has no destination target", () => {
    const plan = planTour(POST, [target("a", 0.1), target("b", 0.2)], graph);
    expect(plan.legs.at(-1)?.toTargetId).toBeNull();
    expect(plan.legs[0].fromTargetId).toBeNull();
    // Every target appears exactly once as a destination.
    const visited = plan.legs.map((l) => l.toTargetId).filter(Boolean);
    expect(new Set(visited).size).toBe(plan.sequence.length);
  });
});

describe("nothing is dropped silently", () => {
  const graph = new RoadGraph(eastWestRoad());

  it("an unreachable target is excluded and the reason recorded", () => {
    const plan = planTour(
      POST,
      [target("ok", 0.1), target("air", 0.2, { routed: false, routeKm: null })],
      graph
    );
    expect(plan.sequence).not.toContain("air");
    expect(plan.excluded).toContainEqual({ id: "air", reason: "no road route" });
  });

  it("a target that will not fit the day is excluded, and said so distinctly", () => {
    // One hour of driving allowed: only the closest can possibly fit.
    const plan = planTour(POST, [target("a", 0.1), target("b", 0.55)], graph, {
      maxDrivingHours: 1,
    });
    expect(plan.excluded.some((e) => e.reason === "would not fit the day")).toBe(true);
    // The two reasons must stay distinguishable — a crew needs to know whether
    // to send aircraft or simply go tomorrow.
    expect(plan.excluded.every((e) => e.reason !== "no road route")).toBe(true);
  });

  it("every considered target is either sequenced or explained", () => {
    const targets = [target("a", 0.1), target("b", 0.3), target("c", 0.9)];
    const plan = planTour(POST, targets, graph, { maxDrivingHours: 2 });
    const accounted = new Set([...plan.sequence, ...plan.excluded.map((e) => e.id)]);
    for (const t of targets) expect(accounted.has(t.id), `${t.id} unaccounted for`).toBe(true);
  });

  it("reports honestly when not even one target fits", () => {
    const plan = planTour(POST, [target("far", 0.6)], graph, { maxDrivingHours: 0.1 });
    expect(plan.sequence).toHaveLength(0);
    expect(plan.excluded).toHaveLength(1);
    expect(plan.totalKm).toBe(0);
  });
});

describe("the day respects its stated budget", () => {
  const graph = new RoadGraph(eastWestRoad());

  it("driving plus time on site stays within the working day", () => {
    const plan = planTour(POST, [target("a", 0.1), target("b", 0.2), target("c", 0.3)], graph);
    const onSite = plan.sequence.length * TOUR_ASSUMPTIONS.hoursOnSite;
    expect(plan.totalHours).toBeCloseTo(plan.drivingHours + onSite, 5);
    expect(plan.totalHours).toBeLessThanOrEqual(TOUR_ASSUMPTIONS.maxDrivingHours);
    expect(plan.fitsWorkingDay).toBe(true);
  });

  it("fuel follows the distance actually driven", () => {
    const plan = planTour(POST, [target("a", 0.2)], graph);
    expect(plan.litres).toBe(
      Math.round((plan.totalKm * TOUR_ASSUMPTIONS.litresPer100km) / 100)
    );
  });

  it("no graph means no plan, rather than a fabricated one", () => {
    const plan = planTour(POST, [target("a", 0.1)], null);
    expect(plan.sequence).toHaveLength(0);
    expect(plan.totalKm).toBe(0);
  });
});
