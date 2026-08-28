import type { Alert } from "../types";

/**
 * NASA FIRMS — near-real-time active fire / thermal anomaly detections.
 *
 * We use the public bulk regional CSV rather than the keyed Area API. It is
 * updated on the same NRT cadence, carries the identical schema, and requires
 * no MAP_KEY — which means this application has no credential to leak, no
 * signup wall between a ranger and the data, and no rate limit to exhaust
 * during a demo.
 *
 * Source:  https://firms.modaps.eosdis.nasa.gov/active_fire/
 * Licence: NASA open data — free and unrestricted use, attribution requested.
 */

export const FIRMS_SOURCES = {
  south_america:
    "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_America_24h.csv",
  africa:
    "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Africa_24h.csv",
  south_asia:
    "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_Asia_24h.csv",
  southeast_asia:
    "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_SouthEast_Asia_24h.csv",
} as const;

export type FirmsRegion = keyof typeof FIRMS_SOURCES;

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

function normaliseConfidence(raw: string): Alert["confidence"] {
  const v = raw.trim().toLowerCase();
  if (v === "h" || v === "high") return "high";
  if (v === "l" || v === "low") return "low";
  return "nominal";
}

/** Parse the FIRMS CSV. The schema is stable and comma-only — no quoted fields
 *  appear in this product — so a full CSV parser would be dead weight. */
export function parseFirmsCsv(csv: string, bbox?: Bbox): Alert[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);

  const iLat = idx("latitude");
  const iLon = idx("longitude");
  const iDate = idx("acq_date");
  const iTime = idx("acq_time");
  const iConf = idx("confidence");
  const iFrp = idx("frp");
  const iDn = idx("daynight");

  if (iLat < 0 || iLon < 0) {
    throw new Error(`Unexpected FIRMS schema: ${header.join(",")}`);
  }

  const out: Alert[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    const lat = Number(f[iLat]);
    const lon = Number(f[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    if (
      bbox &&
      (lat < bbox.south || lat > bbox.north || lon < bbox.west || lon > bbox.east)
    ) {
      continue;
    }

    out.push({
      lat,
      lon,
      acqDate: f[iDate],
      acqTime: f[iTime],
      confidence: normaliseConfidence(f[iConf] ?? ""),
      frp: Number(f[iFrp]) || 0,
      dayNight: (f[iDn] ?? "D").trim() === "N" ? "N" : "D",
    });
  }
  return out;
}

/** Fetch live detections for a bounding box. Throws on network failure so the
 *  caller can decide whether to fall back to cached fixtures. */
export async function fetchLiveAlerts(
  region: FirmsRegion,
  bbox: Bbox,
  signal?: AbortSignal
): Promise<Alert[]> {
  const res = await fetch(FIRMS_SOURCES[region], {
    signal,
    // The bulk file changes a few times a day; a short revalidation window keeps
    // the demo snappy without serving genuinely stale fire data.
    next: { revalidate: 900 },
  });

  if (!res.ok) {
    throw new Error(`FIRMS returned ${res.status} ${res.statusText}`);
  }

  return parseFirmsCsv(await res.text(), bbox);
}
