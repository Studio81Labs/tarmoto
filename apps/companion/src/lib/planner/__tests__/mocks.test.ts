import { describe, expect, it } from "vitest";
import { mockRoadPreview } from "../mocks";
import type { RouteSegment } from "../types";

function segment(over: Partial<RouteSegment> = {}): RouteSegment {
  return {
    id: "d1-s0",
    geometry: {
      type: "LineString",
      coordinates: [
        [15, 49],
        [15.05, 49.05],
        [15.1, 49.1],
      ],
    },
    band: "good",
    surface: "asphalt",
    score: 4.2,
    passes: 20,
    lengthKm: 12,
    dayNumber: 1,
    ...over,
  };
}

describe("mockRoadPreview", () => {
  it("is deterministic for the same segment", () => {
    const seg = segment();
    expect(mockRoadPreview(seg)).toEqual(mockRoadPreview(seg));
  });

  it("builds the measured state for segments with data", () => {
    const measured = segment({ band: "good", score: 4.2, passes: 20 });
    const preview = mockRoadPreview(measured);
    expect(preview.hasData).toBe(true);
    expect(preview.score).toBe(measured.score);
    expect(preview.band).toBe(measured.band);
    expect(preview.passes).toBe(measured.passes);
    expect(preview.microStrip).toHaveLength(10);
    expect(preview.imageCapturedAt).toMatch(/^\d{4}-\d{2}$/);
    expect(preview.osmSurfaceTag).toBeUndefined();
  });

  it("builds the no-data state with an unverified OSM tag", () => {
    const noData = segment({
      band: "no_data",
      surface: "unknown",
      score: null,
      passes: 0,
    });
    const preview = mockRoadPreview(noData);
    expect(preview.hasData).toBe(false);
    expect(preview.score).toBeUndefined();
    expect(preview.microStrip).toBeUndefined();
    expect(preview.passes).toBe(0);
    expect(preview.osmSurfaceTag).toBeTruthy();
    expect(preview.imageCapturedAt).toMatch(/^\d{4}-\d{2}$/);
  });
});
