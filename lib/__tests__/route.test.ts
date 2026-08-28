import { describe, it, expect } from "vitest";
import { RoadGraph } from "@/lib/route";
import type { RoadSegment } from "@/lib/types";

// All RoadSegment coords are GeoJSON order: [lon, lat].

describe("RoadGraph.route", () => {
  // An L-shaped track: (0,0) -> due north to (0, 0.01) -> due east to (0.01, 0.01).
  const lShapedRoad: RoadSegment[] = [
    {
      highway: "track",
      coords: [
        [0, 0],
        [0, 0.01],
        [0.01, 0.01],
      ],
    },
  ];

  it("routes along the road, longer than the straight line, with detourRatio > 1", () => {
    const graph = new RoadGraph(lShapedRoad);
    const result = graph.route({ lat: 0, lon: 0 }, { lat: 0.01, lon: 0.01 });
    expect(result).not.toBeNull();
    // Straight-line is the hypotenuse (~1573m); the L-shaped road is the two
    // legs (~2224m) — a right-angle detour, ratio should land near sqrt(2).
    expect(result!.roadMetres).toBeGreaterThan(2200);
    expect(result!.roadMetres).toBeLessThan(2250);
    expect(result!.detourRatio).toBeGreaterThan(1);
    expect(result!.detourRatio).toBeCloseTo(Math.SQRT2, 1);
  });

  it("returns null for a point far beyond MAX_SNAP_M from any road", () => {
    const graph = new RoadGraph(lShapedRoad);
    // ~16.7km from the nearest road node — well past the 8km snap limit,
    // but still close enough for the bucket search to find that node at all.
    const result = graph.route({ lat: 0.15, lon: 0 }, { lat: 0.01, lon: 0.01 });
    expect(result).toBeNull();
  });

  it("returns null rather than throwing for two disconnected road components", () => {
    // Two separate roads, ~785km apart, sharing no node. A real crew would
    // be told "no vehicle route" here, not handed a wrong number or a crash.
    const disconnected: RoadSegment[] = [
      {
        highway: "track",
        coords: [
          [0, 0],
          [0, 0.01],
        ],
      },
      {
        highway: "track",
        coords: [
          [5, 5],
          [5, 5.01],
        ],
      },
    ];
    const graph = new RoadGraph(disconnected);
    expect(() => graph.route({ lat: 0, lon: 0 }, { lat: 5, lon: 5 })).not.toThrow();
    const result = graph.route({ lat: 0, lon: 0 }, { lat: 5, lon: 5 });
    expect(result).toBeNull();
  });
});

describe("RoadGraph.nearest", () => {
  it("returns the closest node, not just any node in range", () => {
    // Two widely separated 2-node roads. A query right next to the origin
    // cluster must snap there, not to the distant one.
    const segments: RoadSegment[] = [
      {
        highway: "track",
        coords: [
          [0, 0],
          [0, 0.001],
        ],
      },
      {
        highway: "track",
        coords: [
          [1, 1],
          [1, 1.001],
        ],
      },
    ];
    const graph = new RoadGraph(segments);
    const result = graph.nearest(0.0001, 0);
    expect(result).not.toBeNull();
    // Nearest true node (0,0 in lon,lat) is ~11m away; the far cluster is
    // ~157km away, so a wrong pick would blow this bound wide open.
    expect(result!.metres).toBeLessThan(50);
  });
});
