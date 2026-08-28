# Attributions

Rangefinder combines several open datasets, APIs, and open-source libraries. This document credits every one of them, as required by the Hack the Habitat submission rules.

## Data sources

| Source | What it provides | Licence | URL |
|---|---|---|---|
| **NASA FIRMS** (Fire Information for Resource Management System) — VIIRS NOAA-20, Collection 2, Near Real-Time | Active-fire / thermal-anomaly detections (the raw satellite alerts the whole pipeline is built from), fetched from the public bulk regional CSV product | NASA open data — free and unrestricted use, attribution requested | https://firms.modaps.eosdis.nasa.gov/ |
| **OpenStreetMap**, via the Overpass API | Road/track network used for the access-distance factor, and the boundary polygon for Parque Indígena do Xingu (OSM relation 3542572) used for the protected-area containment test | Open Database Licence (ODbL) 1.0 — © OpenStreetMap contributors | https://www.openstreetmap.org/copyright |
| **Copernicus Sentinel-2 L2A**, via Microsoft Planetary Computer | Before/after satellite imagery and NDVI (vegetation index) used to independently verify vegetation loss at the demo AOI | Copernicus open data licence | https://planetarycomputer.microsoft.com/ |
| **CARTO** dark-matter basemap style | Basemap tiles for the MapLibre GL map | See CARTO attribution terms | https://carto.com/attributions |

Per-request attribution is also embedded in the generated Patrol Dispatch Order PDF (see `lib/config.ts` → `ATTRIBUTION`, rendered by `lib/pdf/PatrolOrder.tsx`) and in the application footer, so the credit travels with the document a ranger prints and carries into the field.

## Key libraries and frameworks

| Library | Purpose | Licence |
|---|---|---|
| [Next.js](https://nextjs.org/) | Application framework (App Router, API routes) | MIT |
| [React](https://react.dev/) / React DOM | UI runtime | MIT |
| [TypeScript](https://www.typescriptlang.org/) | Static typing throughout `lib/` and `app/` | Apache-2.0 |
| [Tailwind CSS](https://tailwindcss.com/) | Styling | MIT |
| [MapLibre GL JS](https://maplibre.org/) | Interactive map rendering | BSD-3-Clause |
| [@react-pdf/renderer](https://react-pdf.org/) | Server-side generation of the Patrol Dispatch Order PDF | MIT |
| [ESLint](https://eslint.org/) | Linting | MIT |
| ESA WorldCover 10m v200 (2021) | Global land cover, used to validate that ranked targets sit on forest | [esa-worldcover.org](https://esa-worldcover.org/) | CC BY 4.0 — © ESA WorldCover project / Contains modified Copernicus Sentinel data |

## Notes on use

- The NASA FIRMS bulk CSV endpoint is used in preference to the keyed Area API: it requires no `MAP_KEY`, so the application holds no credential to leak and has no rate limit to exhaust during a demo, while carrying the identical NRT data on the same update cadence.
- OSM data is used under ODbL 1.0, which requires attribution and share-alike for produced/derivative databases; Rangefinder consumes OSM data for display and analysis and does not redistribute a modified copy of the OSM database itself.
- No paid or key-gated API is used anywhere in the pipeline.
