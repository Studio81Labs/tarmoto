/**
 * Pure formatter helpers used by RoadPreviewScreen.
 *
 * Covers the display contract the screen relies on: length units flip at
 * 1km, relative-time buckets, curviness copy bands, and breakdown
 * normalization dropping empty buckets.
 */

import {
  curvinessLabel,
  formatHazardType,
  formatLengthKm,
  formatRelativeTime,
  formatSurface,
  normalizeBreakdown,
} from "../RoadPreviewScreen.helpers";

describe("formatLengthKm", () => {
  it("shows km with one decimal at or above 1km", () => {
    expect(formatLengthKm(1000)).toBe("1.0 km");
    expect(formatLengthKm(2450)).toBe("2.5 km");
  });

  it("shows meters below 1km", () => {
    expect(formatLengthKm(250)).toBe("250 m");
  });

  it("returns empty for non-positive or invalid input", () => {
    expect(formatLengthKm(0)).toBe("");
    expect(formatLengthKm(-5)).toBe("");
    expect(formatLengthKm(Number.NaN)).toBe("");
  });
});

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-04-17T12:00:00Z").getTime();

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns "just now" for very recent timestamps', () => {
    expect(formatRelativeTime(new Date(NOW - 10_000).toISOString())).toBe(
      "just now",
    );
  });

  it("returns minute, hour, and day buckets", () => {
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString())).toBe(
      "5m ago",
    );
    expect(
      formatRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString()),
    ).toBe("3h ago");
    expect(
      formatRelativeTime(new Date(NOW - 2 * 86_400_000).toISOString()),
    ).toBe("2d ago");
  });

  // Floor (not round) so labels don't jump a bucket early at half-unit
  // boundaries — 90m must stay "1h ago", not "2h ago".
  it("floors partial units instead of rounding them up", () => {
    expect(formatRelativeTime(new Date(NOW - 90 * 60_000).toISOString())).toBe(
      "1h ago",
    );
    expect(formatRelativeTime(new Date(NOW - 150 * 60_000).toISOString())).toBe(
      "2h ago",
    );
    expect(
      formatRelativeTime(new Date(NOW - 36 * 3_600_000).toISOString()),
    ).toBe("1d ago");
  });

  it("returns empty string for unparseable input", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
  });
});

describe("curvinessLabel", () => {
  it("maps score bands to descriptive copy", () => {
    expect(curvinessLabel(4.8)).toMatch(/twisty/i);
    expect(curvinessLabel(3.7)).toMatch(/curves/i);
    expect(curvinessLabel(3.0)).toMatch(/mixed/i);
    expect(curvinessLabel(2.0)).toMatch(/straight/i);
    expect(curvinessLabel(0.5)).toMatch(/transit/i);
  });
});

describe("formatSurface", () => {
  it("capitalises the first letter", () => {
    expect(formatSurface("asphalt")).toBe("Asphalt");
    expect(formatSurface("gravel")).toBe("Gravel");
  });
});

describe("formatHazardType", () => {
  it("turns snake_case into title-cased words", () => {
    expect(formatHazardType("oil_spill")).toBe("Oil Spill");
    expect(formatHazardType("pothole")).toBe("Pothole");
  });
});

describe("normalizeBreakdown", () => {
  const keys = ["excellent", "good", "fair", "poor", "very_poor"] as const;

  it("drops empty buckets and normalises to sum to 1", () => {
    const result = normalizeBreakdown(keys, {
      excellent: 30,
      good: 20,
      fair: 0,
      poor: 0,
      very_poor: 0,
    });
    expect(result).toHaveLength(2);
    const sum = result.reduce((acc, s) => acc + s.pct, 0);
    expect(sum).toBeCloseTo(1);
    expect(result.find((s) => s.key === "excellent")?.pct).toBeCloseTo(0.6);
  });

  it("returns empty array when total is zero", () => {
    const result = normalizeBreakdown(keys, {
      excellent: 0,
      good: 0,
      fair: 0,
      poor: 0,
      very_poor: 0,
    });
    expect(result).toEqual([]);
  });

  it("ignores negative inputs", () => {
    const result = normalizeBreakdown(keys, {
      excellent: -5,
      good: 10,
      fair: 0,
      poor: 0,
      very_poor: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ key: "good", pct: 1 });
  });
});
