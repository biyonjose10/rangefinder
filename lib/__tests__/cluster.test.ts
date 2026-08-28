import { describe, it, expect } from "vitest";
import { clusterAlerts } from "@/lib/cluster";
import type { Alert } from "@/lib/types";

const BASE_LAT = -3.4;
const BASE_LON = -62.2;

function makeAlert(overrides: Partial<Alert>): Alert {
  return {
    lat: BASE_LAT,
    lon: BASE_LON,
    acqDate: "2026-06-01",
    acqTime: "1400",
    confidence: "nominal",
    frp: 10,
    dayNight: "D",
    ...overrides,
  };
}

describe("clusterAlerts", () => {
  it("returns an empty array for empty input", () => {
    expect(clusterAlerts([])).toEqual([]);
  });

  it("merges two detections 100m apart into one cluster", () => {
    // 100m is well inside the 1500m DBSCAN radius, so this is one clearing
    // event, not two.
    const alerts = [
      makeAlert({ lat: BASE_LAT }),
      makeAlert({ lat: BASE_LAT + 0.0008983 }), // ~100m north
    ];
    const clusters = clusterAlerts(alerts);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
  });

  it("splits two detections 50km apart into two clusters", () => {
    const alerts = [
      makeAlert({ lat: BASE_LAT }),
      makeAlert({ lat: BASE_LAT + 0.4491556 }), // ~50km north
    ];
    const clusters = clusterAlerts(alerts);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.count === 1)).toBe(true);
  });

  it("reports the strongest confidence present (high beats nominal beats low)", () => {
    const alerts = [
      makeAlert({ lat: BASE_LAT, confidence: "low" }),
      makeAlert({ lat: BASE_LAT + 0.0005, confidence: "high" }),
      makeAlert({ lat: BASE_LAT + 0.001, confidence: "nominal" }),
    ];
    const clusters = clusterAlerts(alerts);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].maxConfidence).toBe("high");
  });

  it("computes firstSeen/lastSeen independent of input order", () => {
    const alerts = [
      makeAlert({ lat: BASE_LAT, acqDate: "2026-06-05" }),
      makeAlert({ lat: BASE_LAT + 0.0003, acqDate: "2026-06-01" }),
      makeAlert({ lat: BASE_LAT + 0.0006, acqDate: "2026-06-03" }),
    ];
    const clusters = clusterAlerts(alerts);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].firstSeen).toBe("2026-06-01");
    expect(clusters[0].lastSeen).toBe("2026-06-05");
  });

  it("sums frp and roughly matches the true extent of a spread-out chain cluster", () => {
    // A chain of 5 points, each ~1.4km from the next (under the 1.5km eps so
    // they all density-link into one cluster) running ~5.6km north-south.
    // spanKm is the bounding-box diagonal, not the true path length, but for
    // a straight chain like this they're almost the same thing.
    const step = 1400 / 111320;
    const alerts = Array.from({ length: 5 }, (_, i) =>
      makeAlert({ lat: BASE_LAT + i * step, frp: 5 })
    );
    const clusters = clusterAlerts(alerts);
    expect(clusters).toHaveLength(1);
    const c = clusters[0];
    expect(c.count).toBe(5);
    expect(c.frpSum).toBe(25);
    expect(c.spanKm).toBeGreaterThan(5.4);
    expect(c.spanKm).toBeLessThan(5.8);
  });
});
