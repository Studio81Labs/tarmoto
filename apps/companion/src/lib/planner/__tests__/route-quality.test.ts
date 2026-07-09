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
    segment_id: "seg-1",
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
  it("segments an uncovered route into multiple no_data slices (for splitting)", () => {
    // A single whole-route segment would land in only the day holding its
    // midpoint; the splitter assigns by midpoint, so uncovered multi-day routes
    // need the no-data stretch sliced.
    const segments = mapRouteQualitySpans(ROUTE, [], 1);
    expect(segments.length).toBeGreaterThan(1);
    expect(
      segments.every(
        (s) =>
          s.band === "no_data" &&
          s.surface === "unknown" &&
          s.score === null &&
          s.passes === 0 &&
          s.dayNumber === 1,
      ),
    ).toBe(true);
    // Sequential ids, contiguous coverage from route start to end.
    expect(segments.map((s) => s.id)).toEqual(
      segments.map((_, i) => `d1-s${i}`),
    );
    expect(segments[0]!.geometry.coordinates[0]).toEqual([0, 0]);
    expect(segments.at(-1)!.geometry.coordinates.at(-1)).toEqual([0.4, 0]);
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
    // Exactly one covered (rough) span, flanked by no_data on both sides
    // (each flank may be sliced into multiple no_data segments).
    const rough = segments.filter((s) => s.band === "rough");
    expect(rough).toHaveLength(1);
    expect(rough[0]).toMatchObject({ surface: "gravel", score: 2, passes: 3 });
    expect(segments[0]!.band).toBe("no_data");
    expect(segments.at(-1)!.band).toBe("no_data");
    // Fillers carry no surface/score — distinct from a matched-but-unscored span.
    expect(segments[0]).toMatchObject({ surface: "unknown", score: null });
    // Ids stay sequential across the (possibly multi-slice) fillers.
    expect(segments.map((s) => s.id)).toEqual(
      segments.map((_, i) => `d1-s${i}`),
    );
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

  it("folds a sub-threshold leading gap into the span instead of dropping it", () => {
    // start_fraction below MIN_FILLER_FRACTION (1e-4): no separate no_data
    // filler, and the span still covers from the route start — the interval is
    // never dropped (no hairline break, no undercounted length).
    const segments = mapRouteQualitySpans(
      ROUTE,
      [span({ start_fraction: 0.00005, end_fraction: 1, quality_score: 4 })],
      1,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ band: "good" });
    expect(segments[0]!.geometry.coordinates[0]).toEqual([0, 0]);
    const whole = mapRouteQualitySpans(ROUTE, [], 1).reduce(
      (sum, seg) => sum + seg.lengthKm,
      0,
    );
    expect(segments[0]!.lengthKm).toBeCloseTo(whole, 5);
  });

  it("folds a sub-threshold trailing gap into the last segment", () => {
    // Coverage ends just under 1 (e.g. 0.99995 on a long route). With no
    // following span, the tail must fold into the last segment rather than drop
    // it — the line reaches the route end and length isn't undercounted.
    const segments = mapRouteQualitySpans(
      ROUTE,
      [span({ start_fraction: 0, end_fraction: 0.99995, quality_score: 4 })],
      1,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]!.band).toBe("good");
    expect(segments.at(-1)!.geometry.coordinates.at(-1)).toEqual([0.4, 0]);
    const whole = mapRouteQualitySpans(ROUTE, [], 1).reduce(
      (sum, seg) => sum + seg.lengthKm,
      0,
    );
    expect(segments.reduce((sum, s) => sum + s.lengthKm, 0)).toBeCloseTo(
      whole,
      5,
    );
  });

  it("slices no_data finely enough for the finest forced split on a short route", () => {
    // ~100 km uncovered: a 14-day forced split needs ≥14 midpoints, so a ~12 km
    // slice (≈8 slices) would leave days empty — size against the finest day.
    const route = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.9 },
    ];
    const segments = mapRouteQualitySpans(route, [], 1);
    expect(segments.length).toBeGreaterThanOrEqual(14);
    expect(segments.every((s) => s.band === "no_data")).toBe(true);
  });

  it("does not cap no_data slices on long routes so long splits stay populated", () => {
    // ~222 km: a capped 12 slices would be ~18 km each — coarser than a short
    // day, so a many-day split would leave some days without a segment.
    const longRoute = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
    ];
    const segments = mapRouteQualitySpans(longRoute, [], 1);
    expect(segments.length).toBeGreaterThan(12);
    expect(segments.every((s) => s.band === "no_data")).toBe(true);
    expect(segments.map((s) => s.id)).toEqual(
      segments.map((_, i) => `d1-s${i}`),
    );
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
    // Ordered along the route: rough (0–0.4), then the no_data gap (0.4–0.6,
    // possibly multi-slice), then good (0.6–1).
    const bands = segments.map((s) => s.band);
    expect(bands[0]).toBe("rough");
    expect(bands.at(-1)).toBe("good");
    expect(bands.indexOf("rough")).toBeLessThan(bands.indexOf("no_data"));
    expect(bands.indexOf("no_data")).toBeLessThan(bands.lastIndexOf("good"));
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
    const whole = mapRouteQualitySpans(ROUTE, [], 1).reduce(
      (sum, seg) => sum + seg.lengthKm,
      0,
    );
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
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments.every((s) => s.dayNumber === 3)).toBe(true);
    expect(segments.map((s) => s.id)).toEqual(
      segments.map((_, i) => `d3-s${i}`),
    );
    // The covered tail is one span; everything before it is no_data.
    expect(segments.at(-1)!.band).not.toBe("no_data");
  });

  it("covers the full route length across all emitted segments", () => {
    const segments = mapRouteQualitySpans(
      ROUTE,
      [span({ start_fraction: 0.25, end_fraction: 0.5 })],
      1,
    );
    const total = segments.reduce((sum, s) => sum + s.lengthKm, 0);
    const whole = mapRouteQualitySpans(ROUTE, [], 1).reduce(
      (sum, seg) => sum + seg.lengthKm,
      0,
    );
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
