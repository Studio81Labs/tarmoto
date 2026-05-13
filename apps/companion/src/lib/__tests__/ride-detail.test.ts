import { describe, expect, it } from "vitest";
import {
  buildRoutePreview,
  buildSpeedProfile,
  computeQualityBreakdown,
  formatNumber,
  readingToTier,
  type RideSegmentLike,
} from "../ride-detail";

function segment(overrides: Partial<RideSegmentLike> = {}): RideSegmentLike {
  return {
    road_name: "Road",
    quality_reading: 4,
    speed_avg: 60,
    speed_max: 80,
    lean_angle_max: 20,
    ...overrides,
  };
}

describe("readingToTier", () => {
  it("delegates to scoreToTier's threshold buckets", () => {
    // Threshold bands from utils.scoreToTier: >=4.5 excellent, >=3.5 good,
    // >=2.5 fair, >=1.5 poor, else very-poor. Keep these tests aligned with
    // that function so the app shows the same tier label everywhere.
    expect(readingToTier(5)).toBe("excellent");
    expect(readingToTier(4.5)).toBe("excellent");
    expect(readingToTier(4)).toBe("good");
    expect(readingToTier(3.5)).toBe("good");
    expect(readingToTier(3)).toBe("fair");
    expect(readingToTier(2)).toBe("poor");
    expect(readingToTier(1)).toBe("very-poor");
    expect(readingToTier(0)).toBe("very-poor");
  });

  it("returns null for missing or non-numeric readings", () => {
    expect(readingToTier(null)).toBeNull();
    expect(readingToTier(undefined)).toBeNull();
    expect(readingToTier(Number.NaN)).toBeNull();
  });
});

describe("computeQualityBreakdown", () => {
  it("returns a zero-filled fixed-order legend when there are no segments", () => {
    const rows = computeQualityBreakdown([]);
    expect(rows.map((r) => r.tier)).toEqual([
      "excellent",
      "good",
      "fair",
      "poor",
      "very-poor",
    ]);
    for (const row of rows) {
      expect(row.count).toBe(0);
      expect(row.percent).toBe(0);
    }
  });

  it("counts segments per tier and rounds percentages to whole numbers", () => {
    const rows = computeQualityBreakdown([
      segment({ quality_reading: 5 }),
      segment({ quality_reading: 5 }),
      segment({ quality_reading: 4 }),
      segment({ quality_reading: 2.5 }),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.tier, r] as const));
    expect(by.excellent!.count).toBe(2);
    expect(by.excellent!.percent).toBe(50);
    expect(by.good!.count).toBe(1);
    expect(by.good!.percent).toBe(25);
    expect(by.fair!.count).toBe(1);
    expect(by.fair!.percent).toBe(25);
    expect(by.poor!.count).toBe(0);
    expect(by["very-poor"]!.count).toBe(0);
  });

  it("ignores segments with no quality reading", () => {
    const rows = computeQualityBreakdown([
      segment({ quality_reading: null }),
      segment({ quality_reading: 4 }),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.tier, r] as const));
    expect(by.good!.count).toBe(1);
    expect(by.good!.percent).toBe(100);
  });

  it("exposes hex colors from QUALITY_CONFIG for each row", () => {
    const [excellent, , , , veryPoor] = computeQualityBreakdown([]);
    expect(excellent!.color).toBe("#22C55E");
    expect(veryPoor!.color).toBe("#EF4444");
  });
});

describe("formatNumber", () => {
  it("formats numbers with the requested number of decimals", () => {
    expect(formatNumber(12.345, 1)).toBe("12.3");
    expect(formatNumber(12.345, 0)).toBe("12");
    expect(formatNumber(0, 2)).toBe("0.00");
  });

  it("returns an em-dash for missing values", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
  });
});

describe("buildRoutePreview", () => {
  it("returns null when fewer than two valid points are provided", () => {
    expect(buildRoutePreview([])).toBeNull();
    expect(buildRoutePreview(null)).toBeNull();
    expect(buildRoutePreview([{ lat: 50, lng: 14 }])).toBeNull();
    // Mixed: one valid + one out-of-range → not enough to draw
    expect(
      buildRoutePreview([
        { lat: 50, lng: 14 },
        { lat: 999, lng: 14 },
      ]),
    ).toBeNull();
  });

  it("produces an SVG path with an M command followed by L commands", () => {
    const preview = buildRoutePreview(
      [
        { lat: 50, lng: 14 },
        { lat: 50.1, lng: 14.1 },
        { lat: 50.2, lng: 14 },
      ],
      400,
      10,
    );
    expect(preview).not.toBeNull();
    expect(preview!.path.startsWith("M")).toBe(true);
    // Two L commands for the remaining points
    expect(preview!.path.match(/L/g)?.length).toBe(2);
  });

  it("fits the projected route inside the requested size", () => {
    const preview = buildRoutePreview(
      [
        { lat: 50, lng: 14 },
        { lat: 50.5, lng: 14.3 },
      ],
      200,
      5,
    );
    expect(preview).not.toBeNull();
    // Viewport is padded by `padding` on each side; inner fit never exceeds
    // `size - padding * 2`.
    expect(preview!.width).toBeLessThanOrEqual(200);
    expect(preview!.height).toBeLessThanOrEqual(200);
    // Bounds are passed through untouched for callers that want to show them.
    expect(preview!.bounds).toEqual({
      minLng: 14,
      minLat: 50,
      maxLng: 14.3,
      maxLat: 50.5,
    });
  });
});

describe("buildSpeedProfile", () => {
  it("builds an ordered segment speed series with average and max speeds", () => {
    const points = buildSpeedProfile([
      segment({ road_name: "A", speed_avg: 50, speed_max: 70 }),
      segment({
        road_name: "B",
        speed_avg: 65,
        speed_max: null,
      }),
    ]);

    expect(points).toEqual([
      {
        label: "A",
        segmentNumber: 1,
        avgKmh: 50,
        maxKmh: 70,
      },
      {
        label: "B",
        segmentNumber: 2,
        avgKmh: 65,
        maxKmh: null,
      },
    ]);
  });

  it("returns an empty series when segments have no speed readings", () => {
    expect(
      buildSpeedProfile([
        segment({ speed_avg: null, speed_max: null }),
        segment({ speed_avg: Number.NaN, speed_max: null }),
      ]),
    ).toEqual([]);
  });
});
