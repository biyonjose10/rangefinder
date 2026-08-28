const EARTH_RADIUS_M = 6371000;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Perpendicular distance in metres from a point to a line segment.
 *
 * Works in a local equirectangular projection around the point. Over the
 * sub-kilometre segments we deal with this is accurate to well under a metre,
 * and it avoids pulling in a full geodesy dependency.
 */
function pointToSegmentM(
  pLat: number,
  pLon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(toRad(pLat));

  const px = 0;
  const py = 0;
  const ax = (aLon - pLon) * mPerDegLon;
  const ay = (aLat - pLat) * mPerDegLat;
  const bx = (bLon - pLon) * mPerDegLon;
  const by = (bLat - pLat) * mPerDegLat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  // Degenerate segment (duplicate nodes are common in OSM data).
  if (lenSq === 0) return Math.hypot(ax - px, ay - py);

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

/**
 * Distance in metres from a point to the nearest road in a set of segments.
 * Returns Infinity when no roads are supplied, which the scorer treats as
 * "unreachable" rather than as an error.
 */
export function distanceToNearestRoadM(
  lat: number,
  lon: number,
  roads: { coords: [number, number][] }[]
): number {
  let best = Infinity;

  for (const road of roads) {
    const c = road.coords;
    for (let i = 0; i < c.length - 1; i++) {
      // c is GeoJSON order: [lon, lat]
      const d = pointToSegmentM(lat, lon, c[i][1], c[i][0], c[i + 1][1], c[i + 1][0]);
      if (d < best) {
        best = d;
        // A target sitting on a road is as accessible as it gets; stop early.
        if (best < 25) return best;
      }
    }
  }

  return best;
}

/**
 * Ray-casting point-in-polygon over a set of closed rings.
 *
 * Counts crossings of a ray cast east from the point; an odd count means the
 * point is inside. Operates on raw lon/lat degrees, which is safe here because
 * the test is topological — no distances are measured — so the projection
 * distortion that would break an area or length calculation is irrelevant.
 */
export function pointInRings(
  lon: number,
  lat: number,
  rings: [number, number][][]
): boolean {
  for (const ring of rings) {
    let inside = false;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      if (
        y1 > lat !== y2 > lat &&
        lon < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1
      ) {
        inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}
