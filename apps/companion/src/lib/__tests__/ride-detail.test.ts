import { describe, expect, it } from "vitest";
import {
  buildRoutePreview,
  computeQualityBreakdown,
  formatDuration,
  formatNumber,
  qualityReadingToTier,
  type RideSegmentLike,
} from "../ride-detail";

function segment(overrides: Partial<RideSegmentLike> = {}): RideSegmentLike {
  return {
    road_name: "Road",
    quality_reading: 4,
    speed_avg: 60,
    lean_angle_max: 20,
    ...overrides,
  };
}

describe("qualityReadingToTier", () => {
  it("maps integer readings 1-5 to the canonical tiers", () => {
    expect(qualityReadingToTier(5)).toBe("excellent");
    expect(qualityReadingToTier(4)).toBe("good");
    expect(qualityReadingToTier(3)).toBe("fair");
    expect(qualityReadingToTier(2)).toBe("poor");
    expect(qualityReadingToTier(1)).toBe("very-poor");
  });

  it("floors non-integer readings into the lower tier", () => {
    expect(qualityReadingToTier(3.7)).toBe("fair");
    expect(qualityReadingToTier(4.99)).toBe("good");
  });

  it("clamps out-of-range readings into endpoints", () => {
    expect(qualityReadingToTier(6)).toBe("excellent");
    expect(qualityReadingToTier(0)).toBe("very-poor");
    expect(qualityReadingToTier(-2)).toBe("very-poor");
  });

  it("returns null for missing or non-numeric readings", () => {
    expect(qualityReadingToTier(null)).toBeNull();
    expect(qualityReadingToTier(undefined)).toBeNull();
    expect(qualityReadingToTier(Number.NaN)).toBeNull();
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
      segment({ quality_reading: 3 }),
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
});

describe("formatDuration", () => {
  it("renders minutes-only when under an hour", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(45)).toBe("45m");
  });

  it("renders hours-only when minutes are zero", () => {
    expect(formatDuration(120)).toBe("2h");
  });

  it("renders mixed hours + minutes", () => {
    expect(formatDuration(135)).toBe("2h 15m");
  });

  it("rounds fractional minutes before formatting", () => {
    expect(formatDuration(59.4)).toBe("59m");
    expect(formatDuration(59.6)).toBe("1h");
  });

  it("returns an em-dash for missing or invalid input", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
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
