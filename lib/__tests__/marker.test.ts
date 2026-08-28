import { describe, expect, it } from "vitest";

import {
  POST_MARKER_STYLE,
  markerColour,
  markerInnerHtml,
  markerRootStyle,
  markerSize,
} from "@/lib/marker";

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
    expect(markerColour(75)).toBe("#ef4444");
    expect(markerColour(60)).toBe("#ef4444");
    expect(markerColour(59.9)).toBe("#f97316");
    expect(markerColour(40)).toBe("#eab308");
    expect(markerColour(12)).toBe("#84cc16");
  });

  it("renders the pulse only when asked", () => {
    const on = markerInnerHtml({ rank: 1, colour: "#ef4444", selected: false, pulse: true });
    const off = markerInnerHtml({ rank: 2, colour: "#f97316", selected: false, pulse: false });
    expect(on).toContain('class="ping"');
    expect(off).not.toContain('class="ping"');
  });
});
