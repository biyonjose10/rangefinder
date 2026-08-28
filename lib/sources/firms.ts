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

/**
 * Four satellites carry suitable instruments, and this used only one.
 *
 * That was not merely fewer detections, it was *biased* detections. Each
 * platform crosses at a different local solar time, so a fire that ignites
 * after NOAA-20's overpass and burns out before its next one is invisible here
 * while sitting plainly in the Suomi-NPP feed. Recency is 17% of the
 * actionability score, and we were computing it from a third of the evidence.
 *
 * Measured on one South American day: NOAA-20 13,733, Suomi-NPP 14,562,
 * NOAA-21 11,651, MODIS 3,648.
 */
const PLATFORMS = [
  { id: "NOAA-20", path: "noaa-20-viirs-c2", prefix: "J1_VIIRS_C2" },
  { id: "Suomi-NPP", path: "suomi-npp-viirs-c2", prefix: "SUOMI_VIIRS_C2" },
  { id: "NOAA-21", path: "noaa-21-viirs-c2", prefix: "J2_VIIRS_C2" },
] as const;

const CSV = (region: string, p: (typeof PLATFORMS)[number] = PLATFORMS[0]) =>
  `https://firms.modaps.eosdis.nasa.gov/data/active_fire/${p.path}/csv/${p.prefix}_${region}_24h.csv`;

/**
 * The regional 24-hour files FIRMS actually publishes.
 *
 * These names are not guessable — there is no "Africa" or "North_America"
 * file, and an earlier version of this list assumed both existed. Verified
 * against the live endpoint; anything not listed here returns 404.
 */
/** Region key -> the name FIRMS uses in its filenames. */
export const FIRMS_REGION_NAMES = {
  south_america: "South_America",
  northern_and_central_africa: "Northern_and_Central_Africa",
  southern_africa: "Southern_Africa",
  south_asia: "South_Asia",
  southeast_asia: "SouthEast_Asia",
  europe: "Europe",
  russia_asia: "Russia_Asia",
  global: "Global",
} as const;

/** Primary platform URL per region, kept for reference and attribution. */
export const FIRMS_SOURCES = Object.fromEntries(
  Object.entries(FIRMS_REGION_NAMES).map(([k, v]) => [k, CSV(v)])
) as Record<keyof typeof FIRMS_REGION_NAMES, string>;

export type FirmsRegion = keyof typeof FIRMS_REGION_NAMES;

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

/**
 * The same ground fire seen by two satellites is one event, not two.
 *
 * Overpasses are minutes to hours apart, so a burning clearing appears in
 * several feeds at slightly different coordinates. Without this, extent — the
 * heaviest factor in the score — would be inflated roughly threefold for any
 * fire that happens to be visible to all three platforms, and not at all for
 * one seen by a single satellite. That would be worse than using one feed.
 *
 * Detections are collapsed onto a ~350 m grid (roughly the VIIRS pixel) within
 * the same hour. The survivor is the one with the highest radiative power,
 * since that is the strongest observation of the same fire.
 */
function dedupe(alerts: Alert[]): Alert[] {
  const CELL_DEG = 0.0032; // ~350 m, one VIIRS I-band pixel
  const best = new Map<string, Alert>();

  for (const a of alerts) {
    const key =
      `${Math.round(a.lat / CELL_DEG)},${Math.round(a.lon / CELL_DEG)},` +
      `${a.acqDate},${a.acqTime.slice(0, 2)}`;
    const prev = best.get(key);
    if (!prev || a.frp > prev.frp) best.set(key, a);
  }

  return [...best.values()];
}

/**
 * Fetch live detections for a bounding box across every available platform.
 *
 * Platforms are fetched in parallel and failures are tolerated individually —
 * losing one satellite degrades coverage, but throwing away the other two
 * because of it would be worse. Only if every platform fails does this throw,
 * letting the caller fall back to the cached snapshot.
 */
export async function fetchLiveAlerts(
  region: FirmsRegion,
  bbox: Bbox,
  signal?: AbortSignal
): Promise<Alert[]> {
  const results = await Promise.allSettled(
    PLATFORMS.map(async (p) => {
      const res = await fetch(CSV(FIRMS_REGION_NAMES[region], p), {
        signal,
        // The bulk files change a few times a day; a short revalidation window
        // keeps things responsive without serving genuinely stale fire data.
        next: { revalidate: 900 },
      });
      if (!res.ok) throw new Error(`${p.id} returned ${res.status}`);
      return parseFirmsCsv(await res.text(), bbox);
    })
  );

  const ok = results.filter((r) => r.status === "fulfilled");
  if (ok.length === 0) {
    const why = results
      .map((r) => (r.status === "rejected" ? String(r.reason) : ""))
      .filter(Boolean)
      .join("; ");
    throw new Error(`every FIRMS platform failed: ${why}`);
  }

  return dedupe(ok.flatMap((r) => (r as PromiseFulfilledResult<Alert[]>).value));
}
