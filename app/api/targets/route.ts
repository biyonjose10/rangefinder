import { NextResponse } from "next/server";

import { buildTargets } from "@/lib/pipeline";

export const runtime = "nodejs";
export const revalidate = 900;

export async function GET(request: Request) {
  const payload = await buildTargets(new URL(request.url).searchParams.get("aoi"));

  if (!payload) {
    return NextResponse.json(
      { error: "No areas of operation are configured. Run scripts/setup_aoi.py." },
      { status: 503 }
    );
  }

  return NextResponse.json(payload);
}
