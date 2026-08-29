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

1. **Fetch** — pulls the live NASA FIRMS VIIRS bulk regional CSVs for all three satellites (NOAA-20, Suomi-NPP, NOAA-21; Collection 2, NRT, no API key required), clips them to the selected area and merges them with spatio-temporal deduplication. Each platform crosses at a different local solar time, so a fire that starts and ends between one satellite's overpasses is invisible to it and plain in another's.
2. **Cluster** — DBSCAN (1,500 m radius) groups the raw 375 m-pixel detections into distinct clearing *events*, so the output is a list of fires, not a list of pixels.
3. **Score** — each event is scored 0-100 by an explicit **Actionability Score**: a weighted geometric mean of factors covering extent, forest baseline, protection status, recency, road access, detection confidence and proximity to the ranger post. The geometric mean means one disqualifying factor (nothing can reach it) collapses the score rather than being smoothed away by the others. Protection status is tested by ray-casting each coordinate against the real OpenStreetMap boundary polygon for Parque Indígena do Xingu (3,805 nodes) — not a distance-from-centroid approximation, which we tried first and found actively dangerous (see below).
4. **Render** — a ranked queue drives a dark MapLibre GL map and a sidebar list, each target showing its factor breakdown and a plain-English rationale.
5. **Dispatch** — one click renders a real, printable PDF Patrol Dispatch Order (`@react-pdf/renderer`) for the top-ranked targets: GPS in both decimal and DMS, road-access distance and estimated drive time, per-target justification, source attribution, and field checkboxes for what the crew actually found.

On a live run (2026-08-28), across two areas on two continents: **1,047 detections resolved into 17 clearing events** in the Upper Xingu (Brazil) and **3,697 into 115 events** in the Sebangau peatlands (Indonesia), merged from three VIIRS satellites and cross-referenced against 8,067 and 45,489 OpenStreetMap road segments respectively. Sebangau's top-ranked target is a 37-detection, 1,287 MW fire **inside Taman Nasional Sebangau**, on land that was 97% closed forest at baseline, 25 km by road from the ranger post. In Xingu the highest-ranked protected-land fire has just two detections — invisible on a heatmap, a named and justified target on the patrol queue. We also tested our own evidence rather than trusting it: an initial Sentinel-2 NDVI drop of -0.0667 shrank to -0.0190 once compared against an undisturbed control sampled from the same two images, meaning ~71% of the apparent "canopy loss" was seasonality. That corrected figure, and the ~20% unmasked smoke contamination that still confounds it, are reported in the interface rather than hidden.

An earlier version approximated protected areas as a disc around their centroid. On this AOI that was wrong in the worst direction: the Xingu centroid sits roughly 140 km from the largest fire cluster, so any radius wide enough to matter would have falsely flagged legal frontier burning as illegal clearing inside indigenous land. We replaced it with real point-in-polygon containment against the OSM boundary. A tool that tells a ranger to raid the wrong place is worse than no tool at all — getting this right mattered more than shipping the first version.

## Technologies

Next.js 16 (App Router, API routes) · React 19 · TypeScript · Tailwind CSS 4 · MapLibre GL JS · @react-pdf/renderer · NASA FIRMS (VIIRS NOAA-20 / Suomi-NPP / NOAA-21, C2 NRT) · OpenStreetMap / Overpass API · Copernicus Sentinel-2 L2A via Microsoft Planetary Computer · CARTO dark-matter basemap · deployed on Vercel.

No machine-learning model is used for scoring — deliberately: there is no labelled dataset of "patrols that were worth sending," so a learned model would be unfalsifiable dressing. The seven-factor score is hand-specified and documented so a ranger can argue with it.

## What's next

- Per-station configuration: areas are already data rather than code (`scripts/setup_aoi.py` builds one from a bounding box), but each still carries a single origin station picked automatically as the nearest settlement.
- Fresher, denser road data for remote frontier areas, where OSM coverage is often the weakest link in the access estimate.
- A record of which orders were issued and what patrols actually found, closing the loop back into the score.
- Extending beyond the Amazon frontier case to other FIRMS regions (Africa and South/Southeast Asia sources are already wired in `lib/sources/firms.ts`).

## Demo video script (2:00)

Deadline: **Aug 30 2026, 11:45pm CDT** (Aug 31, 10:15 AM IST).

Timings are **finished runtime**, with loading cut. Every ✂ marks a pause to
edit out. **Read every live figure off the screen** — this is live FIRMS data
and it moves hourly, so the counts below are shapes, not numbers to script.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:10 | Sebangau loaded, header counts visible, mouse still. ✂ record only after the roads have drawn | "One protected area, one day. Three thousand satellite fire detections in twenty-four hours. A hundred distinct clearing events. The park office can send one patrol." |
| 0:10–0:25 | Zoom slowly into the orange detection cloud until individual VIIRS pixels resolve | "That choice gets made by eyeballing a heatmap. But most of these fires are legal pasture burns on land cleared years ago. And a heatmap makes a big legal fire outrank a small illegal one inside a national park." |
| 0:25–0:40 | Click rank 1. Factor bars and rationale fill the sidebar | "Rangefinder ranks them. Top of the queue is inside Taman Nasional Sebangau, on land that was eighty percent closed forest. Seven factors, every one visible and arguable. Deliberately not machine learning — a ranger can argue with seven numbers." |
| 0:40–0:54 | Cursor rests on the **Forest** bar, then the forest-baseline tag | "The forest factor matters most. FIRMS detects heat, not deforestation. Without a baseline the tool ranks farm burns as urgent clearing, and looks convincing doing it. Every target is checked against ESA WorldCover." |
| 0:54–1:26 | Click **Plan the day**. ✂ hold two seconds of the pause, then cut to the drawn loop | "Ranking isn't enough, because a crew drives one loop, not five round trips. This sequences the day — four targets, one loop from Palangka Raya and back, eight and a half hours including time on the ground. As separate return trips that same list implies sixteen hours. And the top-priority target is stop one of four: priority and driving order are different questions. The one that doesn't fit is named and carried forward." |
| 1:26–1:42 | Click **Generate patrol order**. ✂ cut the render. Land on a task card and scroll one beat | "One click and it's a field order. GPS in decimal and DMS, road distance, drive time, the reason this target was chosen, and checkboxes for what the crew found. Every order says thermal detections aren't proof of illegality." |
| 1:42–1:49 | Switch area with the picker to Upper Xingu. ✂ cut the load, land on the drawn map | "And it's not one hardcoded valley. Same pipeline, different continent — the Upper Xingu in Brazil." |
| 1:49–2:00 | Rest on the ranked queue | "Detection is solved. Deciding which alert to drive to first is not. A heatmap hides the small illegal fire behind the big legal one. Rangefinder doesn't." |

### Where the four cuts are

1. **Before the first frame** — the road network is a 5.9 MB GeoJSON and takes
   10–15 s. Open `?aoi=kalimantan-sebangau`, count to twenty, *then* record, or
   the opening shot is an empty map.
2. **Plan the day**, about 10 s. It is routing every pair of targets across a
   real road graph. Keep two seconds of it rather than cutting clean — the
   pause is evidence the routing is real, and an instant result looks mocked.
3. **PDF render**, 2–4 s.
4. **Area switch**, 10–15 s for the second road network.

### If it runs long

Drop the area-switch beat (1:42–1:49) — it is the only one that costs a cut as
well as time. Protect the "sixteen hours" line: it is the clearest evidence in
the demo that the tool was built around the ranger's day rather than the data.

### Recording setup

- Deep-link straight in: `rangefinder-cyan.vercel.app/?aoi=kalimantan-sebangau`
- Hide the bookmarks bar (Ctrl+Shift+B); full window, 1080p or better
- Close any existing patrol-order tab first, so the PDF opens visibly
- Check page 2 of the PDF before recording — tasked targets continue there,
  along with the "considered but not tasked" list
