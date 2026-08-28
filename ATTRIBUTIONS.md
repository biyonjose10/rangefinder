# Attributions

Rangefinder combines several open datasets, APIs, and open-source libraries. This document credits every one of them, as required by the Hack the Habitat submission rules.

## Data sources

| Source | What it provides | Licence | URL |
|---|---|---|---|
| **NASA FIRMS** (Fire Information for Resource Management System) — VIIRS Collection 2 Near Real-Time, from **three platforms: NOAA-20 (JPSS-1), Suomi-NPP and NOAA-21 (JPSS-2)** | Active-fire / thermal-anomaly detections — the raw satellite alerts the whole pipeline is built from. All three platforms are fetched from the public bulk regional CSV products and merged with spatio-temporal deduplication, because each crosses at a different local solar time and no single one sees every fire. | NASA open data — free and unrestricted use, attribution requested | https://firms.modaps.eosdis.nasa.gov/ |
| **OpenStreetMap**, via the Overpass API | Road/track network used for the access-distance factor, and the boundary polygon for Parque Indígena do Xingu (OSM relation 3542572) used for the protected-area containment test | Open Database Licence (ODbL) 1.0 — © OpenStreetMap contributors | https://www.openstreetmap.org/copyright |
| **Copernicus Sentinel-2 L2A**, via Microsoft Planetary Computer | Before/after satellite imagery and NDVI (vegetation index) used to independently verify vegetation loss at the demo AOI | Copernicus open data licence | https://planetarycomputer.microsoft.com/ |
| **ESA WorldCover 10m v200 (2021)** | Baseline land cover. Provides the tree-cover figure behind the forest scoring factor, and was used to verify that ranked targets sit on land that was forest before the fire. | CC BY 4.0 — © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data | https://esa-worldcover.org/ |
| **Hansen Global Forest Change v1.12 (2024)**, `lossyear` band — Hansen/UMD/Google/USGS/NASA | Annual tree-cover loss, used to age-correct the 2021 WorldCover baseline so land cleared between 2021 and 2024 is no longer scored as intact forest | CC BY 4.0 | https://glad.umd.edu/dataset/global-2010-forest-change-1-00 |
| **Open-Meteo** | Cloud cover, wind and rainfall for each area. Cloud cover determines whether an empty queue means "nothing burning" or "nothing visible"; rainfall indicates whether unsealed tracks will be passable. | CC BY 4.0 | https://open-meteo.com/ |
| **OpenStreetMap** industrial and quarry features, via Overpass | Locations of permanent industrial heat sources, used to suppress detections that are a works or quarry radiating heat rather than a fire | ODbL 1.0 — © OpenStreetMap contributors | https://www.openstreetmap.org/copyright |

The map no longer uses a hosted basemap tile service. It renders from a
self-contained style plus the OpenStreetMap-derived road and boundary geometry
listed above, so OpenStreetMap attribution appears on the map itself.

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
| [Vitest](https://vitest.dev/) | Test runner | MIT |
| [rasterio](https://rasterio.readthedocs.io/) / [pystac-client](https://pystac-client.readthedocs.io/) | Raster and STAC access in the data-preparation scripts | BSD-3-Clause / Apache-2.0 |

## Notes on use

- The NASA FIRMS bulk CSV endpoint is used in preference to the keyed Area API: it requires no `MAP_KEY`, so the application holds no credential to leak and has no rate limit to exhaust during a demo, while carrying the identical NRT data on the same update cadence.
- OSM data is used under ODbL 1.0, which requires attribution and share-alike for produced/derivative databases; Rangefinder consumes OSM data for display and analysis and does not redistribute a modified copy of the OSM database itself.
- No paid or key-gated API is used anywhere in the pipeline.
