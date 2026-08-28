import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { clusterAlerts } from "@/lib/cluster";
import { rankTargets } from "@/lib/score";
import { fetchLiveAlerts, parseFirmsCsv } from "@/lib/sources/firms";
import { AOI, AOI_REGION, AOI_LABEL, DEMO_MODE } from "@/lib/config";
import type { Alert, ProtectedArea, RangerPost, RoadSegment } from "@/lib/types";

export const runtime = "nodejs";
export const revalidate = 900;

const DATA_DIR = path.join(process.cwd(), "data");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf8")) as T;
  } catch {
    // A missing context fixture degrades the score's precision but must never
    // take the endpoint down — an unreachable road file is not a reason to
    // withhold the alert list from a ranger.
    return fallback;
  }
}

async function loadAlerts(): Promise<{ alerts: Alert[]; live: boolean; note?: string }> {
  if (!DEMO_MODE) {
    try {
      const alerts = await fetchLiveAlerts(AOI_REGION, AOI, AbortSignal.timeout(20000));
      if (alerts.length > 0) return { alerts, live: true };
      // A genuinely empty AOI is possible (rain, cloud, no burning). Fall through
      // to the cached snapshot so the interface still has something to show,
      // clearly labelled as such.
      return {
        alerts: await loadCachedAlerts(),
        live: false,
        note: "No live detections in AOI right now — showing last cached snapshot.",
      };
    } catch (err) {
      return {
        alerts: await loadCachedAlerts(),
        live: false,
        note: `Live FIRMS fetch failed (${(err as Error).message}) — served from cache.`,
      };
    }
  }
  return { alerts: await loadCachedAlerts(), live: false, note: "DEMO_MODE is on." };
}

async function loadCachedAlerts(): Promise<Alert[]> {
  const cached = await readJson<Alert[] | null>("alerts.json", null);
  if (cached && cached.length) return cached;

  // Last resort: a raw CSV snapshot committed to the repo.
  try {
    const csv = await readFile(path.join(DATA_DIR, "firms-snapshot.csv"), "utf8");
    return parseFirmsCsv(csv, AOI);
  } catch {
    return [];
  }
}

export async function GET() {
  const started = Date.now();

  const [{ alerts, live, note }, roads, protectedAreas, post] = await Promise.all([
    loadAlerts(),
    readJson<RoadSegment[]>("roads.json", []),
    readJson<ProtectedArea[]>("protected-areas.json", []),
    readJson<RangerPost>("ranger-post.json", {
      name: "Field Station (unset)",
      lat: (AOI.south + AOI.north) / 2,
      lon: (AOI.west + AOI.east) / 2,
    }),
  ]);

  const clusters = clusterAlerts(alerts);
  const targets = rankTargets(clusters, { post, roads, protectedAreas });

  return NextResponse.json({
    aoi: { ...AOI, label: AOI_LABEL },
    post,
    live,
    note,
    counts: {
      detections: alerts.length,
      events: clusters.length,
      roadSegments: roads.length,
      protectedAreas: protectedAreas.length,
    },
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    targets,
  });
}
