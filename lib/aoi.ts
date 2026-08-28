import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { FirmsRegion } from "./sources/firms";
import type { ProtectedArea, RangerPost, RoadSegment, Alert } from "./types";
import type { ForestGrid } from "./forest";

/**
 * AREAS OF OPERATION
 * ==================
 * Everything the application needs to work somewhere is a folder under
 * `data/aoi/<slug>/`. Nothing about a place is compiled into the code, so
 * adding a new one is a data task, not a development task: run
 * `scripts/setup_aoi.py`, restart, and it appears in the picker.
 *
 * The alternative — a hardcoded bounding box and a hardcoded label — is what
 * this replaces. It had the area baked into two source files that had to be
 * kept in step by hand, which meant "can it work anywhere else?" had the
 * embarrassing answer "yes, but only if you edit the source".
 */

export interface AoiMeta {
  slug: string;
  label: string;
  /** Short country/region line shown under the label. */
  subtitle?: string;
  bbox: { south: number; west: number; north: number; east: number };
  /** Which FIRMS regional feed covers this area. */
  region: FirmsRegion;
  post: RangerPost;
  /** True when the folder ships Sentinel-2 before/after imagery. */
  hasImagery?: boolean;
  generatedAt?: string;
}

const AOI_ROOT = path.join(process.cwd(), "data", "aoi");

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Every area with a readable meta.json, sorted by label.
 *
 * A folder missing or with unparseable metadata is skipped rather than thrown
 * on — one broken area must not take the whole picker down.
 */
export async function listAois(): Promise<AoiMeta[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(AOI_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const metas = await Promise.all(
    dirs.map(async (slug) => {
      const m = await readJson<AoiMeta>(path.join(AOI_ROOT, slug, "meta.json"));
      if (!m?.bbox || !m?.post) return null;
      return { ...m, slug };
    })
  );

  return metas
    .filter((m): m is AoiMeta => m !== null)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The requested area, the first available one, or null when none exist. */
export async function resolveAoi(slug?: string | null): Promise<AoiMeta | null> {
  const all = await listAois();
  if (!all.length) return null;
  if (slug) {
    const hit = all.find((a) => a.slug === slug);
    if (hit) return hit;
  }
  return all[0];
}

export interface AoiData {
  meta: AoiMeta;
  alerts: Alert[];
  roads: RoadSegment[];
  protectedAreas: ProtectedArea[];
  forestGrid: ForestGrid | null;
}

/**
 * Load one area's fixtures.
 *
 * Every field degrades to empty rather than throwing. A missing forest grid
 * costs precision in the score; a missing road file costs routing. Neither is
 * a reason to withhold the alert list from a ranger.
 */
export async function loadAoiData(meta: AoiMeta): Promise<Omit<AoiData, "alerts">> {
  const dir = path.join(AOI_ROOT, meta.slug);
  const [roads, protectedAreas, forestGrid] = await Promise.all([
    readJson<RoadSegment[]>(path.join(dir, "roads.json")),
    readJson<ProtectedArea[]>(path.join(dir, "protected-areas.json")),
    readJson<ForestGrid>(path.join(dir, "forest-grid.json")),
  ]);

  return {
    meta,
    roads: roads ?? [],
    protectedAreas: protectedAreas ?? [],
    forestGrid: forestGrid ?? null,
  };
}

export async function loadCachedAlerts(meta: AoiMeta): Promise<Alert[]> {
  return (
    (await readJson<Alert[]>(path.join(AOI_ROOT, meta.slug, "alerts.json"))) ?? []
  );
}

export const aoiDir = (slug: string) => path.join(AOI_ROOT, slug);
