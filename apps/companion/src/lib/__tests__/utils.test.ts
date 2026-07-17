/**
 * Pure formatting and classification helpers from lib/utils.ts.
 *
 * These are the first companion tests and establish the pattern:
 * - Unit tests for pure functions live next to source under __tests__/
 * - Vitest globals (describe/it/expect) available without imports
 */

import {
  scoreToTier,
  formatDistance,
  formatDistanceFromMeters,
  confidenceLabel,
} from "../utils";

describe("scoreToTier", () => {
  it.each([
    [5.0, "excellent"],
    [4.5, "excellent"],
    [4.0, "good"],
    [3.5, "good"],
    [3.0, "fair"],
    [2.5, "fair"],
    [2.0, "poor"],
    [1.5, "poor"],
    [1.0, "very-poor"],
    [0.0, "very-poor"],
  ])('maps score %s to tier "%s"', (score, expected) => {
    expect(scoreToTier(score)).toBe(expected);
  });
});

describe("formatDistance", () => {
  it("renders sub-kilometre values in metres for metric", () => {
    expect(formatDistance(0.4)).toBe("400 m");
  });

  it("renders km with one decimal for metric", () => {
    expect(formatDistance(1)).toBe("1.0 km");
    expect(formatDistance(12.6)).toBe("12.6 km");
    expect(formatDistance(127.6)).toBe("127.6 km");
  });

  it("renders zero as 0 m for metric (preserves legacy behaviour)", () => {
    expect(formatDistance(0)).toBe("0 m");
  });

  it("defends against invalid or negative inputs", () => {
    expect(formatDistance(-5)).toBe("0 m");
    expect(formatDistance(Number.NaN)).toBe("0 m");
    expect(formatDistance(0, "imperial")).toBe("0 mi");
  });

  it("converts to miles when units are imperial", () => {
    // 10 km ≈ 6.21 mi
    expect(formatDistance(10, "imperial")).toMatch(/mi$/);
    expect(formatDistance(10, "imperial")).toContain("6.2");
  });

  it("uses feet for very short imperial distances", () => {
    // 0.05 km = 50 m ≈ 164 ft
    expect(formatDistance(0.05, "imperial")).toMatch(/ft$/);
  });

  it("rounds to whole miles for imperial distances ≥ 10 mi", () => {
    expect(formatDistance(100, "imperial")).toMatch(/mi$/);
    expect(formatDistance(100, "imperial")).not.toContain(".");
  });
});

describe("formatDistanceFromMeters", () => {
  it("renders metres under 1 km in metric", () => {
    expect(formatDistanceFromMeters(250)).toBe("250 m");
  });

  it("switches to km above 1 km in metric", () => {
    expect(formatDistanceFromMeters(1500)).toBe("1.5 km");
  });

  it("uses feet for short imperial distances", () => {
    expect(formatDistanceFromMeters(100, "imperial")).toMatch(/ft$/);
  });

  it("uses miles for longer imperial distances", () => {
    expect(formatDistanceFromMeters(5000, "imperial")).toMatch(/mi$/);
  });

  it("handles invalid and zero input", () => {
    expect(formatDistanceFromMeters(-10)).toBe("0 m");
    expect(formatDistanceFromMeters(0, "imperial")).toBe("0 ft");
  });

  it("locks the metric metres/km cutover at 1000 m", () => {
    expect(formatDistanceFromMeters(999)).toBe("999 m");
    expect(formatDistanceFromMeters(1000)).toBe("1.0 km");
  });

  it("locks the imperial feet/miles cutover at ~0.1 mi", () => {
    // 0.1 mi ≈ 160.934 m — just under uses feet, just over switches to miles.
    expect(formatDistanceFromMeters(160, "imperial")).toMatch(/ft$/);
    expect(formatDistanceFromMeters(161, "imperial")).toMatch(/mi$/);
    expect(formatDistance(0.16, "imperial")).toMatch(/ft$/);
    expect(formatDistance(0.161, "imperial")).toMatch(/mi$/);
  });
});

describe("confidenceLabel", () => {
  it.each([
    [0.9, "High"],
    [0.8, "High"],
    [0.7, "Medium"],
    [0.5, "Medium"],
    [0.4, "Low"],
    [0.0, "Low"],
  ])('maps confidence %s to "%s"', (confidence, expected) => {
    expect(confidenceLabel(confidence)).toBe(expected);
  });
});
