"use client";

import { useEffect, useRef, useState } from "react";
// maplibre-gl v6 is ESM-only and exposes named exports — there is no default
// export to import.
import {
  Map as MlMap,
  Marker,
  NavigationControl,
  ScaleControl,
} from "maplibre-gl";

import type { ProtectedArea, RangerPost, ScoredTarget } from "@/lib/types";

interface Props {
  targets: ScoredTarget[];
  post: RangerPost;
  protectedAreas: ProtectedArea[];
  /** Highlighted in the list and on the map. */
  selectedId: string | null;
  /** Camera target. Set only by an explicit user action, never by the initial
   *  auto-selection — otherwise the opening frame is a zoom-10 rectangle of
   *  unbroken rainforest, which on a dark basemap is just black. */
  focusId: string | null;
  /** Area of operations, supplied by the API. Previously a second hardcoded
   *  copy of the AOI lived here and had to be kept in step with lib/config.ts
   *  by hand — which is exactly the kind of duplication that silently rots. */
  bounds: { south: number; west: number; north: number; east: number };
  onSelect: (id: string) => void;
}

/**
 * A self-contained style. No external basemap.
 *
 * This started as CARTO's hosted dark-matter style, which was a mistake.
 * MapLibre will not paint *any* layer until the entire style resolves, so a
 * slow basemap tile server holds the operational data hostage: on a poor link
 * the fire detections, road network and park boundary all sat invisible behind
 * a basemap that was still negotiating. Measured on the build machine, a single
 * CARTO vector tile took 2.3 s.
 *
 * The AOI is remote rainforest, where a dark basemap contributes almost no
 * detail anyway — the OSM road network we already load *is* the meaningful
 * geography, and it is the exact substrate the access score is computed
 * against. Rendering from a background colour and our own data makes the map
 * instant, deterministic, and dependent on nothing that can fail during a demo.
 *
 * Note: no `glyphs` URL is declared, so this style cannot carry symbol/text
 * layers. Labelling is done with DOM markers instead.
 */
const STYLE = {
  version: 8 as const,
  sources: {},
  layers: [
    {
      id: "bg",
      type: "background" as const,
      paint: { "background-color": "#0b1210" },
    },
  ],
};

const colourFor = (score: number) =>
  score >= 60 ? "#ef4444" : score >= 50 ? "#f97316" : score >= 40 ? "#eab308" : "#84cc16";

export default function MapView({
  targets,
  post,
  protectedAreas,
  selectedId,
  focusId,
  bounds,
  onSelect,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);

  // Keep the latest handler in a ref so marker listeners never close over a
  // stale callback when the parent re-renders. Assigned in an effect rather
  // than during render — mutating a ref while rendering is not safe under
  // concurrent rendering, and React's lint rules reject it.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const hasFocused = useRef(false);

  // The map is constructed once, but the resize handler re-fits to the AOI on
  // every container change. Reading the bounds through a ref keeps the init
  // effect genuinely one-shot while still using the current area.
  const boundsRef = useRef(bounds);
  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  // ---------------------------------------------------------------- init once
  useEffect(() => {
    if (!container.current || map.current) return;

    const m = new MlMap({
      container: container.current,
      style: STYLE,
      // Framed by bounds rather than a guessed centre/zoom. Passing these to the
      // constructor matters: calling fitBounds() straight after construction
      // measures a container that has not been laid out yet and silently
      // produces the wrong frame.
      // Initial frame only; subsequent AOI changes are handled by the resize
      // observer below via boundsRef.
      bounds: [
        [boundsRef.current.west, boundsRef.current.south],
        [boundsRef.current.east, boundsRef.current.north],
      ],
      fitBoundsOptions: { padding: 56 },
      attributionControl: {
        compact: true,
        // The basemap is gone but the road and boundary geometry is still OSM,
        // and ODbL requires the credit regardless of how it is rendered.
        customAttribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · NASA FIRMS',
      },
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    map.current = m;

    // Development-only handle for inspecting layer state from the console.
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __rfMap?: MlMap }).__rfMap = m;
    }

    /**
     * Install our own layers.
     *
     * Deliberately NOT hooked to the map's `load` event. `load` waits for the
     * basemap's initial vector tiles, and on a slow link those take tens of
     * seconds — during which none of the data this application exists to show
     * would be on screen. The operational data must not be hostage to a
     * decorative basemap, so we attach as soon as the style *spec* is parsed
     * and let CARTO's tiles arrive whenever they arrive.
     *
     * Idempotent: `styledata` fires repeatedly as tiles stream in.
     */
    const installLayers = () => {
      // Guard on the thing we actually care about — whether our source is
      // already installed. An earlier version also guarded on `m.style`, which
      // is undefined until the spec parses and so short-circuited every call.
      if (m.getSource("roads")) return;

      // Road network — the substrate of the access score. Drawing it is not
      // decoration: it is why a small fire beside a track can outrank a large
      // one 4 km into the bush, and the ranger can see the reason rather than
      // taking the number on faith.
      m.addSource("roads", { type: "geojson", data: "/roads.geojson" });
      m.addLayer({
        id: "roads-line",
        type: "line",
        source: "roads",
        paint: {
          "line-color": "#5eead4",
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.35, 11, 0.6],
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.7, 12, 1.8],
        },
      });

      // Every individual VIIRS pixel. This is the firehose the tool exists to
      // reduce — showing it makes the reduction visible rather than asserted.
      m.addSource("detections", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      m.addLayer({
        id: "detections-dot",
        type: "circle",
        source: "detections",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2, 12, 5],
          "circle-color": "#fb923c",
          "circle-opacity": 0.65,
          "circle-blur": 0.3,
        },
      });

      setReady(true);
    };

    // `style.load` fires when the style *spec* has parsed, independent of
    // whether any basemap tile has arrived. `styledata` is kept as a backstop
    // because it fires repeatedly as the style settles; installLayers is
    // idempotent so the duplication is harmless.
    m.on("style.load", installLayers);
    m.on("styledata", installLayers);

    // The map is behind a dynamic import inside a flex column, so it frequently
    // initialises against a container that has not reached its final height.
    // MapLibre caches those dimensions and never notices, which leaves the
    // camera framed for a viewport that no longer exists.
    const ro = new ResizeObserver(() => {
      m.resize();
      // Once the user has picked a target, a resize must not yank the camera
      // back to the overview.
      if (hasFocused.current) return;
      const b = boundsRef.current;
      m.fitBounds(
        [
          [b.west, b.south],
          [b.east, b.north],
        ],
        { padding: 56, animate: false }
      );
    });
    ro.observe(container.current);

    return () => {
      ro.disconnect();
      m.off("style.load", installLayers);
      m.off("styledata", installLayers);
      m.remove();
      map.current = null;
      setReady(false);
    };
  }, []);

  // ----------------------------------------------------- protected-area layer
  // Added in its own effect rather than alongside the others: the boundary
  // geometry is fetched separately and usually lands after the style is ready,
  // so a one-shot setup silently drew nothing.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !protectedAreas.length || m.getSource("pa")) return;

    m.addSource("pa", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: protectedAreas.map((a) => ({
          type: "Feature" as const,
          properties: { name: a.name },
          geometry: { type: "Polygon" as const, coordinates: a.rings },
        })),
      },
    });
    m.addLayer({
      id: "pa-fill",
      type: "fill",
      source: "pa",
      paint: { "fill-color": "#4ade80", "fill-opacity": 0.09 },
    });
    m.addLayer({
      id: "pa-line",
      type: "line",
      source: "pa",
      paint: {
        "line-color": "#4ade80",
        "line-width": 1.6,
        "line-dasharray": [3, 2],
        "line-opacity": 0.85,
      },
    });
  }, [protectedAreas, ready]);

  // ------------------------------------------------------ raw detection layer
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource("detections");
    if (!src || !("setData" in src)) return;

    (src as { setData: (d: unknown) => void }).setData({
      type: "FeatureCollection",
      features: targets.flatMap((t) =>
        t.alerts.map((a) => ({
          type: "Feature" as const,
          properties: {},
          geometry: { type: "Point" as const, coordinates: [a.lon, a.lat] },
        }))
      ),
    });
  }, [targets, ready]);

  // ------------------------------------------------------------------ markers
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    markers.current.forEach((mk) => mk.remove());
    markers.current = [];

    const postEl = document.createElement("div");
    postEl.style.cssText =
      "width:13px;height:13px;border-radius:3px;background:#e8f0ed;border:2px solid #0a0f0d;box-shadow:0 0 0 1.5px #e8f0ed";
    postEl.title = `Origin station — ${post.name}`;
    markers.current.push(
      new Marker({ element: postEl }).setLngLat([post.lon, post.lat]).addTo(m)
    );

    targets.forEach((t, i) => {
      const el = document.createElement("div");
      const size = Math.max(14, Math.min(30, 11 + Math.sqrt(t.count) * 1.7));
      const colour = colourFor(t.score);
      const isSel = t.id === selectedId;

      el.style.cssText = `position:relative;width:${size}px;height:${size}px;cursor:pointer`;
      el.innerHTML = `
        ${i === 0 ? `<span class="ping" style="position:absolute;inset:0;border-radius:50%;background:${colour}"></span>` : ""}
        <span style="position:absolute;inset:0;border-radius:50%;background:${colour};
              opacity:${isSel ? 1 : 0.85};
              border:${isSel ? "2.5px solid #e8f0ed" : "1.5px solid rgba(10,15,13,.85)"};
              display:flex;align-items:center;justify-content:center;
              font-size:9px;font-weight:700;color:#06120c">${i + 1}</span>`;
      el.title = `#${i + 1} · ${t.count} detections · actionability ${t.score.toFixed(1)}`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onSelectRef.current(t.id);
      });

      markers.current.push(
        new Marker({ element: el }).setLngLat([t.lon, t.lat]).addTo(m)
      );
    });
  }, [targets, post, selectedId]);

  // -------------------------------------------------------------- route layer
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource("route");
    if (!src || !("setData" in src)) return;
    const set = (features: unknown[]) =>
      (src as { setData: (d: unknown) => void }).setData({
        type: "FeatureCollection",
        features,
      });

    const t = focusId ? targets.find((x) => x.id === focusId) : null;
    if (!t) {
      set([]);
      return;
    }

    let cancelled = false;
    fetch(`/api/route-to?lat=${t.lat}&lon=${t.lon}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (!d?.routed || !d.geometry?.length) {
          set([]);
          return;
        }
        const coords = d.geometry as [number, number][];
        set([
          {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: coords },
          },
        ]);

        // Frame the whole journey. Zooming to the target alone leaves a 200 km
        // route almost entirely off-screen, which hides the single most useful
        // thing the routing tells a ranger: how far this actually is.
        let minLon = coords[0][0], maxLon = coords[0][0];
        let minLat = coords[0][1], maxLat = coords[0][1];
        for (const [lo, la] of coords) {
          if (lo < minLon) minLon = lo;
          if (lo > maxLon) maxLon = lo;
          if (la < minLat) minLat = la;
          if (la > maxLat) maxLat = la;
        }
        m.fitBounds(
          [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
          { padding: 70, duration: 900 }
        );
      })
      .catch(() => {
        if (!cancelled) set([]);
      });

    return () => {
      cancelled = true;
    };
  }, [focusId, targets, ready]);

  // ------------------------------------------------------------- fly on focus
  useEffect(() => {
    const m = map.current;
    if (!m || !focusId) return;
    hasFocused.current = true;
    const t = targets.find((x) => x.id === focusId);
    if (!t) return;
    // A routable target is framed by the route effect above once the polyline
    // arrives; only fly directly for targets with no road route.
    if (t.routed) return;
    m.flyTo({ center: [t.lon, t.lat], zoom: 9.5, duration: 900 });
  }, [focusId, targets]);

  // Inline styles, not Tailwind utilities. maplibre-gl.css declares
  // `.maplibregl-map { position: relative }` unlayered, and unlayered CSS beats
  // Tailwind v4's layered utilities in the cascade regardless of import order —
  // so `absolute inset-0` silently lost and the map collapsed to a third of its
  // container's height.
  return <div ref={container} style={{ position: "absolute", inset: 0 }} />;
}
