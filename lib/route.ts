import { haversineM } from "./geo";
import type { RoadSegment } from "./types";

/**
 * ROAD ROUTING
 * ============
 * Until this existed, the patrol order printed "173 km from the ranger post;
 * est. 5.2 h one way" from a *great-circle distance* divided by a flat 35 km/h.
 * In the Amazon a straight line is a fiction: the road distance is routinely
 * far longer, and some targets have no vehicle route at all.
 *
 * A number a crew plans a day around has to come from the road network, or it
 * should not be printed. This module builds a graph from the OSM ways we
 * already load and runs A* over it.
 *
 * "No route found" is a real and useful answer, not a failure — it means air
 * support or a river approach, and the order should say so rather than quietly
 * substituting a straight line.
 */

/** Typical sustained speeds on an unsealed tropical road network, km/h. */
const SPEED_KMH: Record<string, number> = {
  motorway: 90,
  trunk: 80,
  primary: 70,
  secondary: 55,
  tertiary: 45,
  unclassified: 35,
  residential: 30,
  road: 35,
  service: 20,
  living_street: 20,
  track: 18, // unsealed forest track — the dominant class out here
};
const DEFAULT_SPEED_KMH = 25;

/** Vertices closer than this are treated as the same junction. ~1.1 m. */
const SNAP_DP = 5;

/** A target further than this from any road is not reachable by vehicle. */
const MAX_SNAP_M = 8000;

type NodeId = number;

interface Edge {
  to: NodeId;
  metres: number;
  hours: number;
}

export interface RouteResult {
  /** Distance along the road network, metres. */
  roadMetres: number;
  /** Estimated driving time on the network, hours. */
  driveHours: number;
  /** Extra straight-line distance from the road to the target, metres. */
  offRoadMetres: number;
  /** Polyline of the route in GeoJSON order ([lon, lat]), for drawing. */
  geometry: [number, number][];
  /** roadMetres / straight-line metres — how much the map lies. */
  detourRatio: number;
}

/**
 * Binary min-heap keyed on f-score.
 *
 * This began as a linear scan over the open set, on the reasoning that the
 * graph was small and routing ran a handful of times per request. Adding a
 * second area falsified that: 114 clearing events over a 411,494-node network
 * took thirty seconds, almost all of it rescanning the frontier. The heap is
 * not premature optimisation here, it is the difference between usable and not.
 */
class MinHeap {
  private ids: NodeId[] = [];
  private fs: number[] = [];

  get size() {
    return this.ids.length;
  }

  push(id: NodeId, f: number) {
    this.ids.push(id);
    this.fs.push(f);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.fs[p] <= this.fs[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): NodeId | undefined {
    if (!this.ids.length) return undefined;
    const top = this.ids[0];
    const lastId = this.ids.pop()!;
    const lastF = this.fs.pop()!;
    if (this.ids.length) {
      this.ids[0] = lastId;
      this.fs[0] = lastF;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.fs.length && this.fs[l] < this.fs[m]) m = l;
        if (r < this.fs.length && this.fs[r] < this.fs[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.fs[a], this.fs[b]] = [this.fs[b], this.fs[a]];
  }
}

export class RoadGraph {
  private coords: [number, number][] = [];
  private adj: Edge[][] = [];
  /** Fastest speed actually present, for the A* heuristic. */
  private maxKmh = 1;
  private index = new Map<string, NodeId>();
  /** Coarse spatial bucket (0.05°) so nearest-node lookup is not O(n). */
  private buckets = new Map<string, NodeId[]>();

  constructor(segments: RoadSegment[]) {
    for (const seg of segments) {
      const speed = SPEED_KMH[seg.highway] ?? DEFAULT_SPEED_KMH;
      if (speed > this.maxKmh) this.maxKmh = speed;
      let prev: NodeId | null = null;

      for (const [lon, lat] of seg.coords) {
        const id = this.nodeFor(lon, lat);
        if (prev !== null && prev !== id) {
          const m = haversineM(
            this.coords[prev][1],
            this.coords[prev][0],
            lat,
            lon
          );
          const h = m / 1000 / speed;
          // Undirected: one-way restrictions are not in our extract, and for
          // a distance estimate the error from ignoring them is far smaller
          // than the error we are replacing.
          this.adj[prev].push({ to: id, metres: m, hours: h });
          this.adj[id].push({ to: prev, metres: m, hours: h });
        }
        prev = id;
      }
    }
  }

  private key(lon: number, lat: number) {
    return `${lon.toFixed(SNAP_DP)},${lat.toFixed(SNAP_DP)}`;
  }

  private bucketKey(lon: number, lat: number) {
    return `${Math.floor(lon / 0.05)},${Math.floor(lat / 0.05)}`;
  }

  private nodeFor(lon: number, lat: number): NodeId {
    const k = this.key(lon, lat);
    const existing = this.index.get(k);
    if (existing !== undefined) return existing;

    const id = this.coords.length;
    this.coords.push([lon, lat]);
    this.adj.push([]);
    this.index.set(k, id);

    const bk = this.bucketKey(lon, lat);
    const b = this.buckets.get(bk);
    if (b) b.push(id);
    else this.buckets.set(bk, [id]);

    return id;
  }

  get size() {
    return this.coords.length;
  }

  /**
   * Nearest graph node, searching outward through spatial buckets.
   *
   * Tracked as primitives rather than a nullable object: the object form made
   * TypeScript's control-flow analysis narrow the accumulator to `never` after
   * the nested loops, and primitives sidestep that while avoiding an
   * allocation per candidate.
   */
  nearest(lat: number, lon: number): { id: NodeId; metres: number } | null {
    let bestId = -1;
    let bestM = Infinity;

    const bx = Math.floor(lon / 0.05);
    const by = Math.floor(lat / 0.05);

    for (let ring = 0; ring <= 4; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          // Only the cells added by this ring.
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          for (const id of this.buckets.get(`${bx + dx},${by + dy}`) ?? []) {
            const m = haversineM(lat, lon, this.coords[id][1], this.coords[id][0]);
            if (m < bestM) {
              bestM = m;
              bestId = id;
            }
          }
        }
      }
      // Search one ring beyond the first hit: the true nearest node can sit
      // just across a bucket boundary from the one we found first.
      if (bestId !== -1 && ring > 0) break;
    }

    if (bestId === -1 || bestM > MAX_SNAP_M) return null;
    return { id: bestId, metres: bestM };
  }

  /**
   * A* over the road graph, minimising travel time.
   *
   * The heuristic is straight-line distance at the fastest speed in the table,
   * which never overestimates the true remaining time and so keeps A* admissible.
   */
  route(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number }
  ): RouteResult | null {
    const a = this.nearest(from.lat, from.lon);
    const b = this.nearest(to.lat, to.lon);
    if (!a || !b) return null;

    // Use the fastest speed actually in this network rather than a fixed 90.
    // The heuristic stays admissible either way, but assuming a motorway in a
    // network whose quickest road is a 55 km/h secondary makes it far too
    // optimistic, so A* explores a much larger frontier than it needs to.
    const MAX_KMH = this.maxKmh;
    const h = (n: NodeId) =>
      haversineM(this.coords[n][1], this.coords[n][0], this.coords[b.id][1], this.coords[b.id][0]) /
      1000 /
      MAX_KMH;

    const gScore = new Map<NodeId, number>([[a.id, 0]]);
    const dist = new Map<NodeId, number>([[a.id, 0]]);
    const cameFrom = new Map<NodeId, NodeId>();
    const open = new MinHeap();
    open.push(a.id, h(a.id));
    const closed = new Set<NodeId>();

    while (open.size) {
      const cur = open.pop()!;

      if (cur === b.id) {
        const geometry: [number, number][] = [];
        let n: NodeId | undefined = b.id;
        while (n !== undefined) {
          geometry.unshift(this.coords[n]);
          n = cameFrom.get(n);
        }
        const straight = haversineM(from.lat, from.lon, to.lat, to.lon);
        const roadMetres = dist.get(b.id)!;
        return {
          roadMetres,
          driveHours: gScore.get(b.id)!,
          offRoadMetres: b.metres,
          geometry,
          detourRatio: straight > 0 ? roadMetres / straight : 1,
        };
      }

      if (closed.has(cur)) continue;
      closed.add(cur);

      for (const e of this.adj[cur]) {
        if (closed.has(e.to)) continue;
        const tentative = (gScore.get(cur) ?? Infinity) + e.hours;
        if (tentative < (gScore.get(e.to) ?? Infinity)) {
          cameFrom.set(e.to, cur);
          gScore.set(e.to, tentative);
          dist.set(e.to, (dist.get(cur) ?? 0) + e.metres);
          open.push(e.to, tentative + h(e.to));
        }
      }
    }

    // Genuinely disconnected — a real answer, not an error.
    return null;
  }
}

/**
 * One graph per area, built on first use and kept for the life of the process.
 *
 * Keyed by area: an unkeyed cache would hand the previously loaded area's road
 * network to whichever area was requested next, silently routing patrols
 * across the wrong continent.
 */
const cache = new Map<string, RoadGraph>();

export function getRoadGraph(key: string, segments: RoadSegment[]): RoadGraph {
  const hit = cache.get(key);
  if (hit) return hit;
  const graph = new RoadGraph(segments);
  cache.set(key, graph);
  return graph;
}
