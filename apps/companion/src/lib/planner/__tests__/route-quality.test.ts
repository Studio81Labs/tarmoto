import type { RouteQualitySegment } from "@/lib/api";
import { mapRouteQualitySpans } from "../route-quality";

// A straight, evenly-spaced route (constant latitude) so route fraction maps
// linearly to along-route distance — fractions are predictable.
const ROUTE = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 0.1 },
  { lat: 0, lng: 0.2 },
  { lat: 0, lng: 0.3 },
  { lat: 0, lng: 0.4 },
];

function span(over: Partial<RouteQualitySegment>): RouteQualitySegment {
  return {
    osm_way_id: "1",
    segment_index: 0,
    quality_score: 4.2,
    curviness_score: 2,
    surface_type: "asphalt",
    reading_count: 10,
    start_fraction: 0,
    end_fraction: 1,
    ...over,
  };
}

describe("mapRouteQualitySpans", () => {
  it("returns one no-data segment covering the whole route when there are no spans", () => {
    const segments = mapRouteQualitySpans(ROUTE, [], 1);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      id: "d1-s0",
      band: "no_data",
      surface: "unknown",
      score: null,
      passes: 0,
      dayNumber: 1,
    });
    expect(segments[0]!.geometry.coordinates[0]).toEqual([0, 0]);
    expect(segments[0]!.geometry.coordinates.at(-1)).toEqual([0.4, 0]);
  });

  it("maps a full-coverage span to one real segment with backend quality", () => {
    const segments = mapRouteQualitySpans(
      ROUTE,
      [
        span({
          quality_score: 4.2,
          surface_type: "asphalt",
          reading_count: 12,
        }),
      ],
      1,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      band: "good",
      surface: "asphalt",
      score: 4.2,
      passes: 12,
    });
  });

  it("fills gaps before, between, and after covered stretches with no-data", () => {
    const segments = mapRouteQualitySpans(
      ROUTE,
      [
        span({
          start_fraction: 0.25,
          end_fraction: 0.5,
          quality_score: 2,
          surface_type: "gravel",
          reading_count: 3,
        }),
      ],
      1,
    );
    expect(segments.map((s) => s.band)).toEqual([
      "no_data",
      "rough",
      "no_data",
    ]);
    expect(segments.map((s) => s.id)).toEqual(["d1-s0", "d1-s1", "d1-s2"]);
    expect(segments[1]).toMatchObject({
      surface: "gravel",
      score: 2,
      passes: 3,
    });
    // Fillers carry no surface/score — distinct from a matched-but-unscored span.
    expect(segments[0]).toMatchObject({ surface: "unknown", score: null });
  });

  it("does not insert a filler between spans that abut", () => {
    const segments = mapRouteQualitySpans(
      ROUTE,
      [
        span({ start_fraction: 0, end_fraction: 0.5, quality_score: 4 }),
        span({
          start_fraction: 0.5,
          end_fraction: 1,
          quality_score: 3,
          surface_type: "concrete",
        }),
      ],
      1,
    );
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.band)).toEqual(["good", "fair"]);
    expect(segments.map((s) => s.surface)).toEqual(["asphalt", "concrete"]);
  });

  it("treats a matched-but-unscored span as no-data band while keeping its real surface", () => {
    const segments = mapRouteQualitySpans(
      ROUTE,
      [
        span({
          quality_score: null,
          surface_type: "asphalt",
          reading_count: 0,
        }),
      ],
      1,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      band: "no_data",
      surface: "asphalt",
      score: null,
      passes: 0,
    });
  });

  it("orders output along the route even when spans arrive out of order", () => {
    const segments = mapRouteQualitySpans(
      ROUTE,
      [
        span({ start_fraction: 0.6, end_fraction: 1, quality_score: 4 }),
        span({ start_fraction: 0, end_fraction: 0.4, quality_score: 2 }),
      ],
      1,
    );
    expect(segments.map((s) => s.band)).toEqual(["rough", "no_data", "good"]);
  });

  it("clips a span that overlaps an earlier one so segments never double-cover", () => {
    const segments = mapRouteQualitySpans(
      ROUTE,
      [
        span({ start_fraction: 0, end_fraction: 0.6, quality_score: 4 }),
        span({ start_fraction: 0.4, end_fraction: 1, quality_score: 2 }),
      ],
      1,
    );
    // Second span is clipped to [0.6, 1]; nothing double-covers [0.4, 0.6].
    expect(segments.map((s) => s.band)).toEqual(["good", "rough"]);
    const total = segments.reduce((sum, s) => sum + s.lengthKm, 0);
    const whole = mapRouteQualitySpans(ROUTE, [], 1)[0]!.lengthKm;
    expect(total).toBeCloseTo(whole, 5);
  });

  it("coerces an unknown surface key to 'unknown'", () => {
    const segments = mapRouteQualitySpans(
      ROUTE,
      [span({ surface_type: "lava" })],
      1,
    );
    expect(segments[0]!.surface).toBe("unknown");
  });

  it("tags segments with the given day number and sequential ids", () => {
    const segments = mapRouteQualitySpans(
      ROUTE,
      [span({ start_fraction: 0.5, end_fraction: 1 })],
      3,
    );
    expect(segments.every((s) => s.dayNumber === 3)).toBe(true);
    expect(segments.map((s) => s.id)).toEqual(["d3-s0", "d3-s1"]);
  });

  it("covers the full route length across all emitted segments", () => {
    const segments = mapRouteQualitySpans(
      ROUTE,
      [span({ start_fraction: 0.25, end_fraction: 0.5 })],
      1,
    );
    const total = segments.reduce((sum, s) => sum + s.lengthKm, 0);
    const whole = mapRouteQualitySpans(ROUTE, [], 1)[0]!.lengthKm;
    expect(total).toBeCloseTo(whole, 5);
    expect(segments.every((s) => s.lengthKm > 0)).toBe(true);
  });

  it("returns nothing for a degenerate route", () => {
    expect(mapRouteQualitySpans([{ lat: 0, lng: 0 }], [span({})], 1)).toEqual(
      [],
    );
    expect(mapRouteQualitySpans([], [], 1)).toEqual([]);
  });
});
