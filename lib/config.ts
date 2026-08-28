import type { Bbox, FirmsRegion } from "./sources/firms";

/**
 * The demo Area of Interest.
 *
 * Not chosen for scenery. It contains the single densest cluster of active-fire
 * detections in South America on the day this was built (176 VIIRS detections
 * in one 0.1° cell in 24 hours), and it is drawn wide enough to also cover the
 * northern half of Parque Indígena do Xingu.
 *
 * That pairing is the point. The frontier fires are enormous and legal; the
 * in-park fires are tiny and prima facie illegal. A heatmap shows you the first
 * and hides the second. A triage function has to weigh them against each other
 * and show its working.
 */
export const AOI: Bbox = {
  south: -12.6,
  west: -54.6,
  north: -10.3,
  east: -53.0,
};

export const AOI_REGION: FirmsRegion = "south_america";

export const AOI_LABEL = "Upper Xingu Basin — Mato Grosso, Brazil";

export const AOI_CENTER: [number, number] = [
  (AOI.west + AOI.east) / 2,
  (AOI.south + AOI.north) / 2,
];

/**
 * DEMO_MODE forces the app to serve cached fixtures instead of calling live
 * APIs. Set it before recording: a conference wifi timeout should never be the
 * reason a judge sees a spinner. Live mode is the default so the deployed site
 * shows genuinely current detections.
 */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

/** How many targets make it onto a single patrol order. A crew with one vehicle
 *  and a working day can realistically service this many. */
export const PATROL_ORDER_SIZE = 5;

export const ATTRIBUTION = [
  {
    name: "NASA FIRMS (VIIRS NOAA-20, C2 NRT)",
    url: "https://firms.modaps.eosdis.nasa.gov/",
    licence: "NASA open data — free and unrestricted use",
  },
  {
    name: "OpenStreetMap via Overpass API",
    url: "https://www.openstreetmap.org/copyright",
    licence: "ODbL 1.0",
  },
  {
    name: "Copernicus Sentinel-2 L2A via Microsoft Planetary Computer",
    url: "https://planetarycomputer.microsoft.com/",
    licence: "Copernicus open licence",
  },
] as const;
