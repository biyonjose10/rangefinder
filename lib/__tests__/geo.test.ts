import { describe, it, expect } from "vitest";
import { haversineM, distanceToNearestRoadM, pointInRings } from "@/lib/geo";

describe("haversineM", () => {
  it("returns 0 for the same point", () => {
    expect(haversineM(-3.4653, -62.2159, -3.4653, -62.2159)).toBe(0);
  });

  it("matches one degree of latitude (~111.2 km)", () => {
    const d = haversineM(0, 0, 1, 0);
    expect(d).toBeGreaterThan(111000);
    expect(d).toBeLessThan(111400);
  });

  it("matches the known London-Paris great-circle distance (~344 km)", () => {
    const d = haversineM(51.5074, -0.1278, 48.8566, 2.3522);
    expect(Math.abs(d - 344000) / 344000).toBeLessThan(0.005);
  });

  it("matches the known New York-Los Angeles great-circle distance (~3936 km)", () => {
    const d = haversineM(40.7128, -74.006, 34.0522, -118.2437);
    expect(Math.abs(d - 3936000) / 3936000).toBeLessThan(0.005);
  });
});

describe("distanceToNearestRoadM", () => {
  // A short east-west road segment near the equator.
  const road = { coords: [[-62.22, -3.47], [-62.21, -3.47]] as [number, number][] };

  it("returns ~0 for a point sitting exactly on the segment", () => {
    // Midpoint of the segment.
    const d = distanceToNearestRoadM(-3.47, -62.215, [road]);
    expect(d).toBeLessThan(1);
  });

  it("returns the perpendicular offset for a point beside a north-south segment", () => {
    // Segment runs due north along lon=0 from lat=0 to lat=0.01; the query
    // point sits at the segment's midpoint latitude, offset 0.001deg east.
    const segment = { coords: [[0, 0], [0, 0.01]] as [number, number][] };
    const d = distanceToNearestRoadM(0.005, 0.001, [segment]);
    // Expected ~111.32m (0.001deg of longitude at this latitude).
    expect(Math.abs(d - 111.32) / 111.32).toBeLessThan(0.01);
  });

  it("returns Infinity when there are no roads", () => {
    expect(distanceToNearestRoadM(-3.47, -62.215, [])).toBe(Infinity);
  });

  it("does not produce NaN for a degenerate segment (duplicate endpoints)", () => {
    const degenerate = { coords: [[-62.2, -3.4], [-62.2, -3.4]] as [number, number][] };
    const d = distanceToNearestRoadM(-3.4001, -62.2001, [degenerate]);
    expect(Number.isNaN(d)).toBe(false);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(Infinity);
  });
});

describe("pointInRings", () => {
  // Simple 1deg x 1deg square, closed ring, [lon, lat] order.
  const square: [number, number][] = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
  ];

  it("returns true for a point clearly inside a square ring", () => {
    expect(pointInRings(0.5, 0.5, [square])).toBe(true);
  });

  it("returns false for a point clearly outside", () => {
    expect(pointInRings(5, 5, [square])).toBe(false);
  });

  it("returns false for a point in the notch of an L-shaped (concave) ring, even though it is inside the ring's bounding box", () => {
    // An L / gnomon shape: a 2x2 square with the top-right 1x1 quadrant cut
    // out. This is the classic case a naive bounding-box check gets wrong —
    // (1.5, 1.5) sits inside the [0,2]x[0,2] bbox but outside the polygon.
    const lShape: [number, number][] = [
      [0, 0],
      [0, 2],
      [1, 2],
      [1, 1],
      [2, 1],
      [2, 0],
      [0, 0],
    ];
    expect(pointInRings(1.5, 1.5, [lShape])).toBe(false);
    // Sanity check: a point in the filled part of the same L is still inside.
    expect(pointInRings(0.5, 0.5, [lShape])).toBe(true);
  });

  it("finds a point inside a ring that is not first in the array", () => {
    const elsewhere: [number, number][] = [
      [10, 10],
      [10, 11],
      [11, 11],
      [11, 10],
      [10, 10],
    ];
    expect(pointInRings(0.5, 0.5, [elsewhere, square])).toBe(true);
  });
});
