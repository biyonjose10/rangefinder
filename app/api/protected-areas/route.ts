import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ProtectedArea } from "@/lib/types";

export const runtime = "nodejs";

/** Served separately from /api/targets because the boundary geometry is large
 *  (thousands of nodes) and the map needs it once, while the target list is
 *  refetched. */
export async function GET() {
  try {
    const raw = await readFile(
      path.join(process.cwd(), "data", "protected-areas.json"),
      "utf8"
    );
    return NextResponse.json(JSON.parse(raw) as ProtectedArea[]);
  } catch {
    return NextResponse.json([]);
  }
}
