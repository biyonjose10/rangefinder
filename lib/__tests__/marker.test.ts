import { describe, expect, it } from "vitest";

import {
  POST_MARKER_STYLE,
  SEVERITY,
  markerColour,
  markerInnerHtml,
  markerRootStyle,
  markerSize,
  severityLabel,
} from "@/lib/marker";

/** Relative luminance of an sRGB hex colour. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Approximate how a colour appears to someone with deuteranopia or protanopia,
 * the two common forms of red-green colour blindness, via the LMS cone space.
 */
function simulate(hex: string, kind: "deut" | "prot"): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const L = 17.8824 * r + 43.5161 * g + 4.11935 * b;
  const M = 3.45565 * r + 27.1554 * g + 3.86714 * b;
  const S = 0.0299566 * r + 0.184309 * g + 1.46709 * b;
  const [L2, M2, S2] =
    kind === "deut" ? [L, 0.494207 * L + 1.24827 * S, S] : [2.02344 * M - 2.52581 * S, M, S];
  const out = [
    0.080944 * L2 - 0.130504 * M2 + 0.116721 * S2,
    -0.0102485 * L2 + 0.0540194 * M2 - 0.113615 * S2,
    -0.000365294 * L2 - 0.00412163 * M2 + 0.693513 * S2,
  ].map((c) => Math.max(0, Math.min(255, Math.round(c * 255))));
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The positioning invariant is the whole point of these tests.
 *
 * MapLibre positions a marker by transforming the element it is given, and
 * relies on its own `.maplibregl-marker { position: absolute }` rule to take
 * effect. An inline `position` on that element wins the cascade, the marker
 * drops into document flow, and it stops tracking the map — it keeps its screen
 * position while the map pans underneath. That shipped once. These tests are
 * here so it cannot ship again.
 */
const POSITIONING = /(^|;)\s*(position|top|left|right|bottom)\s*:/;

describe("marker root styles never fight MapLibre's positioning", () => {
  it("target marker root declares no positioning property", () => {
    for (const count of [1, 4, 28, 179, 5000]) {
      const style = markerRootStyle(markerSize(count));
      expect(style, `count=${count}`).not.toMatch(POSITIONING);
      expect(style).toContain("width:");
      expect(style).toContain("height:");
    }
  });

  it("origin-station marker root declares no positioning property", () => {
    expect(POST_MARKER_STYLE).not.toMatch(POSITIONING);
  });

  it("positioning lives on the inner wrapper instead, so the badge still stacks", () => {
    const html = markerInnerHtml({ rank: 1, colour: "#ef4444", selected: true, pulse: true });
    // A relatively positioned wrapper is required for the absolutely
    // positioned badge and pulse to sit on top of each other.
    expect(html).toContain("position:relative");
    expect(html).toContain("position:absolute");
  });
});

describe("marker sizing and colour", () => {
  it("scales with cluster size but stays within legible bounds", () => {
    expect(markerSize(1)).toBe(14);
    expect(markerSize(10_000)).toBe(30);
    // Larger clusters are never drawn smaller than smaller ones.
    const sizes = [1, 5, 20, 100, 400].map(markerSize);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });

  it("maps score bands to the legend's colours", () => {
    // Asserted against the shared SEVERITY table rather than hardcoded hexes,
    // so changing the palette does not require editing the boundaries too —
    // only the band edges are the contract here.
    const at = (score: number) => SEVERITY.find((s) => score >= s.min)!;
    expect(markerColour(75)).toBe(at(75).colour);
    expect(markerColour(60)).toBe(at(60).colour);
    expect(markerColour(59.9)).toBe(at(59.9).colour);
    expect(markerColour(40)).toBe(at(40).colour);
    expect(markerColour(12)).toBe(at(12).colour);
    // The bands themselves must stay distinct.
    expect(new Set(SEVERITY.map((s) => s.colour)).size).toBe(SEVERITY.length);
  });

  it("renders the pulse only when asked", () => {
    const on = markerInnerHtml({ rank: 1, colour: "#ef4444", selected: false, pulse: true });
    const off = markerInnerHtml({ rank: 2, colour: "#f97316", selected: false, pulse: false });
    expect(on).toContain('class="ping"');
    expect(off).not.toContain('class="ping"');
  });
});

/**
 * Roughly 8% of men have red-green colour blindness. The original palette ran
 * red -> orange -> yellow -> green, which under simulation collapsed into four
 * near-identical olives whose order inverted between the bottom two levels —
 * so the severity scale, the one thing this interface exists to communicate,
 * was unreadable and actively misleading for a large minority of users.
 *
 * These tests hold the replacement to the standard that fixed it.
 */
describe("severity is readable without colour vision", () => {
  it("luminance decreases monotonically for normal, deuteranope and protanope vision", () => {
    for (const kind of ["normal", "deut", "prot"] as const) {
      const lums = SEVERITY.map((s) =>
        luminance(kind === "normal" ? s.colour : simulate(s.colour, kind))
      );
      for (let i = 0; i < lums.length - 1; i++) {
        // A clear gap, not merely a different number — adjacent levels must be
        // distinguishable, not just technically unequal.
        expect(
          lums[i] - lums[i + 1],
          `${kind}: ${SEVERITY[i].label} vs ${SEVERITY[i + 1].label}`
        ).toBeGreaterThan(12);
      }
    }
  });

  it("every score also carries the severity in words, so colour is never the only cue", () => {
    expect(severityLabel(90)).toBe("CRITICAL");
    expect(severityLabel(60)).toBe("CRITICAL");
    expect(severityLabel(59.9)).toBe("HIGH");
    expect(severityLabel(40)).toBe("MODERATE");
    expect(severityLabel(0)).toBe("LOW");
  });

  it("colour and label always agree", () => {
    for (const score of [95, 60, 55, 40, 39, 5]) {
      const band = SEVERITY.find((s) => score >= s.min)!;
      expect(markerColour(score)).toBe(band.colour);
      expect(severityLabel(score)).toBe(band.label);
    }
  });
});
