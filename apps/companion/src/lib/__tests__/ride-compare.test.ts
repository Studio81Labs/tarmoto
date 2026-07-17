import { describe, expect, it } from "vitest";
import { createFormatters, makeTranslator } from "@tarmoto/shared";
import { t } from "@/i18n";
import {
  buildUnifiedRoutePreview,
  computeStatRows,
  deltaDirection,
  diffQualityBreakdown,
  formatDelta,
  type ComparableRide,
} from "../ride-compare";

// Deterministic en/UTC/metric context — mirrors the component-test default
// (no FormatProvider) so lib-level assertions stay locale-neutral.
const format = createFormatters({ locale: "en", units: "metric" });

function ride(overrides: Partial<ComparableRide> = {}): ComparableRide {
  return {
    id: "r1",
    started_at: "2026-01-01T10:00:00Z",
    distance_km: 100,
    duration_min: 120,
    avg_speed: 50,
    max_speed: 120,
    avg_road_quality: 4,
    elevation_gain: 500,
    elevation_loss: 450,
    curve_count: 200,
    max_lean_angle: 35,
    fuel_estimate_l: 4,
    route_geometry: [
      { lat: 50, lng: 14 },
      { lat: 50.1, lng: 14.1 },
    ],
    segments: [],
    ...overrides,
  };
}

describe("computeStatRows", () => {
  it("produces one row per stat in stable order with `b - a` deltas", () => {
    const a = ride({ distance_km: 100, max_speed: 120, avg_road_quality: 3 });
    const b = ride({ distance_km: 150, max_speed: 110, avg_road_quality: 4.5 });
    const rows = computeStatRows(a, b, t);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.distance_km!.delta).toBe(50);
    // higher max_speed is better, but b is lower → regressed (sign check in deltaDirection test)
    expect(byKey.max_speed!.delta).toBe(-10);
    expect(byKey.avg_road_quality!.delta).toBeCloseTo(1.5, 5);
    // Order is fixed
    expect(rows.map((r) => r.key)).toEqual([
      "distance_km",
      "duration_min",
      "avg_speed",
      "max_speed",
      "elevation_gain",
      "elevation_loss",
      "avg_road_quality",
      "curve_count",
      "max_lean_angle",
    ]);
  });

  it("returns null deltas when either side lacks the value", () => {
    const a = ride({ max_lean_angle: null });
    const b = ride({ max_lean_angle: 40 });
    const row = computeStatRows(a, b, t).find(
      (r) => r.key === "max_lean_angle",
    )!;
    expect(row.a).toBeNull();
    expect(row.b).toBe(40);
    expect(row.delta).toBeNull();
  });
});

describe("diffQualityBreakdown", () => {
  it("zips breakdowns by tier in fixed order with b-minus-a percent deltas", () => {
    const a = ride({
      segments: [
        {
          road_name: null,
          quality_reading: 5,
          speed_avg: 60,
          lean_angle_max: 10,
        },
        {
          road_name: null,
          quality_reading: 5,
          speed_avg: 60,
          lean_angle_max: 10,
        },
        {
          road_name: null,
          quality_reading: 2,
          speed_avg: 60,
          lean_angle_max: 10,
        },
        {
          road_name: null,
          quality_reading: 2,
          speed_avg: 60,
          lean_angle_max: 10,
        },
      ],
    });
    const b = ride({
      segments: [
        {
          road_name: null,
          quality_reading: 5,
          speed_avg: 60,
          lean_angle_max: 10,
        },
        {
          road_name: null,
          quality_reading: 5,
          speed_avg: 60,
          lean_angle_max: 10,
        },
        {
          road_name: null,
          quality_reading: 5,
          speed_avg: 60,
          lean_angle_max: 10,
        },
        {
          road_name: null,
          quality_reading: 2,
          speed_avg: 60,
          lean_angle_max: 10,
        },
      ],
    });
    const rows = diffQualityBreakdown(a, b);
    const byTier = Object.fromEntries(rows.map((r) => [r.tier, r]));
    // a: 50% excellent, 50% poor. b: 75% excellent, 25% poor.
    expect(byTier.excellent!.percent).toBe(50);
    expect(byTier.excellent!.bPercent).toBe(75);
    expect(byTier.excellent!.deltaPercent).toBe(25);
    expect(byTier.poor!.percent).toBe(50);
    expect(byTier.poor!.bPercent).toBe(25);
    expect(byTier.poor!.deltaPercent).toBe(-25);
    expect(rows.map((r) => r.tier)).toEqual([
      "excellent",
      "good",
      "fair",
      "poor",
      "very-poor",
    ]);
  });

  it("handles missing segments on either side without throwing", () => {
    const rows = diffQualityBreakdown(
      ride({ segments: [] }),
      ride({ segments: [] }),
    );
    for (const row of rows) {
      expect(row.percent).toBe(0);
      expect(row.bPercent).toBe(0);
      expect(row.deltaPercent).toBe(0);
    }
  });
});

describe("buildUnifiedRoutePreview", () => {
  it("fits both routes to a shared viewBox so scale is comparable", () => {
    const a = ride({
      route_geometry: [
        { lat: 50, lng: 14 },
        { lat: 50.1, lng: 14.1 },
      ],
    });
    // `b` spans twice the area but shares the same origin — the unified
    // viewBox should grow to contain both, and the A preview's viewBox
    // should equal B's (shared scale).
    const b = ride({
      route_geometry: [
        { lat: 50, lng: 14 },
        { lat: 50.2, lng: 14.2 },
      ],
    });
    const unified = buildUnifiedRoutePreview(a, b, 400, 10);
    expect(unified.a).not.toBeNull();
    expect(unified.b).not.toBeNull();
    expect(unified.a!.viewBox).toBe(unified.b!.viewBox);
    expect(unified.a!.bounds).toEqual(unified.b!.bounds);
    // Shared bounds contain both routes.
    expect(unified.a!.bounds).toEqual({
      minLng: 14,
      minLat: 50,
      maxLng: 14.2,
      maxLat: 50.2,
    });
  });

  it("falls back to a single-route preview when the other ride has no geometry", () => {
    const a = ride({ route_geometry: null });
    const b = ride({
      route_geometry: [
        { lat: 50, lng: 14 },
        { lat: 50.1, lng: 14.1 },
      ],
    });
    const unified = buildUnifiedRoutePreview(a, b);
    expect(unified.a).toBeNull();
    expect(unified.b).not.toBeNull();
  });

  it("returns null previews when neither ride has enough geometry", () => {
    const unified = buildUnifiedRoutePreview(
      ride({ route_geometry: null }),
      ride({ route_geometry: [{ lat: 50, lng: 14 }] }),
    );
    expect(unified.a).toBeNull();
    expect(unified.b).toBeNull();
  });
});

describe("formatDelta / deltaDirection", () => {
  it("formatDelta adds explicit +/− signs and renders zero without a sign", () => {
    expect(formatDelta(5, 0, format)).toBe("+5");
    expect(formatDelta(-3.2, 1, format)).toBe("−3.2");
    expect(formatDelta(0, 1, format)).toBe("0.0");
    // Tiny residuals under the display precision round to zero.
    expect(formatDelta(0.0004, 2, format)).toBe("0.00");
    expect(formatDelta(null, 0, format)).toBe("—");
  });

  it("deltaDirection respects `higherIsBetter` and rounds to digits", () => {
    expect(deltaDirection(2, true)).toBe("improved");
    expect(deltaDirection(-2, true)).toBe("regressed");
    expect(deltaDirection(2, false)).toBe("regressed");
    expect(deltaDirection(0, true)).toBe("neutral");
    // Neutral when the metric has no better/worse polarity (e.g. distance).
    expect(deltaDirection(5, null)).toBe("neutral");
    // Residuals under rounding are treated as neutral.
    expect(deltaDirection(0.004, true, 2)).toBe("neutral");
  });
});

// Builds a translator over a minimal en-only catalog stub (independent of the
// real companion catalog) whose values are DISTINCT sentinels ("XX-…") rather
// than an identity map. An identity map can't tell a real `t()` call apart
// from a regression that bypasses `t()` and returns the raw canonical
// English constant — both would produce the same string. With sentinel
// values, a bypass regression returns the untranslated English constant and
// these assertions fail.
describe("ride-compare translator wiring", () => {
  const sentinelT = makeTranslator<string>({
    en: {
      Distance: "XX-Distance",
      km: "XX-km",
      Duration: "XX-Duration",
      min: "XX-min",
      "Avg speed": "XX-Avg speed",
      "km/h": "XX-km/h",
      "Max speed": "XX-Max speed",
      "Elevation gain": "XX-Elevation gain",
      m: "XX-m",
      "Elevation loss": "XX-Elevation loss",
      "Avg road quality": "XX-Avg road quality",
      "Curve count": "XX-Curve count",
      "Max lean": "XX-Max lean",
      // Deliberately mapped here even though production code must NEVER look
      // these up: proves the "/5"/"°" exclusion is a hard code-level skip,
      // not merely an artifact of these keys being unregistered in the real
      // catalog. If a future regression routes them through `t()`, this
      // sentinel entry would make it visible instead of silently matching.
      "/5": "XX-5",
      "°": "XX-deg",
    },
  });

  it("computeStatRows routes every label and (translatable) unit through the translator", () => {
    const rows = computeStatRows(ride(), ride(), sentinelT);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

    expect(byKey.distance_km!.label).toBe("XX-Distance");
    expect(byKey.distance_km!.unit).toBe("XX-km");
    expect(byKey.duration_min!.label).toBe("XX-Duration");
    expect(byKey.duration_min!.unit).toBe("XX-min");
    expect(byKey.avg_speed!.label).toBe("XX-Avg speed");
    expect(byKey.avg_speed!.unit).toBe("XX-km/h");
    expect(byKey.max_speed!.label).toBe("XX-Max speed");
    expect(byKey.max_speed!.unit).toBe("XX-km/h");
    expect(byKey.elevation_gain!.label).toBe("XX-Elevation gain");
    expect(byKey.elevation_gain!.unit).toBe("XX-m");
    expect(byKey.elevation_loss!.label).toBe("XX-Elevation loss");
    expect(byKey.elevation_loss!.unit).toBe("XX-m");
    expect(byKey.avg_road_quality!.label).toBe("XX-Avg road quality");
    expect(byKey.curve_count!.label).toBe("XX-Curve count");
    expect(byKey.curve_count!.unit).toBeUndefined();
    expect(byKey.max_lean_angle!.label).toBe("XX-Max lean");

    // "/5" and "°" are non-linguistic glyphs, excluded from `t()` entirely
    // (not merely unregistered) — the sentinel catalog above DOES map both
    // to a translated value, so if these ever came back "XX-5"/"XX-deg"
    // that would mean the exclusion was silently dropped and these glyphs
    // are being routed through the translator again.
    expect(byKey.avg_road_quality!.unit).toBe("/5");
    expect(byKey.max_lean_angle!.unit).toBe("°");
  });
});
