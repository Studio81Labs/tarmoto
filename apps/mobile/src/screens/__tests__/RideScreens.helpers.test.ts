/**
 * Pure formatter helpers used by the Ride screens (US-19).
 *
 * Covers the display contract the screens rely on: date stamps with
 * weekday-tolerant time, distance/duration unit transitions, GeoJSON
 * shape for the route polyline, bounds derivation, and segment
 * histogram bucketing.
 */

import type { ClassificationResult } from "@/services/sensors";
import type { LatLng, RideDetail, RideSegment } from "@/types";
import {
  NO_QUALITY_READING,
  buildRideShareMessage,
  formatCurveCount,
  formatDistanceKm,
  formatDurationMinutes,
  formatElevation,
  formatFuelLiters,
  formatLeanAngle,
  formatRideDate,
  formatSpeedKmh,
  qualityScoreFromClass,
  rideBounds,
  rideRouteFeatureCollection,
  rideRouteLineColorExpression,
  segmentQualityHistogram,
  surfaceIcon,
  surfaceLabel,
} from "../RideScreens.helpers";
import { colors, qualityColor } from "@/theme";

describe("formatRideDate", () => {
  it("formats ISO timestamps with month, day, year, and HH:MM", () => {
    // Pin TZ-independent year/month/day by using a long ISO with explicit
    // local time; in this jest env Date stays local-time so the hour
    // matches the input.
    const stamp = "2026-04-17T14:32:11";
    expect(formatRideDate(stamp)).toBe("Apr 17, 2026 · 14:32");
  });

  it("returns empty string for nullish or unparseable input", () => {
    expect(formatRideDate(undefined)).toBe("");
    expect(formatRideDate(null)).toBe("");
    expect(formatRideDate("not-a-date")).toBe("");
  });
});

describe("formatDistanceKm", () => {
  it("uses one-decimal precision below 100 km", () => {
    expect(formatDistanceKm(12.34)).toBe("12.3 km");
    expect(formatDistanceKm(0.5)).toBe("0.5 km");
  });

  it("rounds to whole km at or above 100 km", () => {
    expect(formatDistanceKm(125.4)).toBe("125 km");
    expect(formatDistanceKm(100)).toBe("100 km");
  });

  it("returns 0 km for non-positive or invalid input", () => {
    expect(formatDistanceKm(0)).toBe("0 km");
    expect(formatDistanceKm(-5)).toBe("0 km");
    expect(formatDistanceKm(Number.NaN)).toBe("0 km");
  });
});

describe("formatSpeedKmh", () => {
  it("rounds to whole km/h", () => {
    expect(formatSpeedKmh(62.4)).toBe("62 km/h");
    expect(formatSpeedKmh(62.6)).toBe("63 km/h");
  });

  it("clamps invalid values to 0", () => {
    expect(formatSpeedKmh(-1)).toBe("0 km/h");
    expect(formatSpeedKmh(Number.NaN)).toBe("0 km/h");
  });
});

describe("formatDurationMinutes", () => {
  it("renders minutes-only below 60 minutes", () => {
    expect(formatDurationMinutes(0)).toBe("0m");
    expect(formatDurationMinutes(45)).toBe("45m");
  });

  it("splits hours and minutes above 60 minutes", () => {
    expect(formatDurationMinutes(60)).toBe("1h");
    expect(formatDurationMinutes(150)).toBe("2h 30m");
  });

  it("rounds before splitting so 59.5 doesn't render as '60m'", () => {
    expect(formatDurationMinutes(59.5)).toBe("1h");
  });
});

describe("formatElevation", () => {
  it("prefixes the sign and rounds meters", () => {
    expect(formatElevation(125.4, "+")).toBe("+125 m");
    expect(formatElevation(89.6, "-")).toBe("-90 m");
  });

  it("collapses non-positive values to '<sign>0 m'", () => {
    expect(formatElevation(0, "+")).toBe("+0 m");
    expect(formatElevation(Number.NaN, "-")).toBe("-0 m");
  });
});

describe("formatLeanAngle", () => {
  it("formats whole degrees", () => {
    expect(formatLeanAngle(32.7)).toBe("33°");
    expect(formatLeanAngle(0)).toBe("0°");
    expect(formatLeanAngle(Number.NaN)).toBe("0°");
  });
});

describe("formatFuelLiters", () => {
  it("renders one decimal liter", () => {
    expect(formatFuelLiters(4.234)).toBe("4.2 L");
    expect(formatFuelLiters(0)).toBe("0 L");
    expect(formatFuelLiters(Number.NaN)).toBe("0 L");
  });
});

describe("formatCurveCount", () => {
  it("renders an integer count", () => {
    expect(formatCurveCount(0)).toBe("0");
    expect(formatCurveCount(7.6)).toBe("8");
  });
});

describe("surfaceLabel / surfaceIcon", () => {
  it("capitalises the surface name", () => {
    expect(surfaceLabel("asphalt")).toBe("Asphalt");
    expect(surfaceLabel("gravel")).toBe("Gravel");
  });

  it("falls back to Unknown when missing", () => {
    expect(surfaceLabel(null)).toBe("Unknown");
    expect(surfaceLabel(undefined)).toBe("Unknown");
  });

  it("returns a non-empty icon name for every known surface", () => {
    for (const s of [
      "asphalt",
      "concrete",
      "cobblestone",
      "gravel",
      "dirt",
      "unknown",
    ] as const) {
      expect(surfaceIcon(s).length).toBeGreaterThan(0);
    }
  });
});

describe("qualityScoreFromClass", () => {
  it("returns 0 when classification is null", () => {
    expect(qualityScoreFromClass(null)).toBe(0);
  });

  it("prefers the numeric score when finite", () => {
    const c: ClassificationResult = {
      quality_class: "good",
      quality_score: 4.2,
      surface_type: "asphalt",
      rms: 0.5,
      confidence: 0.9,
      model_version: null,
    };
    expect(qualityScoreFromClass(c)).toBeCloseTo(4.2, 2);
  });

  it("falls back to a class midpoint when score is non-finite", () => {
    const c: ClassificationResult = {
      quality_class: "fair",
      quality_score: Number.NaN,
      surface_type: "asphalt",
      rms: 0.5,
      confidence: 0.9,
      model_version: null,
    };
    expect(qualityScoreFromClass(c)).toBe(3);
  });
});

describe("rideRouteFeatureCollection", () => {
  const geometry: LatLng[] = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 0, lng: 2 },
    { lat: 0, lng: 3 },
    { lat: 0, lng: 4 },
  ];

  function makeSegment(quality: number): RideSegment {
    return {
      road_segment_id: "seg",
      road_name: null,
      quality_reading: quality,
      speed_avg: 50,
      speed_max: null,
      lean_angle_max: 0,
      length_m: null,
      elevation_profile: null,
    };
  }

  it("returns an empty feature collection for unusable geometry", () => {
    expect(rideRouteFeatureCollection([], [])).toEqual({
      type: "FeatureCollection",
      features: [],
    });
    expect(
      rideRouteFeatureCollection([{ lat: 0, lng: 0 }], []).features,
    ).toHaveLength(0);
  });

  it("emits a single no-data feature when no segments are present", () => {
    const fc = rideRouteFeatureCollection(geometry, []);
    expect(fc.features).toHaveLength(1);
    // No-data legs use the sentinel so the step expression's default
    // branch (textTertiary) handles them — a literal 0 would collide
    // with a real veryPoor reading at score 1.
    expect(fc.features[0].properties).toEqual({
      quality_reading: NO_QUALITY_READING,
    });
  });

  it("uses the no-data sentinel for non-finite per-segment readings", () => {
    const segs: RideSegment[] = [
      {
        road_segment_id: "seg",
        road_name: null,
        quality_reading: Number.NaN,
        speed_avg: 0,
        speed_max: null,
        lean_angle_max: 0,
        length_m: null,
        elevation_profile: null,
      },
    ];
    const fc = rideRouteFeatureCollection(geometry, segs);
    expect(fc.features[0].properties).toEqual({
      quality_reading: NO_QUALITY_READING,
    });
  });

  it("splits the polyline into one feature per segment, keyed by reading", () => {
    const segs = [makeSegment(4.7), makeSegment(2.1)];
    const fc = rideRouteFeatureCollection(geometry, segs);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].properties).toEqual({ quality_reading: 4.7 });
    expect(fc.features[1].properties).toEqual({ quality_reading: 2.1 });
    // The last feature must reach the polyline's end vertex so the route
    // visualisation never stops short of the rider's actual end.
    const last = fc.features[1].geometry as GeoJSON.LineString;
    expect(last.coordinates[last.coordinates.length - 1]).toEqual([4, 0]);
  });

  it("keeps every segment when integer chunking can't divide cleanly", () => {
    // 3 segments across 5 vertices (4 edges) — integer chunkSize would
    // be Math.floor(4/3)=1 and the trailing segment would be skipped
    // by the `end <= start` guard. Fractional boundaries must keep
    // all three segments visible, with the last one anchored at the
    // final vertex.
    const segs = [makeSegment(4.5), makeSegment(3.0), makeSegment(1.5)];
    const fc = rideRouteFeatureCollection(geometry, segs);
    expect(fc.features).toHaveLength(3);
    expect(fc.features[0].properties).toEqual({ quality_reading: 4.5 });
    expect(fc.features[1].properties).toEqual({ quality_reading: 3.0 });
    expect(fc.features[2].properties).toEqual({ quality_reading: 1.5 });
    const last = fc.features[2].geometry as GeoJSON.LineString;
    expect(last.coordinates[last.coordinates.length - 1]).toEqual([4, 0]);
  });

  it("treats a zero quality_reading as no-data, not as veryPoor", () => {
    // 0 is the explicit "missing" value the rest of the app uses
    // (SummaryCard reads `qScore <= 0` as "no data"). The map must
    // agree — rendering a 0 reading as veryPoor red would make the
    // polyline disagree with the badge above it.
    const segs: RideSegment[] = [
      {
        road_segment_id: "seg",
        road_name: null,
        quality_reading: 0,
        speed_avg: 0,
        speed_max: null,
        lean_angle_max: 0,
        length_m: null,
        elevation_profile: null,
      },
    ];
    const fc = rideRouteFeatureCollection(geometry, segs);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({
      quality_reading: NO_QUALITY_READING,
    });
  });

  it("emits one feature per segment even when segments outnumber edges", () => {
    // Short ride: 2-vertex polyline, 3 segments. Each segment must
    // still produce a feature; later features overlap on the single
    // edge so the most recent reading wins on top.
    const tiny: LatLng[] = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
    ];
    const segs = [makeSegment(2.0), makeSegment(3.0), makeSegment(4.5)];
    const fc = rideRouteFeatureCollection(tiny, segs);
    expect(fc.features).toHaveLength(3);
    const readings = fc.features.map((f) => f.properties?.quality_reading);
    expect(readings).toEqual([2.0, 3.0, 4.5]);
  });
});

describe("rideRouteLineColorExpression", () => {
  // Walk the buckets and confirm the polyline always agrees with the
  // shared `qualityColor` mapping. A regression here used to make the
  // map disagree with the histogram on the same screen.
  function evaluate(value: number): string {
    const expr = rideRouteLineColorExpression();
    // Step expression layout: ["step", input, default, stop1, color1, ...]
    const stops: Array<[number, string]> = [];
    for (let i = 3; i < expr.length; i += 2) {
      stops.push([expr[i] as number, expr[i + 1] as string]);
    }
    let result = expr[2] as string;
    for (const [stop, color] of stops) {
      if (value >= stop) result = color;
      else break;
    }
    return result;
  }

  it("renders the no-data sentinel as the tertiary text colour", () => {
    expect(evaluate(NO_QUALITY_READING)).toBe(colors.textTertiary);
  });

  it("agrees with qualityColor across all five buckets", () => {
    for (const score of [0.5, 1.4, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 4.9]) {
      expect(evaluate(score)).toBe(qualityColor(score));
    }
  });
});

describe("rideBounds", () => {
  it("returns null for empty geometry", () => {
    expect(rideBounds([])).toBeNull();
  });

  it("computes the south-west / north-east extremes", () => {
    const bounds = rideBounds([
      { lat: 49.0, lng: 18.0 },
      { lat: 49.5, lng: 18.5 },
      { lat: 49.2, lng: 18.8 },
    ]);
    expect(bounds).toEqual({
      sw: { lat: 49.0, lng: 18.0 },
      ne: { lat: 49.5, lng: 18.8 },
    });
  });

  it("pads degenerate single-point geometry so the camera doesn't max-zoom", () => {
    const bounds = rideBounds([{ lat: 49.0, lng: 18.0 }]);
    expect(bounds).not.toBeNull();
    if (!bounds) return;
    // Padding is symmetric on both axes so the rider's point sits at the
    // bbox centre.
    expect(bounds.sw.lat).toBeLessThan(49.0);
    expect(bounds.ne.lat).toBeGreaterThan(49.0);
    expect(bounds.sw.lng).toBeLessThan(18.0);
    expect(bounds.ne.lng).toBeGreaterThan(18.0);
  });
});

describe("segmentQualityHistogram", () => {
  function seg(quality: number): RideSegment {
    return {
      road_segment_id: "seg",
      road_name: null,
      quality_reading: quality,
      speed_avg: 50,
      speed_max: null,
      lean_angle_max: 0,
      length_m: null,
      elevation_profile: null,
    };
  }

  it("buckets readings into the shared 5-class scale", () => {
    const hist = segmentQualityHistogram([
      seg(4.8),
      seg(4.0),
      seg(2.0),
      seg(1.0),
      seg(3.0),
    ]);
    // Returned in descending bucket order so the histogram reads
    // best→worst top-down.
    expect(hist.map((h) => h.bucket)).toEqual([5, 4, 3, 2, 1]);
    expect(hist).toEqual([
      { bucket: 5, count: 1 },
      { bucket: 4, count: 1 },
      { bucket: 3, count: 1 },
      { bucket: 2, count: 1 },
      { bucket: 1, count: 1 },
    ]);
  });

  it("drops segments with non-finite readings", () => {
    const hist = segmentQualityHistogram([seg(Number.NaN), seg(4.0)]);
    const total = hist.reduce((acc, h) => acc + h.count, 0);
    expect(total).toBe(1);
  });

  it("drops segments with `quality_reading <= 0` so the histogram agrees with the map", () => {
    // The polyline + summary card both treat a 0 reading as "no
    // data". The histogram must too, otherwise it would over-report
    // "Very Poor" counts for rides with missing rows.
    const hist = segmentQualityHistogram([seg(0), seg(-1), seg(4.0)]);
    const total = hist.reduce((acc, h) => acc + h.count, 0);
    const veryPoor = hist.find((h) => h.bucket === 1)?.count ?? 0;
    expect(total).toBe(1);
    expect(veryPoor).toBe(0);
  });
});

describe("buildRideShareMessage", () => {
  const ride: RideDetail = {
    id: "ride-1",
    ride_type: "free",
    status: "completed",
    started_at: "2026-04-17T14:32:11",
    ended_at: "2026-04-17T16:02:11",
    distance_km: 42.5,
    duration_min: 90,
    avg_speed: 45,
    avg_road_quality: 4.0,
    avg_curviness: null,
    name: null,
    route_geometry: [],
    max_speed: 95,
    elevation_gain: 0,
    elevation_loss: 0,
    curve_count: 0,
    max_lean_angle: 0,
    fuel_estimate_l: 0,
    lean_distribution: null,
    segments: [],
  };

  it("includes date, distance, duration, and top speed", () => {
    const msg = buildRideShareMessage(ride);
    expect(msg).toContain("Tarmoto ride");
    expect(msg).toContain("Apr 17, 2026 · 14:32");
    expect(msg).toContain("Distance: 42.5 km");
    expect(msg).toContain("Duration: 1h 30m");
    expect(msg).toContain("Top speed: 95 km/h");
  });

  it("omits top speed when zero", () => {
    const msg = buildRideShareMessage({ ...ride, max_speed: 0 });
    expect(msg).not.toMatch(/Top speed/);
  });
});
