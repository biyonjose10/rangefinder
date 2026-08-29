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
 * Region queries go through a spatial grid rather than scanning every point.
 * The naive O(n²) version was fine at 394 detections and became a real cost at
 * 1,924 — 3.7 million distance computations, a visible slice of an API response
 * already near the serverless time limit. Bucketing at the epsilon radius means
 * each query touches nine cells instead of the whole set.
 */
export function clusterAlerts(alerts: Alert[]): Cluster[] {
  const n = alerts.length;
  const labels = new Int32Array(n).fill(-1); // -1 unvisited, -2 noise
  let clusterId = 0;

  // Grid cells one epsilon across, so every point within EPS_M of a query is
  // guaranteed to sit in one of the nine cells around it. Longitude degrees
  // shrink with latitude, hence the cosine term.
  const meanLat = n ? alerts.reduce((s, a) => s + a.lat, 0) / n : 0;
  const cellLat = EPS_M / 111320;
  const cellLon = cellLat / Math.max(0.15, Math.cos((meanLat * Math.PI) / 180));

  const grid = new Map<string, number[]>();
  const cellOf = (a: Alert) =>
    `${Math.floor(a.lat / cellLat)},${Math.floor(a.lon / cellLon)}`;

  for (let i = 0; i < n; i++) {
    const k = cellOf(alerts[i]);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }

  const neighbours = (i: number): number[] => {
    const a = alerts[i];
    const gy = Math.floor(a.lat / cellLat);
    const gx = Math.floor(a.lon / cellLon);
    const out: number[] = [];

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${gy + dy},${gx + dx}`) ?? []) {
          if (haversineM(a.lat, a.lon, alerts[j].lat, alerts[j].lon) <= EPS_M) {
            out.push(j);
          }
        }
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

  const events = [...buckets.values()].map(summarise);

  // Two events whose centroids land in the same cell would share an id, and an
  // id is what every later lookup — the map, the plan, the printed order — uses
  // to mean "this fire and not that one". Rare at 1,500 m separation, but a
  // silent merge is not an acceptable failure, so collisions get a suffix.
  const seen = new Set<string>();
  for (const e of events) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      continue;
    }
    let n = 2;
    while (seen.has(`${e.id}-${n}`)) n++;
    e.id = `${e.id}-${n}`;
    seen.add(e.id);
  }

  return events;
}

/**
 * Grid an id is quantised to, in degrees. About 1.1 km — wider than a
 * cluster's centroid drifts as new detections land on it between two requests,
 * and narrower than the 1,500 m that separates one clearing event from the
 * next.
 */
const ID_CELL_DEG = 0.01;

/**
 * A clearing event's identity is its *place*, not its position in the scan.
 *
 * Ids used to be the DBSCAN sequence number — C000, C001 — which meant they
 * changed meaning every time FIRMS published. The queue and the planned day are
 * fetched separately (sequencing is far dearer than ranking, so it is only done
 * on request), and a single new fire appearing between those two calls shifted
 * every id after it: the plan would then be talking about targets the list on
 * screen had never heard of, and the interface silently dropped the connection
 * between them. Observed live — 3,697 detections became 3,074 inside a minute.
 *
 * Quantising the centroid gives an id that means the same thing in both
 * responses, and reads as a location on the printed order rather than as a row
 * number.
 */
function clusterId(lat: number, lon: number): string {
  const cell = (v: number) =>
    (Math.round(Math.abs(v) / ID_CELL_DEG) * ID_CELL_DEG).toFixed(2);
  return `C${cell(lat)}${lat < 0 ? "S" : "N"}${cell(lon)}${lon < 0 ? "W" : "E"}`;
}

function summarise(members: Alert[]): Cluster {
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
  const lat = latSum / members.length;
  const lon = lonSum / members.length;

  return {
    id: clusterId(lat, lon),
    lat,
    lon,
    count: members.length,
    frpSum,
    maxConfidence,
    firstSeen,
    lastSeen,
    spanKm,
    alerts: members,
  };
}
