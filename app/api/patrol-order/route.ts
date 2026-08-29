import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";

import { PatrolOrder } from "@/lib/pdf/PatrolOrder";
import { PATROL_ORDER_SIZE } from "@/lib/config";
import { buildTargets } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Order numbers are date-stamped so a station can file them: RF-20260828-1430. */
function makeOrderId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 8);
  const hhmm = now.toISOString().slice(11, 16).replace(":", "");
  return `RF-${stamp}-${hhmm}`;
}

export async function GET(request: Request) {
  const aoi = new URL(request.url).searchParams.get("aoi");

  // Runs the pipeline in-process. An earlier version fetched /api/targets over
  // HTTP, which paid for the entire pipeline twice and pushed the larger area
  // past the serverless duration limit — the PDF never returned at all.
  // Ask for the day to be sequenced across exactly the targets that will be
  // tasked. The order is the one place the loop genuinely matters — it is what
  // a crew plans their day around.
  const data = await buildTargets(aoi, PATROL_ORDER_SIZE);
  if (!data) {
    return new Response("No areas of operation are configured.", { status: 503 });
  }

  const targets = data.targets.slice(0, PATROL_ORDER_SIZE);
  if (targets.length === 0) {
    return new Response("No actionable targets in the current area.", { status: 404 });
  }

  const now = new Date();
  const orderId = makeOrderId(now);

  // react-pdf types renderToBuffer against its own DocumentProps rather than
  // against whatever component returns a <Document>, so a custom wrapper never
  // structurally matches. The cast is the documented escape hatch; the element
  // genuinely is a Document at runtime.
  const buffer = await renderToBuffer(
    React.createElement(PatrolOrder, {
      orderId,
      issuedAt: now,
      aoiLabel: data.aoi.subtitle
        ? `${data.aoi.label} — ${data.aoi.subtitle}`
        : data.aoi.label,
      post: data.post,
      targets,
      totalDetections: data.counts.detections,
      totalEvents: data.counts.events,
      live: data.live,
      tour: data.tour,
    }) as React.ReactElement<import("@react-pdf/renderer").DocumentProps>
  );

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      // `inline` so it renders in the browser during a demo rather than
      // landing silently in a downloads folder.
      "Content-Disposition": `inline; filename="patrol-order-${orderId}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
