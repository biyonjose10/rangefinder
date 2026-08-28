**Live demo:** https://rangefinder-cyan.vercel.app

# Rangefinder — Devpost submission copy

*Deforestation alert triage for forest rangers. Built for Hack the Habitat.*

## Inspiration

Satellite deforestation alerting has largely been solved: NASA FIRMS, Global Forest Watch and others already put near-real-time fire and clearing detections in front of protected-area offices. What none of them answer is the question a ranger actually has at 7am: out of thousands of dots on a map, which two or three are worth a full day's drive? That gap — between "here is the data" and "here is what to do about it" — is where alerts stop turning into patrols and trees keep falling. Rangefinder is built to close that specific gap, not to compete with the satellites.

## Problem

A protected-area office receives thousands of near-real-time satellite fire/clearing detections a week and can realistically field one or two patrols. Today that choice is made by eyeballing a heatmap — whichever cluster of dots looks biggest and closest wins the crew's time for the day.

That method fails predictably. Most alerts are unreachable by any mapped road, days old, too small to matter, or sitting on land where burning is entirely legal. Worse, a heatmap visually equates a 100-detection burn on unclassified frontier with a 2-detection burn inside a legally protected indigenous territory — the second, which is the one that's actually illegal and actionable, barely registers next to the first. The result: real illegal clearing inside protected land can sit unactioned simply because it never looked urgent on a map built for volume, not priority.

## Implementation

Rangefinder is a pipeline, not a dashboard skin:

1. **Fetch** — pulls the live NASA FIRMS VIIRS NOAA-20 (Collection 2, NRT) bulk regional CSV for South America, no API key required, clipped to the demo Area of Interest (Upper Xingu Basin, Mato Grosso, Brazil).
2. **Cluster** — DBSCAN (1,500 m radius) groups the raw 375 m-pixel detections into distinct clearing *events*, so the output is a list of fires, not a list of pixels.
3. **Score** — each event is scored 0–100 by an explicit **Actionability Score**: a weighted geometric mean of six factors — extent (0.28), protection status (0.22), recency (0.20), road access (0.15), detection confidence (0.10), and proximity to the ranger post (0.05). The geometric mean means one disqualifying factor (nothing can reach it) collapses the score rather than being smoothed away by the others. Protection status is tested by ray-casting each coordinate against the real OpenStreetMap boundary polygon for Parque Indígena do Xingu (3,805 nodes) — not a distance-from-centroid approximation, which we tried first and found actively dangerous (see below).
4. **Render** — a ranked queue drives a dark MapLibre GL map and a sidebar list, each target showing its factor breakdown and a plain-English rationale.
5. **Dispatch** — one click renders a real, printable PDF Patrol Dispatch Order (`@react-pdf/renderer`) for the top-ranked targets: GPS in both decimal and DMS, road-access distance and estimated drive time, per-target justification, source attribution, and field checkboxes for what the crew actually found.

On a live run (2026-08-28): 13,733 VIIRS detections across South America in 24h, 394 inside the demo AOI, clustered into 10 events, cross-referenced against 4,216 OpenStreetMap road segments, end-to-end API response ~200ms. The top target is a 103-detection, 1,282 MW fire on unclassified land; rank 5 is a 2-detection fire scoring 55.4 because it falls inside the Xingu Indigenous Park — invisible on a heatmap, a named, justified target on the patrol queue. We also tested our own evidence rather than trusting it: an initial Sentinel-2 NDVI drop of -0.0667 shrank to -0.0190 once compared against an undisturbed control sampled from the same two images, meaning ~71% of the apparent "canopy loss" was seasonality. That corrected figure, and the ~20% unmasked smoke contamination that still confounds it, are reported in the interface rather than hidden.

An earlier version approximated protected areas as a disc around their centroid. On this AOI that was wrong in the worst direction: the Xingu centroid sits roughly 140 km from the largest fire cluster, so any radius wide enough to matter would have falsely flagged legal frontier burning as illegal clearing inside indigenous land. We replaced it with real point-in-polygon containment against the OSM boundary. A tool that tells a ranger to raid the wrong place is worse than no tool at all — getting this right mattered more than shipping the first version.

## Technologies

Next.js 16 (App Router, API routes) · React 19 · TypeScript · Tailwind CSS 4 · MapLibre GL JS · @react-pdf/renderer · NASA FIRMS (VIIRS NOAA-20 C2 NRT) · OpenStreetMap / Overpass API · Copernicus Sentinel-2 L2A via Microsoft Planetary Computer · CARTO dark-matter basemap · deployed on Vercel.

No machine-learning model is used for scoring — deliberately: there is no labelled dataset of "patrols that were worth sending," so a learned model would be unfalsifiable dressing. The six-factor score is hand-specified and documented so a ranger can argue with it.

## What's next

- Configurable AOIs and ranger posts, instead of the single hard-coded demo region.
- Fresher, denser road data for remote frontier areas, where OSM coverage is often the weakest link in the access estimate.
- A record of which orders were issued and what patrols actually found, closing the loop back into the score.
- Extending beyond the Amazon frontier case to other FIRMS regions (Africa and South/Southeast Asia sources are already wired in `lib/sources/firms.ts`).

## Demo video shot list (2:00)

| Time | Shot |
|---|---|
| 0:00–0:15 | Open cold on the impact number, not a title card: the sidebar/map showing **13,733 detections → 394 in AOI → 10 events**, full screen. |
| 0:15–0:35 | Voiceover states the problem in one breath: thousands of alerts, one patrol, no way to choose today. Cut to the dark map with the raw detection cloud. |
| 0:35–1:20 | **Uninterrupted live screen capture.** Click through the ranked patrol queue top to bottom; open rank 1 (the big legal frontier fire) and rank 5 (the 2-detection Xingu fire) to show the factor bars and rationale side by side; click "Generate patrol order" and let the PDF render and open in-browser. No cuts. |
| 1:20–1:40 | Zoom on the PDF: GPS in DMS, access/transit line, the "INSIDE PROTECTED TERRITORY" tag, the field checkboxes. |
| 1:40–1:55 | One sentence on the centroid-vs-boundary near-miss, with the map showing the Xingu polygon and the 140 km gap to the big cluster — the honesty beat. |
| 1:55–2:00 | Close on the thesis line: "A heatmap hides the small illegal fire behind the big legal one. Rangefinder doesn't." |
