"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import type { ProtectedArea, RangerPost, ScoredTarget } from "@/lib/types";

// MapLibre touches `window` at module scope, so it can only load client-side.
const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center text-[var(--dim)] text-sm">Loading terrain…</div>,
});

interface Payload {
  aoi: { label: string };
  post: RangerPost;
  live: boolean;
  note?: string;
  counts: { detections: number; events: number; roadSegments: number; protectedAreas: number };
  generatedAt: string;
  targets: ScoredTarget[];
}

const FACTORS: { key: keyof ScoredTarget["breakdown"]; label: string }[] = [
  { key: "extent", label: "Extent" },
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
}

/** The imagery was computed for one point. Only offer it to a target that
 *  actually sits there — roughly 5 km. */
const MATCH_DEG = 0.05;

const scoreColour = (s: number) =>
  s >= 60 ? "#ef4444" : s >= 50 ? "#f97316" : s >= 40 ? "#eab308" : "#84cc16";

export default function Home() {
  const [data, setData] = useState<Payload | null>(null);
  const [areas, setAreas] = useState<ProtectedArea[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Distinct from `selected`: the list opens the top target on load for
  // legibility, but the camera must not move until a human asks it to.
  const [focus, setFocus] = useState<string | null>(null);
  const [verif, setVerif] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/targets")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((d: Payload) => {
        setData(d);
        setSelected(d.targets[0]?.id ?? null);
      })
      .catch((e) => setError(String(e)));

    fetch("/api/protected-areas")
      .then((r) => (r.ok ? r.json() : []))
      .then(setAreas)
      .catch(() => setAreas([]));

    fetch("/api/verification")
      .then((r) => (r.ok ? r.json() : null))
      .then(setVerif)
      .catch(() => setVerif(null));
  }, []);

  const top = useMemo(() => data?.targets.slice(0, 12) ?? [], [data]);

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
          <div className="kicker">Area of operations</div>
          <div className="truncate text-[13px] font-medium">
            {data?.aoi.label ?? "—"}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-5">
          {data && (
            <>
              <Stat value={data.counts.detections.toLocaleString()} label="detections / 24h" />
              <Stat value={String(data.counts.events)} label="clearing events" />
              <div
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium"
                style={{
                  borderColor: data.live ? "var(--accent-dim)" : "var(--line)",
                  color: data.live ? "var(--accent)" : "var(--muted)",
                }}
                title={data.note ?? "Fetched from NASA FIRMS moments ago"}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: data.live ? "var(--accent)" : "var(--dim)" }}
                />
                {data.live ? "LIVE" : "CACHED"}
              </div>
            </>
          )}

          <a
            href="/api/patrol-order"
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
          {data && (
            <MapView
              targets={top}
              post={data.post}
              protectedAreas={areas}
              selectedId={selected}
              focusId={focus}
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

          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
            {error && <p className="p-4 text-sm text-[var(--alarm)]">Failed to load: {error}</p>}
            {!data && !error && <SkeletonList />}
            {top.map((t, i) => (
              <TargetRow
                key={t.id}
                target={t}
                rank={i + 1}
                open={t.id === selected}
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
        {[
          ["#ef4444", "60+"],
          ["#f97316", "50+"],
          ["#eab308", "40+"],
          ["#84cc16", "<40"],
        ].map(([c, l]) => (
          <span key={l} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: c }} />
            {l}
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
  verification,
  onClick,
}: {
  target: ScoredTarget;
  rank: number;
  open: boolean;
  verification: Verification | null;
  onClick: () => void;
}) {
  const colour = scoreColour(t.score);

  return (
    <div
      className="cursor-pointer border-b border-[var(--line-soft)] px-4 py-3 transition-colors hover:bg-[var(--panel-2)]"
      style={open ? { background: "var(--panel-2)" } : undefined}
      onClick={onClick}
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
            <span className="mono ml-auto shrink-0 text-[13px] font-bold" style={{ color: colour }}>
              {t.score.toFixed(1)}
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
            <span>{t.driveTimeHours.toFixed(1)} h out</span>
          </div>

          {t.protectedArea && (
            <div className="mt-1.5 inline-block rounded border border-[var(--accent-dim)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
              INSIDE PROTECTED TERRITORY
            </div>
          )}

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

              {verification && <NdviPanel v={verification} />}
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
 * A thermal detection says "something here is hot". It does not say "forest was
 * removed" — a fire on already-cleared pasture looks identical from orbit. The
 * NDVI drop between two cloud-free scenes a year apart is the check that
 * distinguishes the two, and it is the difference between dispatching a crew on
 * a heat signature and dispatching them on evidence.
 */
function NdviPanel({ v }: { v: Verification }) {
  const drop = v.ndvi_delta_after_minus_before;
  const day = (iso: string) => iso.slice(0, 10);
  const pct = (n: number) => (n < 0.01 ? "<0.01" : n.toFixed(2));

  return (
    <div className="mt-3 border-t border-[var(--line-soft)] pt-2.5">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="kicker">Sentinel-2 corroboration</span>
        <span
          className="mono text-[11px] font-bold"
          style={{ color: drop < 0 ? "var(--danger)" : "var(--accent)" }}
        >
          NDVI {drop > 0 ? "+" : ""}
          {drop.toFixed(4)}
        </span>
      </div>

      <div className="flex gap-2">
        {[
          { label: "Before", src: "/imagery/before.png", d: v.before },
          { label: "After", src: "/imagery/after.png", d: v.after },
        ].map((c) => (
          <figure key={c.label} className="min-w-0 flex-1">
            {/* Plain <img>: these are small static chips, and next/image's
                optimiser adds a server round-trip for no benefit here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={c.src}
              alt={`Sentinel-2 true colour, ${day(c.d.scene_date)}`}
              className="aspect-square w-full rounded border border-[var(--line)] object-cover"
              loading="lazy"
            />
            <figcaption className="mt-1 leading-tight">
              <div className="text-[10px] font-semibold text-[var(--text)]">
                {c.label} · {day(c.d.scene_date)}
              </div>
              <div className="mono text-[10px] text-[var(--dim)]">
                NDVI {c.d.mean_ndvi.toFixed(3)} · {pct(c.d.cloud_cover_pct)}% cloud
              </div>
            </figcaption>
          </figure>
        ))}
      </div>

      <p className="mt-1.5 text-[10px] leading-snug text-[var(--dim)]">
        Mean vegetation index fell {Math.abs(drop).toFixed(4)} between the two
        scenes — canopy loss, not just a heat signature. Cloud figures are
        scene-level; localised haze or smoke can still appear in the chip.
      </p>
    </div>
  );
}
