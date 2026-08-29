"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import type { ProtectedArea, RangerPost, ScoredTarget } from "@/lib/types";
import { SEVERITY, markerColour, severityLabel } from "@/lib/marker";

// MapLibre touches `window` at module scope, so it can only load client-side.
const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center text-[var(--dim)] text-sm">Loading terrain…</div>,
});

interface TourPlan {
  sequence: string[];
  legs: {
    fromTargetId: string | null;
    toTargetId: string | null;
    km: number;
    hours: number;
    geometry: [number, number][];
  }[];
  totalKm: number;
  drivingHours: number;
  totalHours: number;
  litres: number;
  fitsWorkingDay: boolean;
  excluded: { id: string; reason: string }[];
  naiveRoundTripHours: number;
}

interface AoiOption {
  slug: string;
  label: string;
  subtitle?: string;
}

interface Payload {
  aoi: {
    label: string;
    subtitle?: string;
    slug: string;
    south: number;
    west: number;
    north: number;
    east: number;
  };
  available: AoiOption[];
  post: RangerPost;
  live: boolean;
  note?: string;
  counts: { detections: number; events: number; roadSegments: number; protectedAreas: number };
  generatedAt: string;
  targets: ScoredTarget[];
  weather: { cloudCoverPct: number; observationLimited: boolean } | null;
  weatherNote: string | null;
}

const FACTORS: { key: keyof ScoredTarget["breakdown"]; label: string }[] = [
  { key: "extent", label: "Extent" },
  { key: "forest", label: "Forest" },
  { key: "protection", label: "Protection" },
  { key: "recency", label: "Recency" },
  { key: "access", label: "Access" },
  { key: "confidence", label: "Confidence" },
  { key: "proximity", label: "Proximity" },
];

interface Verification {
  point: { lat: number; lon: number };
  ndvi_available: boolean;
  before: { scene_date: string; cloud_cover_pct: number; mean_ndvi: number };
  after: { scene_date: string; cloud_cover_pct: number; mean_ndvi: number };
  ndvi_delta_after_minus_before: number;
  corrected_delta?: number;
  smoke_like_pixel_fraction_after?: number;
  control?: {
    lat: number;
    lon: number;
    delta: number;
    distance_from_target_km: number;
    worldcover_tree_pct: number;
  };
}

/** The imagery was computed for one point. Only offer it to a target that
 *  actually sits there — roughly 5 km. */
const MATCH_DEG = 0.05;

// Single source of truth, shared with the map markers — see lib/marker.ts for
// why this palette was chosen over the original red-to-green ramp.
const scoreColour = markerColour;

export default function Home() {
  // Which area of operations we are looking at. Everything else — targets,
  // boundaries, imagery, the road graph — is derived from this.
  const [aoi, setAoi] = useState<string | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [areas, setAreas] = useState<ProtectedArea[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Distinct from `selected`: the list opens the top target on load for
  // legibility, but the camera must not move until a human asks it to.
  const [focus, setFocus] = useState<string | null>(null);
  const [verif, setVerif] = useState<Verification | null>(null);
  // The planned day. Fetched on demand: sequencing needs a road route between
  // every pair of tasked targets, so it is far dearer than the queue itself.
  const [tour, setTour] = useState<TourPlan | null>(null);
  const [tourGeometry, setTourGeometry] = useState<[number, number][][] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = aoi ? `?aoi=${encodeURIComponent(aoi)}` : "";
    let cancelled = false;

    fetch(`/api/targets${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((d: Payload) => {
        if (cancelled) return;
        setData(d);
        setSelected(d.targets[0]?.id ?? null);
        setFocus(null);
        setError(null);
        setTour(null);
        setTourGeometry(null);
        if (!aoi) setAoi(d.aoi.slug);
      })
      .catch((e) => !cancelled && setError(String(e)));

    fetch(`/api/protected-areas${q}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((a) => !cancelled && setAreas(a))
      .catch(() => !cancelled && setAreas([]));

    fetch(`/api/verification${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => !cancelled && setVerif(v))
      .catch(() => !cancelled && setVerif(null));

    return () => {
      cancelled = true;
    };
  }, [aoi]);

  // While a switch is in flight the previous area's payload is still in state.
  // Treating it as stale at render — rather than clearing it in an effect —
  // keeps the old targets from being drawn against the new area's map without
  // setting state during the effect body.
  const stale = data !== null && aoi !== null && data.aoi.slug !== aoi;
  const shown = stale ? null : data;

  const top = useMemo(() => shown?.targets.slice(0, 12) ?? [], [shown]);

  // Selection can originate on the map, where clicking a marker expanded a row
  // that might be anywhere in the scrolled list — so the sidebar appeared not
  // to respond at all. The same fault as the pulse being pinned to rank 1:
  // state reflected in one place and not the other.
  useEffect(() => {
    if (!selected) return;
    const row = document.querySelector(`[data-target-id="${CSS.escape(selected)}"]`);
    // `nearest` leaves an already-visible row where it is, so choosing from the
    // list itself does not cause the panel to jump.
    row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selected]);

  return (
    <main className="flex h-screen flex-col overflow-hidden">
      {/* ---------- header ---------- */}
      <header className="flex shrink-0 items-center gap-5 border-b border-[var(--line)] bg-[var(--panel)] px-5 py-3">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-[var(--accent-dim)] text-sm">
            <span aria-hidden>◎</span>
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-tight">Rangefinder</div>
            <div className="kicker">Deforestation alert triage</div>
          </div>
        </div>

        <div className="hidden h-8 w-px bg-[var(--line)] sm:block" />

        <div className="hidden min-w-0 sm:block">
          <label className="kicker" htmlFor="aoi-select">
            Area of operations
          </label>
          {shown && shown.available.length > 1 ? (
            <select
              id="aoi-select"
              value={shown.aoi.slug}
              onChange={(e) => setAoi(e.target.value)}
              className="block w-full cursor-pointer truncate rounded border border-[var(--line)] bg-[var(--panel-2)] px-2 py-1 text-[13px] font-medium text-[var(--text)] outline-none focus:border-[var(--accent-dim)]"
            >
              {shown.available.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.label}
                  {a.subtitle ? ` — ${a.subtitle}` : ""}
                </option>
              ))}
            </select>
          ) : (
            <div className="truncate text-[13px] font-medium">
              {shown ? `${shown.aoi.label}${shown.aoi.subtitle ? ` — ${shown.aoi.subtitle}` : ""}` : "—"}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-5">
          {shown && (
            <>
              <Stat value={shown.counts.detections.toLocaleString()} label="detections / 24h" />
              <Stat value={String(shown.counts.events)} label="clearing events" />
              <div
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium"
                style={{
                  borderColor: shown.live ? "var(--accent-dim)" : "var(--line)",
                  color: shown.live ? "var(--accent)" : "var(--muted)",
                }}
                title={shown.note ?? "Fetched from NASA FIRMS moments ago"}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: shown.live ? "var(--accent)" : "var(--dim)" }}
                />
                {shown.live ? "LIVE" : "CACHED"}
              </div>
            </>
          )}

          <button
            onClick={async () => {
              if (!shown) return;
              if (tour) {
                // Toggling off clears the loop but leaves the queue untouched.
                setTour(null);
                setTourGeometry(null);
                return;
              }
              setPlanning(true);
              try {
                const p = await fetch(
                  `/api/patrol-plan?aoi=${encodeURIComponent(shown.aoi.slug)}`
                ).then((r) => (r.ok ? r.json() : null));
                if (!p?.tour) {
                  setError("Could not plan a patrol for this area.");
                  return;
                }
                setTour(p.tour);
                // The server already routed every leg while costing the loop,
                // so the polylines arrive with the plan. An earlier version
                // re-fetched each leg from the browser, which meant the drawn
                // route depended on a fan of extra requests that could partly
                // fail and leave the map blank with no indication why.
                setTourGeometry(
                  (p.tour.legs ?? [])
                    .map((l: { geometry: [number, number][] }) => l.geometry)
                    .filter((g: [number, number][]) => g && g.length > 1)
                );
              } catch (e) {
                setError(`Could not plan a patrol: ${String(e)}`);
              } finally {
                setPlanning(false);
              }
            }}
            disabled={!shown || planning}
            className="rounded-md border border-[var(--line)] px-3 py-2 text-[13px] font-medium text-[var(--text)] transition hover:bg-[var(--panel-2)] disabled:opacity-50"
          >
            {planning ? "Planning…" : tour ? "Hide the day" : "Plan the day"}
          </button>

          <a
            href={shown ? `/api/patrol-order?aoi=${shown.aoi.slug}` : "/api/patrol-order"}
            target="_blank"
            rel="noopener"
            className="rounded-md bg-[var(--accent)] px-3.5 py-2 text-[13px] font-semibold text-[#06120c] transition hover:brightness-110 active:brightness-95"
          >
            Generate patrol order →
          </a>
        </div>
      </header>

      {/* ---------- body ---------- */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative min-h-[38vh] flex-1 lg:min-h-0">
          {shown && (
            <MapView
              key={shown.aoi.slug}
              targets={top}
              post={shown.post}
              protectedAreas={areas}
              selectedId={selected}
              focusId={focus}
              bounds={shown.aoi}
              aoiSlug={shown.aoi.slug}
              tourGeometry={tourGeometry}
              onSelect={(id) => {
                setSelected(id);
                setFocus(id);
              }}
            />
          )}
          <Legend />
        </section>

        <aside className="flex w-full shrink-0 flex-col border-t border-[var(--line)] bg-[var(--panel)] lg:w-[430px] lg:border-l lg:border-t-0">
          <div className="flex items-baseline justify-between border-b border-[var(--line-soft)] px-4 py-3">
            <h2 className="text-[13px] font-semibold">Patrol queue</h2>
            <span className="kicker">ranked by actionability</span>
          </div>

          {tour && (
            <div className="border-b border-[var(--line-soft)] bg-[var(--panel-2)] px-4 py-3">
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="kicker">Today&apos;s patrol</span>
                <span
                  className="mono text-[11px] font-bold"
                  style={{ color: tour.fitsWorkingDay ? "var(--accent)" : "var(--danger)" }}
                >
                  {tour.totalHours.toFixed(1)} h · {tour.totalKm.toFixed(0)} km · {tour.litres} L
                </span>
              </div>

              {tour.sequence.length > 0 ? (
                <p className="text-[11px] leading-snug text-[var(--muted)]">
                  One loop from <b className="text-[var(--text)]">{shown?.post.name}</b> and back,
                  visiting{" "}
                  <b className="text-[var(--text)]">
                    {tour.sequence.length} target{tour.sequence.length === 1 ? "" : "s"}
                  </b>{" "}
                  in driving order — {tour.drivingHours.toFixed(1)} h driving plus time on site.
                </p>
              ) : (
                <p className="text-[11px] leading-snug text-[var(--danger)]">
                  No drivable loop fits a working day from this post.
                </p>
              )}

              {/* The honest comparison: what the order used to claim. */}
              <p className="mt-1.5 text-[10px] leading-snug text-[var(--dim)]">
                Ranking these as separate return trips would have implied{" "}
                {tour.naiveRoundTripHours.toFixed(1)} h — a figure no crew could drive, because
                it counts the journey home and back out again between every target.
              </p>

              {tour.excluded.length > 0 && (
                <ul className="mt-2 space-y-0.5 border-t border-[var(--line-soft)] pt-1.5">
                  {tour.excluded.map((e) => (
                    <li key={e.id} className="text-[10px] text-[var(--dim)]">
                      Not tasked — {e.reason === "no road route"
                        ? "no vehicle route; air or river access"
                        : "does not fit the driving day; carry forward"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {shown?.weatherNote && (
            <div
              className="border-b px-4 py-2 text-[11px] leading-snug"
              style={{
                borderColor: "var(--line-soft)",
                background: shown.weather?.observationLimited
                  ? "rgba(249,115,22,.08)"
                  : "transparent",
                color: shown.weather?.observationLimited
                  ? "var(--danger)"
                  : "var(--muted)",
              }}
            >
              {shown.weather?.observationLimited ? "⚠ " : ""}
              {shown.weatherNote}
            </div>
          )}

          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
            {error && <p className="p-4 text-sm text-[var(--alarm)]">Failed to load: {error}</p>}
            {!shown && !error && <SkeletonList />}
            {top.map((t, i) => (
              <TargetRow
                key={t.id}
                target={t}
                rank={i + 1}
                open={t.id === selected}
                aoiSlug={shown!.aoi.slug}
                verification={
                  verif &&
                  verif.ndvi_available &&
                  Math.abs(t.lat - verif.point.lat) < MATCH_DEG &&
                  Math.abs(t.lon - verif.point.lon) < MATCH_DEG
                    ? verif
                    : null
                }
                onClick={() => {
                  setSelected(t.id === selected ? null : t.id);
                  setFocus(t.id);
                }}
              />
            ))}
          </div>

          <footer className="shrink-0 border-t border-[var(--line-soft)] px-4 py-2.5 text-[10px] leading-relaxed text-[var(--dim)]">
            NASA FIRMS VIIRS · OpenStreetMap (ODbL) · Copernicus Sentinel-2 via MS Planetary
            Computer. Decision support only — thermal detections are not proof of illegality.
          </footer>
        </aside>
      </div>
    </main>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="hidden text-right md:block">
      <div className="mono text-[15px] font-semibold leading-none">{value}</div>
      <div className="kicker mt-0.5">{label}</div>
    </div>
  );
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border border-[var(--line)] bg-[rgba(10,15,13,.88)] px-3 py-2 text-[10px] text-[var(--muted)] backdrop-blur">
      <div className="kicker mb-1.5">Actionability</div>
      <div className="flex items-center gap-2.5">
        {SEVERITY.map((s) => (
          <span key={s.label} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: s.colour }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1 border-t border-[var(--line-soft)] pt-1.5">
        <span className="h-2 w-2 rounded-[2px] bg-[var(--text)]" /> origin station
        <span className="ml-2 h-0 w-3 border-t border-dashed border-[var(--accent)]" /> protected area
      </div>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-2 p-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-md bg-[var(--panel-2)]" />
      ))}
    </div>
  );
}

function TargetRow({
  target: t,
  rank,
  open,
  aoiSlug,
  verification,
  onClick,
}: {
  target: ScoredTarget;
  rank: number;
  open: boolean;
  aoiSlug: string;
  verification: Verification | null;
  onClick: () => void;
}) {
  const colour = scoreColour(t.score);

  return (
    // A button in behaviour, so it must be one in fact. These were click-only
    // divs, which meant a keyboard or screen-reader user could not open a
    // target or read the justification behind it at all — the same class of
    // exclusion as the colour-only severity scale.
    <div
      data-target-id={t.id}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={`${severityLabel(t.score)} target, rank ${rank}, ${
        t.protectedArea ?? "unclassified tenure"
      }, actionability ${Math.round(t.score)} of 100`}
      className="cursor-pointer border-b border-[var(--line-soft)] px-4 py-3 transition-colors hover:bg-[var(--panel-2)] focus:outline-none focus-visible:bg-[var(--panel-2)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
      style={open ? { background: "var(--panel-2)" } : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        // Space and Enter are what a button responds to; without this the row
        // is focusable but still cannot be activated.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="mono mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded text-[11px] font-bold text-[#06120c]"
          style={{ background: colour }}
        >
          {rank}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold">
              {t.protectedArea ?? "Unclassified tenure"}
            </span>
            <span className="ml-auto flex shrink-0 items-baseline gap-1.5">
              <span
                className="text-[9px] font-bold tracking-wider"
                style={{ color: colour }}
              >
                {severityLabel(t.score)}
              </span>
              {/* Rounded to whole numbers. The decimal implied a precision the
                  weights cannot support; the rank-stability panel below carries
                  the real uncertainty. */}
              <span className="mono text-[13px] font-bold" style={{ color: colour }}>
                {Math.round(t.score)}
              </span>
            </span>
          </div>

          <div className="mono mt-0.5 text-[11px] text-[var(--dim)]">
            {t.lat.toFixed(4)}, {t.lon.toFixed(4)}
          </div>

          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted)]">
            <span>
              <b className="text-[var(--text)]">{t.count}</b> detections
            </span>
            <span>{t.spanKm.toFixed(1)} km front</span>
            <span>{Math.round(t.frpSum)} MW</span>
            <span>
              {t.routed && t.routeKm !== null
                ? `${t.routeKm.toFixed(0)} km road · ${t.driveTimeHours.toFixed(1)} h${
                    t.fuelLitres ? ` · ${t.fuelLitres} L` : ""
                  }`
                : `no road route`}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {t.protectedArea && (
              <span className="rounded border border-[var(--accent-dim)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                INSIDE PROTECTED TERRITORY
              </span>
            )}
            {t.treeCoverPct !== null && (
              <span
                className="rounded border px-1.5 py-0.5 text-[10px] font-medium"
                style={
                  t.treeCoverPct >= 60
                    ? { borderColor: "var(--accent-dim)", color: "var(--accent)" }
                    : { borderColor: "var(--line)", color: "var(--danger)" }
                }
                title="Tree cover at the ESA WorldCover 2021 baseline. Fire on land that was already cleared is probably agricultural."
              >
                {Math.round(t.treeCoverPct)}% FOREST BASELINE
              </span>
            )}
            {t.industrialSource && (
              <span
                className="rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--muted)]"
                title={`Within 1.2 km of ${t.industrialSource} — persistent industrial heat, very probably not a fire.`}
              >
                LIKELY INDUSTRIAL HEAT
              </span>
            )}
            {!t.routed && (
              <span className="rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--danger)]">
                NO VEHICLE ROUTE
              </span>
            )}
          </div>

          {open && (
            <div className="mt-3 space-y-2.5">
              <div className="space-y-1">
                {FACTORS.map((f) => (
                  <div key={f.key} className="flex items-center gap-2">
                    <span className="w-[68px] shrink-0 text-[10px] text-[var(--dim)]">
                      {f.label}
                    </span>
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--line-soft)]">
                      <div
                        className="h-full rounded-full transition-[width] duration-500"
                        style={{
                          width: `${Math.round(t.breakdown[f.key] * 100)}%`,
                          background: colour,
                          opacity: 0.85,
                        }}
                      />
                    </div>
                    <span className="mono w-7 shrink-0 text-right text-[10px] text-[var(--muted)]">
                      {t.breakdown[f.key].toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>

              <ul className="space-y-1 border-t border-[var(--line-soft)] pt-2">
                {t.rationale.map((line, i) => (
                  <li key={i} className="flex gap-1.5 text-[11px] leading-snug text-[var(--muted)]">
                    <span className="text-[var(--accent)]">—</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>

              {t.robustness && <RobustnessBar r={t.robustness} colour={colour} />}

              {verification && <NdviPanel v={verification} aoiSlug={aoiSlug} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Sentinel-2 corroboration for a single target.
 *
 * The first version of this panel reported a raw NDVI drop of -0.0667 between
 * two scenes and called it canopy loss. That was wrong, and the error was
 * instructive: the scenes are eleven months and two calendar months apart, so
 * an unknown share of the drop was simply the seasonal cycle.
 *
 * The fix is a spatial control — undisturbed forest ~20 km away, sampled from
 * the *same two images*, so it shares the season, sun angle, sensor and
 * atmosphere by construction. Whatever the control moved is the baseline.
 * Subtracting it leaves the part attributable to disturbance, and here that is
 * about a quarter of the headline figure.
 *
 * The panel now leads with the corrected number and states the residual
 * confounder plainly, because a judge or a ranger acting on this deserves the
 * honest version rather than the flattering one.
 */
function NdviPanel({ v, aoiSlug }: { v: Verification; aoiSlug: string }) {
  const raw = v.ndvi_delta_after_minus_before;
  const control = v.control?.delta ?? null;
  const corrected = v.corrected_delta ?? null;
  const smoke = v.smoke_like_pixel_fraction_after ?? 0;
  const day = (iso: string) => iso.slice(0, 10);

  const rows: { label: string; value: number; hint: string; dim?: boolean }[] = [
    { label: "Raw drop at target", value: raw, hint: "before → after", dim: true },
  ];
  if (control !== null) {
    rows.push({
      label: "Undisturbed control",
      value: control,
      hint: `${v.control!.distance_from_target_km.toFixed(0)} km away, ${v.control!.worldcover_tree_pct.toFixed(0)}% forest`,
      dim: true,
    });
  }
  if (corrected !== null) {
    rows.push({
      label: "Corrected (target − control)",
      value: corrected,
      hint: "the defensible figure",
    });
  }

  return (
    <div className="mt-3 border-t border-[var(--line-soft)] pt-2.5">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="kicker">Sentinel-2 corroboration</span>
        <span className="text-[10px] text-[var(--dim)]">
          {day(v.before.scene_date)} → {day(v.after.scene_date)}
        </span>
      </div>

      <div className="flex gap-2">
        {[
          { label: "Before", src: `/aoi/${aoiSlug}/imagery/before.png`, d: v.before },
          { label: "After", src: `/aoi/${aoiSlug}/imagery/after.png`, d: v.after },
        ].map((c) => (
          <figure key={c.label} className="min-w-0 flex-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={c.src}
              alt={`Sentinel-2 true colour, ${day(c.d.scene_date)}`}
              className="aspect-square w-full rounded border border-[var(--line)] object-cover"
              loading="lazy"
            />
            <figcaption className="mono mt-1 text-[10px] text-[var(--dim)]">
              {c.label} · NDVI {c.d.mean_ndvi.toFixed(3)}
            </figcaption>
          </figure>
        ))}
      </div>

      <dl className="mt-2 space-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline gap-2">
            <dt
              className="flex-1 text-[10px] leading-tight"
              style={{ color: r.dim ? "var(--dim)" : "var(--text)" }}
            >
              {r.label}
              <span className="ml-1 text-[var(--dim)]">({r.hint})</span>
            </dt>
            <dd
              className="mono shrink-0 text-[11px] font-bold"
              style={{ color: r.dim ? "var(--muted)" : "var(--danger)" }}
            >
              {r.value > 0 ? "+" : ""}
              {r.value.toFixed(4)}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-2 text-[10px] leading-snug text-[var(--dim)]">
        {control !== null && corrected !== null ? (
          <>
            Most of the raw drop is seasonal: undisturbed forest {v.control!.distance_from_target_km.toFixed(0)} km
            away moved {control.toFixed(4)} in the same two images. The corrected residual is{" "}
            <b className="text-[var(--muted)]">{corrected.toFixed(4)}</b> — a modest and uncertain
            decline, not proof of large-scale clearing.
            {smoke > 0.05 && (
              <>
                {" "}
                It is further confounded by ~{Math.round(smoke * 100)}% smoke-like pixels in the
                after image, which the Sentinel cloud mask does not flag.
              </>
            )}
          </>
        ) : (
          <>Vegetation index change between two Sentinel-2 scenes.</>
        )}
      </p>
    </div>
  );
}

/**
 * How much of this ranking is real, and how much is our weighting?
 *
 * The scoring weights are considered judgements, not measurements. Showing a
 * rank to one decimal place without saying how stable it is overstates what we
 * know. This reports the share of 400 perturbed weightings in which the target
 * still made the top five, so a ranger can tell a robust call from an artefact
 * of our assumptions.
 */
function RobustnessBar({
  r,
  colour,
}: {
  r: NonNullable<ScoredTarget["robustness"]>;
  colour: string;
}) {
  const pct = Math.round(r.topNShare * 100);
  const verdict =
    pct >= 90 ? "robust" : pct >= 60 ? "moderately stable" : pct >= 25 ? "sensitive" : "fragile";

  return (
    <div className="mt-3 border-t border-[var(--line-soft)] pt-2.5">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="kicker">Rank stability</span>
        <span className="mono text-[11px] font-bold" style={{ color: colour }}>
          {pct}% · {verdict}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-[var(--line-soft)]">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: colour, opacity: 0.85 }}
        />
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-[var(--dim)]">
        Held a top-5 place in {pct}% of 400 randomised weightings; rank ranged {r.bestRank}–
        {r.worstRank}. The weights are judgements, not measurements — this is how much the
        ranking depends on them.
      </p>
    </div>
  );
}
