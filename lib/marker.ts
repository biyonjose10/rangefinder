/**
 * Marker presentation, kept as pure functions so it can be tested.
 *
 * This exists because the same mistake was made twice. MapLibre positions a
 * marker by setting a transform on the element you hand it, relying on its own
 * `.maplibregl-marker { position: absolute }` stylesheet rule. An inline
 * `position` on that element beats the stylesheet, the element falls back into
 * document flow, and the marker silently stops tracking the map — it holds its
 * screen position while the world scrolls underneath it.
 *
 * The same trap collapsed the map container earlier, where a Tailwind
 * `absolute` utility lost to maplibre-gl.css's unlayered
 * `.maplibregl-map { position: relative }`.
 *
 * So: the root element gets size and cursor only. Anything that needs
 * positioning context goes on an inner wrapper. `lib/__tests__/marker.test.ts`
 * asserts that invariant.
 */

/** Cluster count → marker diameter in pixels. */
export function markerSize(count: number): number {
  return Math.max(14, Math.min(30, 11 + Math.sqrt(count) * 1.7));
}

export function markerColour(score: number): string {
  if (score >= 60) return "#ef4444";
  if (score >= 50) return "#f97316";
  if (score >= 40) return "#eab308";
  return "#84cc16";
}

/**
 * Inline style for the marker root.
 *
 * Must never contain `position`, `top`, `left`, `right` or `bottom` — those
 * belong to MapLibre.
 */
export function markerRootStyle(size: number): string {
  return `width:${size}px;height:${size}px;cursor:pointer`;
}

export function markerInnerHtml(opts: {
  rank: number;
  colour: string;
  selected: boolean;
  pulse: boolean;
}): string {
  const { rank, colour, selected, pulse } = opts;
  const border = selected
    ? "2.5px solid #e8f0ed"
    : "1.5px solid rgba(10,15,13,.85)";

  return `
    <span style="position:relative;display:block;width:100%;height:100%">
      ${pulse ? `<span class="ping" style="position:absolute;inset:0;border-radius:50%;background:${colour}"></span>` : ""}
      <span style="position:absolute;inset:0;border-radius:50%;background:${colour};
            opacity:${selected ? 1 : 0.85};border:${border};
            display:flex;align-items:center;justify-content:center;
            font-size:9px;font-weight:700;color:#06120c">${rank}</span>
    </span>`;
}

/** Style for the origin-station marker. Same rule: no positioning. */
export const POST_MARKER_STYLE =
  "width:13px;height:13px;border-radius:3px;background:#e8f0ed;" +
  "border:2px solid #0a0f0d;box-shadow:0 0 0 1.5px #e8f0ed";
