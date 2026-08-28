#!/usr/bin/env python3
"""
Add a new area of operations to Rangefinder.

Everything the application knows about a place lives in `data/aoi/<slug>/`.
This script builds that folder from open data, so putting the tool to work
somewhere new is a data task rather than a code change: run this, restart, and
the area appears in the picker.

    python scripts/setup_aoi.py \
        --slug congo-salonga \
        --label "Salonga North" \
        --subtitle "Democratic Republic of the Congo" \
        --south -2.6 --west 20.2 --north -1.2 --east 21.6 \
        --region africa

Add --dry-run to see exactly what it would fetch and write, without touching
anything.

Sources, all open and keyless:
  NASA FIRMS      active fire detections      (public domain, attribution asked)
  OpenStreetMap   roads and protected areas   (ODbL 1.0)
  ESA WorldCover  baseline tree cover         (CC BY 4.0)
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# The main instance regularly answers "the server is probably too busy" with an
# HTML error page. Try mirrors in turn rather than failing the whole build.
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Mirrors FIRMS_SOURCES in lib/sources/firms.ts. Keep the two in step.
_CSV = ("https://firms.modaps.eosdis.nasa.gov/data/active_fire/"
        "noaa-20-viirs-c2/csv/J1_VIIRS_C2_{}_24h.csv")

# Verified against the live endpoint. There is no "Africa" or "North_America"
# file; guessing those names returns 404. Keep in step with FIRMS_SOURCES in
# lib/sources/firms.ts.
FIRMS = {
    "south_america": _CSV.format("South_America"),
    "northern_and_central_africa": _CSV.format("Northern_and_Central_Africa"),
    "southern_africa": _CSV.format("Southern_Africa"),
    "south_asia": _CSV.format("South_Asia"),
    "southeast_asia": _CSV.format("SouthEast_Asia"),
    "europe": _CSV.format("Europe"),
    "russia_asia": _CSV.format("Russia_Asia"),
    "global": _CSV.format("Global"),
}

# Classes a vehicle can actually use. Footpaths are excluded deliberately: the
# access score and the routing both mean "can a truck get there".
NAVIGABLE = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential|track|"
    "service|road|living_street|motorway_link|trunk_link|primary_link|"
    "secondary_link|tertiary_link"
)

UA = "Rangefinder/1.0 (open-data conservation tool; student project)"

# Routing needs road network beyond the AOI, because the nearest town — and so
# the ranger post — is frequently outside it. Without this pad, routing fails
# for every target in the area.
PAD_DEG = 0.5


# --------------------------------------------------------------------------- io

def http_get(url: str, timeout: int = 300) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def overpass(query: str, timeout: int = 600, attempts: int = 3) -> dict:
    """POST to Overpass with the retries and headers it insists on.

    Overpass returns 406 without an explicit Accept header, rate-limits with 429,
    and answers bad syntax with an HTML page rather than JSON — so check the
    payload actually starts with '{' before trusting it.
    """
    body = urllib.parse.urlencode({"data": query}).encode()
    endpoints = OVERPASS_ENDPOINTS * attempts
    for attempt, endpoint in enumerate(endpoints, 1):
        try:
            req = urllib.request.Request(
                endpoint,
                data=body,
                headers={
                    "User-Agent": UA,
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode("utf-8", "replace")
            if not raw.lstrip().startswith("{"):
                raise ValueError(f"Overpass returned non-JSON: {raw[:300]}")
            return json.loads(raw)
        except (urllib.error.HTTPError, urllib.error.URLError, ValueError, TimeoutError) as e:
            code = getattr(e, "code", None)
            if attempt == len(endpoints):
                raise
            wait = 20 if code in (429, 504) else 5
            host = urllib.parse.urlparse(endpoint).netloc
            print(f"    {host} failed ({str(e)[:80]}); trying next mirror in {wait}s")
            time.sleep(wait)
    raise RuntimeError("unreachable")


def meta_block(source: str, licence: str, aoi: dict) -> dict:
    return {
        "source": source,
        "licence": licence,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "aoi": aoi,
    }


def write_json(path: str, obj, dry: bool) -> None:
    if dry:
        print(f"    would write {path}")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"    wrote {path}  ({os.path.getsize(path) / 1024:.0f} KB)")


# ------------------------------------------------------------------- geometry

def haversine_m(a_lat, a_lon, b_lat, b_lon) -> float:
    R = 6371000.0
    p = math.radians
    h = (
        math.sin(p(b_lat - a_lat) / 2) ** 2
        + math.cos(p(a_lat)) * math.cos(p(b_lat)) * math.sin(p(b_lon - a_lon) / 2) ** 2
    )
    return 2 * R * math.asin(math.sqrt(h))


def perp(pt, a, b) -> float:
    (px, py), (ax, ay), (bx, by) = pt, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(ax + t * dx - px, ay + t * dy - py)


def simplify(points, tol):
    """Douglas-Peucker. Used only for the browser copy of the road network."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        dmax, idx = 0.0, i
        for k in range(i + 1, j):
            d = perp(points[k], points[i], points[j])
            if d > dmax:
                dmax, idx = d, k
        if dmax > tol:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(points, keep) if k]


def stitch_rings(members):
    """Join a relation's `outer` ways into closed rings.

    A ring that will not close is dropped rather than emitted half-formed. A
    broken boundary would silently mislabel land tenure, and telling a ranger
    that legal ground is protected — or the reverse — is worse than saying
    nothing.
    """
    segs = [
        [(p["lon"], p["lat"]) for p in m["geometry"]]
        for m in members
        if m.get("role") == "outer" and m.get("geometry")
    ]
    rings, used = [], [False] * len(segs)
    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        ring = list(segs[i])
        changed = True
        while changed and ring[0] != ring[-1]:
            changed = False
            for j in range(len(segs)):
                if used[j]:
                    continue
                s = segs[j]
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                used[j] = True
                changed = True
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


# ---------------------------------------------------------------------- steps

def fetch_alerts(bbox, region, dry):
    url = FIRMS[region]
    print(f"  [1/6] FIRMS {region}")
    print(f"    GET {url}")
    if dry:
        return []
    rows = list(csv.DictReader(io.StringIO(http_get(url).decode("utf8", "replace"))))

    def conf(v):
        v = (v or "").strip().lower()
        return "high" if v in ("h", "high") else "low" if v in ("l", "low") else "nominal"

    out = []
    for r in rows:
        try:
            la, lo = float(r["latitude"]), float(r["longitude"])
        except (TypeError, ValueError):
            continue
        if not (bbox["south"] <= la <= bbox["north"] and bbox["west"] <= lo <= bbox["east"]):
            continue
        out.append(
            {
                "lat": la,
                "lon": lo,
                "acqDate": r.get("acq_date", ""),
                "acqTime": r.get("acq_time", ""),
                "confidence": conf(r.get("confidence")),
                "frp": float(r.get("frp") or 0),
                "dayNight": "N" if (r.get("daynight") or "D").strip() == "N" else "D",
            }
        )
    print(f"    {len(rows)} regional detections -> {len(out)} inside the area")
    return out


def fetch_roads(pad, dry):
    q = (
        f'[out:json][timeout:600];way["highway"~"^({NAVIGABLE})$"]'
        f'({pad["south"]},{pad["west"]},{pad["north"]},{pad["east"]});out geom;'
    )
    print("  [2/6] OpenStreetMap roads (padded box, navigable classes)")
    print(f"    POST {OVERPASS}")
    if dry:
        return []
    d = overpass(q)
    roads = []
    for e in d.get("elements", []):
        g = e.get("geometry")
        if not g or len(g) < 2:
            continue
        roads.append(
            {
                "highway": (e.get("tags") or {}).get("highway", "unclassified"),
                "coords": [[round(p["lon"], 6), round(p["lat"], 6)] for p in g],
            }
        )
    print(f"    {len(roads)} ways, {sum(len(r['coords']) for r in roads)} nodes")
    return roads


def fetch_protected(bbox, dry):
    # Conservation areas are tagged inconsistently in OSM and may be either a
    # relation or a single closed way. An earlier version asked only for
    # relations tagged boundary=protected_area, which silently missed Taman
    # Nasional Sebangau - a 5,300 km2 national park mapped as a *way* tagged
    # boundary=national_park. The area then reported no protected land at all,
    # which for an enforcement tool is the most damaging way to be wrong.
    b = f'{bbox["south"]},{bbox["west"]},{bbox["north"]},{bbox["east"]}'
    selectors = [
        '["boundary"="protected_area"]',
        '["boundary"="national_park"]',
        '["boundary"="aboriginal_lands"]',
        '["leisure"="nature_reserve"]',
    ]
    parts = "".join(
        f"relation{sel}({b});way{sel}({b});" for sel in selectors
    )
    q = f"[out:json][timeout:300];({parts});out tags;"
    print("  [3/6] OpenStreetMap protected areas")
    print(f"    POST {OVERPASS}")
    if dry:
        return []
    found = overpass(q).get("elements", [])
    print(f"    {len(found)} candidate features (relations and ways)")

    areas = []
    for rel in found:
        tags = rel.get("tags") or {}
        name = tags.get("name") or tags.get("name:en")
        if not name:
            continue
        time.sleep(2)  # be polite between geometry fetches
        kind = rel["type"]  # "relation" or "way"
        try:
            g = overpass(f"[out:json][timeout:300];{kind}({rel['id']});out geom;")
        except Exception as e:
            print(f"    ! geometry fetch failed for {name}: {e}")
            continue
        els = g.get("elements") or []
        if not els:
            continue

        if kind == "way":
            # A closed way is already a ring; nothing to stitch.
            geom = els[0].get("geometry") or []
            pts = [(p["lon"], p["lat"]) for p in geom]
            if len(pts) >= 4 and pts[0] == pts[-1]:
                rings = [pts]
            elif len(pts) >= 4:
                rings = [pts + [pts[0]]]  # close it explicitly
            else:
                rings = []
        else:
            rings = stitch_rings(els[0].get("members") or [])
        if not rings:
            print(f"    ! {name}: rings would not close, skipped")
            continue
        areas.append(
            {
                "name": name,
                "nameEn": tags.get("name:en"),
                "designation": tags.get("protection_title") or tags.get("boundary"),
                "operator": tags.get("operator"),
                "rings": rings,
                "_source": f"OpenStreetMap relation {rel['id']} via Overpass API",
                "_licence": "ODbL 1.0 (c) OpenStreetMap contributors",
            }
        )
        print(f"    + {name} ({sum(len(r) for r in rings)} boundary nodes)")
    return areas


def fetch_post(pad, bbox, dry):
    q = (
        f'[out:json][timeout:300];node["place"~"^(town|city|village)$"]'
        f'({pad["south"]},{pad["west"]},{pad["north"]},{pad["east"]});out body;'
    )
    print("  [4/6] Nearest settlement for the ranger post")
    print(f"    POST {OVERPASS}")
    if dry:
        return None
    nodes = overpass(q).get("elements", [])
    if not nodes:
        print("    ! no settlement found; falling back to the area centre")
        return {
            "name": "Field station (unnamed)",
            "lat": (bbox["south"] + bbox["north"]) / 2,
            "lon": (bbox["west"] + bbox["east"]) / 2,
        }

    clat = (bbox["south"] + bbox["north"]) / 2
    clon = (bbox["west"] + bbox["east"]) / 2

    def pop(n):
        try:
            return int((n.get("tags") or {}).get("population", "0"))
        except ValueError:
            return 0

    ranked = sorted(nodes, key=lambda n: (-pop(n), haversine_m(clat, clon, n["lat"], n["lon"])))
    best = ranked[0]
    name = (best.get("tags") or {}).get("name", "Field station")
    why = f"population {pop(best)}" if pop(best) else "closest named settlement"
    print(f"    chose {name} ({why}), {haversine_m(clat, clon, best['lat'], best['lon'])/1000:.0f} km from centre")
    return {"name": name, "lat": best["lat"], "lon": best["lon"]}


def build_forest(pad, out_path, dry):
    print("  [5/6] ESA WorldCover baseline tree cover")
    script = os.path.join(HERE, "build_forest_grid.py")
    cmd = [
        sys.executable, script,
        "--south", str(pad["south"]), "--west", str(pad["west"]),
        "--north", str(pad["north"]), "--east", str(pad["east"]),
        "--out", out_path,
    ]
    print(f"    {' '.join(cmd)}")
    if dry:
        return
    r = subprocess.run(cmd, capture_output=True, text=True)
    print("    " + (r.stdout or r.stderr).strip().replace("\n", "\n    ")[:900])
    if r.returncode != 0:
        print("    ! forest grid failed — targets will score with an unknown baseline")


# ----------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slug", required=True, help="folder name, e.g. congo-salonga")
    ap.add_argument("--label", required=True, help='display name, e.g. "Salonga North"')
    ap.add_argument("--subtitle", default="", help='country line, e.g. "DR Congo"')
    ap.add_argument("--south", type=float, required=True)
    ap.add_argument("--west", type=float, required=True)
    ap.add_argument("--north", type=float, required=True)
    ap.add_argument("--east", type=float, required=True)
    ap.add_argument("--region", required=True, choices=sorted(FIRMS))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if a.south >= a.north or a.west >= a.east:
        print("error: south must be < north and west must be < east", file=sys.stderr)
        return 2

    bbox = {"south": a.south, "west": a.west, "north": a.north, "east": a.east}
    pad = {
        "south": a.south - PAD_DEG, "west": a.west - PAD_DEG,
        "north": a.north + PAD_DEG, "east": a.east + PAD_DEG,
    }
    ddir = os.path.join(ROOT, "data", "aoi", a.slug)
    pdir = os.path.join(ROOT, "public", "aoi", a.slug)

    print(f"\nArea '{a.slug}' — {a.label}")
    print(f"  bbox {bbox}   routing/forest padded by {PAD_DEG}deg")
    if a.dry_run:
        print("  DRY RUN — nothing will be written\n")

    osm_lic = "ODbL 1.0 (c) OpenStreetMap contributors"

    alerts = fetch_alerts(bbox, a.region, a.dry_run)
    write_json(os.path.join(ddir, "alerts.json"), alerts, a.dry_run)

    roads = fetch_roads(pad, a.dry_run)
    write_json(os.path.join(ddir, "roads.json"), roads, a.dry_run)

    # A simplified copy for the browser. The full-resolution file above stays
    # authoritative for routing and the access score.
    print("  [6/6] Simplified road geometry for the map")
    if not a.dry_run:
        feats = []
        for r in roads:
            pts = simplify([tuple(c) for c in r["coords"]], 0.0004)
            if len(pts) >= 2:
                feats.append({
                    "type": "Feature", "properties": {},
                    "geometry": {"type": "LineString",
                                 "coordinates": [[round(x, 4), round(y, 4)] for x, y in pts]},
                })
        before = sum(len(r["coords"]) for r in roads)
        after = sum(len(f["geometry"]["coordinates"]) for f in feats)
        if before:
            print(f"    {before} -> {after} nodes ({100 * (1 - after / before):.0f}% fewer)")
        write_json(os.path.join(pdir, "roads.geojson"),
                   {"type": "FeatureCollection", "features": feats}, a.dry_run)
    else:
        print(f"    would write {os.path.join(pdir, 'roads.geojson')}")

    areas = fetch_protected(bbox, a.dry_run)
    write_json(os.path.join(ddir, "protected-areas.json"), areas, a.dry_run)
    if not a.dry_run and not areas:
        print("    ! no protected areas found — every target will read 'Unclassified tenure'")

    post = fetch_post(pad, bbox, a.dry_run)
    build_forest(pad, os.path.join(ddir, "forest-grid.json"), a.dry_run)

    meta = {
        "slug": a.slug,
        "label": a.label,
        "subtitle": a.subtitle,
        "bbox": bbox,
        "region": a.region,
        "post": post,
        "hasImagery": False,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "_meta": meta_block(
            "NASA FIRMS; OpenStreetMap via Overpass; ESA WorldCover",
            f"NASA open data; {osm_lic}; CC BY 4.0",
            bbox,
        ),
    }
    if a.dry_run:
        print(f"    would write {os.path.join(ddir, 'meta.json')}")
    else:
        os.makedirs(ddir, exist_ok=True)
        with io.open(os.path.join(ddir, "meta.json"), "w", encoding="utf8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        print(f"    wrote {os.path.join(ddir, 'meta.json')}")

    print(f"\nDone. Restart the dev server and '{a.label}' appears in the area picker.")
    print("No code change is needed — areas are discovered from data/aoi/.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
