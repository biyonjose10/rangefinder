/**
 * Application-wide settings.
 *
 * Deliberately holds nothing geographic. Areas of operation used to live here
 * as a hardcoded bounding box and label, which meant the honest answer to "does
 * this work anywhere else?" was "yes, if you edit the source". Areas are now
 * folders under `data/aoi/`, discovered at runtime — see `lib/aoi.ts`.
 */

/**
 * DEMO_MODE forces the app to serve cached fixtures instead of calling live
 * APIs. Set it before recording: a conference wifi timeout should never be the
 * reason a viewer sees a spinner. Live is the default so the deployed site
 * shows genuinely current detections, and /api/targets already falls back to
 * the cached snapshot on its own if a live fetch fails.
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
    name: "ESA WorldCover 10m v200 (2021)",
    url: "https://esa-worldcover.org/",
    licence: "CC BY 4.0",
  },
  {
    name: "Copernicus Sentinel-2 L2A via Microsoft Planetary Computer",
    url: "https://planetarycomputer.microsoft.com/",
    licence: "Copernicus open licence",
  },
] as const;
