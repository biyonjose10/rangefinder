import { haversineM } from "./geo";
import type { Alert, Cluster } from "./types";

/** Detections within this radius of each other are treated as one clearing event. */
const EPS_M = 1500;
const MIN_POINTS = 1;

const CONFIDENCE_RANK = { low: 0, nominal: 1, high: 2 } as const;

/**
 * DBSCAN over raw detections.
 *
 * VIIRS returns one row per 375 m pixel, so a single burning clearing produces
 * dozens of rows. Ranking raw rows would flood the patrol queue with fifty
 * entries describing the same fire. Clustering first is what makes the output
 * a list of *events* rather than a list of pixels — it is the difference
 * between a heatmap and a work order.
 *
 * Plain O(n²) region queries. At the scale that matters here (a protected area
 * yields hundreds of detections per day, not millions) this runs in
 * milliseconds, and a spatial index would be unjustified complexity.
 */
export function clusterAlerts(alerts: Alert[]): Cluster[] {
  const n = alerts.length;
  const labels = new Int32Array(n).fill(-1); // -1 unvisited, -2 noise
  let clusterId = 0;

  const neighbours = (i: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < n; j++) {
      if (haversineM(alerts[i].lat, alerts[i].lon, alerts[j].lat, alerts[j].lon) <= EPS_M) {
        out.push(j);
      }
    }
    return out;
  };

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;

    const seeds = neighbours(i);
    if (seeds.length < MIN_POINTS) {
      labels[i] = -2;
      continue;
    }

    labels[i] = clusterId;
    // Expand the frontier. `seeds` grows while we iterate, which is exactly the
    // density-reachability expansion DBSCAN specifies.
    for (let k = 0; k < seeds.length; k++) {
      const j = seeds[k];
      if (labels[j] === -2) labels[j] = clusterId;
      if (labels[j] !== -1) continue;

      labels[j] = clusterId;
      const inner = neighbours(j);
      if (inner.length >= MIN_POINTS) {
        for (const m of inner) if (labels[m] === -1) seeds.push(m);
      }
    }
    clusterId++;
  }

  const buckets = new Map<number, Alert[]>();
  for (let i = 0; i < n; i++) {
    const id = labels[i];
    if (id < 0) continue;
    const bucket = buckets.get(id);
    if (bucket) bucket.push(alerts[i]);
    else buckets.set(id, [alerts[i]]);
  }

  return [...buckets.entries()].map(([id, members]) => summarise(id, members));
}

function summarise(id: number, members: Alert[]): Cluster {
  let latSum = 0;
  let lonSum = 0;
  let frpSum = 0;
  let maxConfidence: Alert["confidence"] = "low";
  let firstSeen = members[0].acqDate;
  let lastSeen = members[0].acqDate;
  let minLat = members[0].lat, maxLat = members[0].lat;
  let minLon = members[0].lon, maxLon = members[0].lon;

  for (const a of members) {
    latSum += a.lat;
    lonSum += a.lon;
    frpSum += a.frp;
    if (CONFIDENCE_RANK[a.confidence] > CONFIDENCE_RANK[maxConfidence]) {
      maxConfidence = a.confidence;
    }
    if (a.acqDate < firstSeen) firstSeen = a.acqDate;
    if (a.acqDate > lastSeen) lastSeen = a.acqDate;
    if (a.lat < minLat) minLat = a.lat;
    if (a.lat > maxLat) maxLat = a.lat;
    if (a.lon < minLon) minLon = a.lon;
    if (a.lon > maxLon) maxLon = a.lon;
  }

  const spanKm = haversineM(minLat, minLon, maxLat, maxLon) / 1000;

  return {
    id: `C${String(id).padStart(3, "0")}`,
    lat: latSum / members.length,
    lon: lonSum / members.length,
    count: members.length,
    frpSum,
    maxConfidence,
    firstSeen,
    lastSeen,
    spanKm,
    alerts: members,
  };
}
