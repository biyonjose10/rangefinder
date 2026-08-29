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

## Demo video script (~2:30)

Deadline: **Aug 30 2026, 11:45pm CDT** (Aug 31, 10:15 AM IST). Devpost sets no
length limit, so this runs to 2:30 rather than squeezing the impact argument —
Environmental Impact is 30% of the score, the single heaviest criterion.

**Read every live figure off the screen as you record.** This is live FIRMS
data and it moves hourly; the counts below are shapes, not numbers to script.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:12 | Sebangau loaded, full window. Header counts visible. Do not move the mouse. | "This is one protected area, one day. Three and a half thousand satellite fire detections in twenty-four hours, resolved into a hundred-odd distinct clearing events. The park office can send one patrol." |
| 0:12–0:30 | Zoom slowly into the orange raw-detection cloud so the individual VIIRS pixels resolve. | "Today that choice gets made by eyeballing a heatmap — whichever blob looks biggest wins. That fails in a specific way. Most of these fires are on land cleared years ago: pasture maintenance, crop residue, entirely legal. And a heatmap makes a hundred-detection legal burn look more urgent than a two-detection fire inside a national park. The second one is the crime." |
| 0:30–0:52 | Click rank 1. Let the factor bars and rationale fill the sidebar. | "Rangefinder ranks them. Top of the queue sits inside Taman Nasional Sebangau, on land that was eighty percent closed forest at baseline. Seven factors, every one of them visible and arguable. Deliberately not a machine-learning model — there is no dataset of patrols that turned out to be worth sending, so a learned score would be unfalsifiable dressing. A ranger can argue with seven numbers." |
| 0:52–1:08 | Cursor rests on the **Forest** bar, then the "80% forest baseline" tag. | "The forest factor is the one that matters most. FIRMS detects heat, not deforestation. Without a baseline the tool ranks farm burns as urgent clearing and looks completely convincing doing it. Every target is checked against ESA WorldCover tree cover, aged forward with Hansen annual loss." |
| 1:08–1:38 | Click **Plan the day**. Do not cut — let the routing compute and the loop draw itself. | "Ranking alone is not enough, because a crew drives one loop, not five round trips. This sequences the day: four targets, one loop from Palangka Raya and back, eight and a half hours including time on the ground. Read the line underneath — as separate return trips the same list implies sixteen hours, a day nobody can drive, because it counts the journey home and back out again between every target. And the top-priority target is stop one of four: priority and driving order are different questions. The target that does not fit is named and carried forward, not silently dropped." |
| 1:38–1:58 | Click **Generate patrol order**. Let the PDF render in-browser. Scroll to one task card. | "One click and it is a field order. GPS in decimal and DMS, road distance and drive time, the reason this target was chosen, and checkboxes for what the crew actually found. Every order states that thermal detections are not proof of illegality — this is decision support, not a verdict." |
| 1:58–2:12 | Back to the app. Switch area with the picker to Upper Xingu. Let it load. | "It is not one hardcoded valley. Same pipeline, different continent — the Upper Xingu in Brazil, a road-gridded frontier pushing into forest. Adding an area is a bounding box and a script, not a code change." |
| 2:12–2:30 | Rest on the ranked queue. | "Deforestation alerting is solved. Deciding which alert to drive to first is not, and that is exactly where alerts stop turning into patrols and trees keep falling. Rangefinder adds no new data. It turns the data that already exists into a day's work a ranger can defend afterwards. A heatmap hides the small illegal fire behind the big legal one. Rangefinder does not." |

### If you need to cut to 2:00

Drop the area-switch beat (1:58–2:12) and tighten the forest-factor beat to one
sentence. Keep Plan the day whole — it is the part no other submission has.

### Recording notes

- **Let the roads finish loading before you hit record.** The road network is a
  5.9 MB GeoJSON and takes 10–15 seconds; until it lands the map is bare and the
  opening shot looks empty. Open `?aoi=kalimantan-sebangau`, count to twenty,
  then record.
- Deep-link straight to the area — `rangefinder-cyan.vercel.app/?aoi=kalimantan-sebangau`
  — rather than loading the default and switching on camera.
- **Plan the day takes about ten seconds.** Do not cut it out. It is routing
  every pair of targets across a real road graph, and letting it run is more
  convincing than a jump cut.
- Hide the bookmarks bar (Ctrl+Shift+B) and record the full window at 1080p or
  better; the sidebar type is small.
- The patrol order opens in a new tab. Have that tab closed beforehand so the
  render is visible from the first frame.
- Sanity-check page 2 of the PDF before recording — the tasked targets continue
  there, along with the "considered but not tasked" list.
