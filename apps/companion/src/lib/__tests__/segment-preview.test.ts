import { describe, expect, it } from "vitest";
import {
  buildSparklinePath,
  curvinessLabel,
  formatElevationRange,
  profileExtrema,
  segmentHazardSeverity,
} from "@/lib/segment-preview";
import type { Hazard } from "@/lib/types";
import { createFormatters } from "@tarmoto/shared";

const metric = createFormatters({ locale: "en-US", units: "metric" });
const imperial = createFormatters({ locale: "en-US", units: "imperial" });

function hazard(severity: Hazard["severity"]): Hazard {
  return {
    id: `h-${severity}`,
    type: "pothole",
    location: { type: "Point", coordinates: [0, 0] },
    reporterId: "r",
    reporterName: "Rider",
    severity,
    confirmations: 1,
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-01-02T00:00:00Z",
  };
}

describe("buildSparklinePath", () => {
  it("returns empty string for empty input or zero box", () => {
    expect(buildSparklinePath([], 100, 20)).toBe("");
    expect(buildSparklinePath([1, 2], 0, 20)).toBe("");
    expect(buildSparklinePath([1, 2], 100, 0)).toBe("");
  });

  it("draws a horizontal middle line for a single point", () => {
    expect(buildSparklinePath([5], 100, 20)).toBe("M 0 10 L 100 10");
  });

  it("draws a horizontal middle line when all values are equal", () => {
    const d = buildSparklinePath([3, 3, 3], 100, 20);
    expect(d).toMatch(/^M 0\.00 10\.00( L \d+\.\d+ 10\.00){2}$/);
  });

  it("maps min to bottom and max to top inside the box", () => {
    const d = buildSparklinePath([0, 10], 100, 20);
    // y increases downward in SVG: min (0) → y=height; max (10) → y=0
    expect(d).toBe("M 0.00 20.00 L 100.00 0.00");
  });

  it("spaces points evenly across the width", () => {
    const d = buildSparklinePath([0, 5, 10], 100, 20);
    const xs = Array.from(d.matchAll(/[ML] (\d+\.\d+) /g), (m) => m[1]);
    expect(xs).toEqual(["0.00", "50.00", "100.00"]);
  });
});

describe("curvinessLabel", () => {
  it.each([
    [95, "Very twisty"],
    [80, "Very twisty"],
    [75, "Twisty"],
    [60, "Twisty"],
    [55, "Mixed"],
    [40, "Mixed"],
    [35, "Flowing"],
    [20, "Flowing"],
    [10, "Straight"],
    [0, "Straight"],
  ])("labels %d as %s", (score, label) => {
    expect(curvinessLabel(score)).toBe(label);
  });
});

describe("formatElevationRange", () => {
  it("returns em dash for empty profile", () => {
    expect(formatElevationRange([], metric)).toBe("—");
  });

  it("rounds and formats min–max", () => {
    expect(formatElevationRange([412.3, 550.7, 488.1], metric)).toBe(
      "412 – 551\u00a0m",
    );
  });

  it("converts the elevation range for imperial riders", () => {
    expect(formatElevationRange([412.3, 550.7, 488.1], imperial)).toBe(
      "1,353 – 1,807\u00a0ft",
    );
  });
});

describe("profileExtrema", () => {
  it("returns null for empty profile", () => {
    expect(profileExtrema([])).toBeNull();
  });

  it("returns min and max from a mixed profile", () => {
    expect(profileExtrema([350, 380, 420, 390])).toEqual({
      min: 350,
      max: 420,
    });
  });

  it("handles single-element profiles", () => {
    expect(profileExtrema([42])).toEqual({ min: 42, max: 42 });
  });

  it("does not overflow the argument limit for very large profiles", () => {
    // Math.min(...arr) throws RangeError around 65K elements in V8; the
    // for-loop implementation must stay O(n) without spreading.
    const big = Array.from({ length: 100_000 }, (_, i) => i);
    expect(profileExtrema(big)).toEqual({ min: 0, max: 99_999 });
  });
});

describe("segmentHazardSeverity", () => {
  it("returns 'none' when there are no hazards", () => {
    expect(segmentHazardSeverity({ activeHazards: [] })).toBe("none");
  });

  it("picks the worst severity present", () => {
    expect(
      segmentHazardSeverity({
        activeHazards: [hazard("low"), hazard("medium")],
      }),
    ).toBe("medium");

    expect(
      segmentHazardSeverity({
        activeHazards: [hazard("low"), hazard("high"), hazard("medium")],
      }),
    ).toBe("high");

    expect(segmentHazardSeverity({ activeHazards: [hazard("low")] })).toBe(
      "low",
    );
  });
});
