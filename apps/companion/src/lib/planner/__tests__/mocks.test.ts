import { describe, expect, it } from "vitest";
import { mockJoinQuality, mockRoadPreview } from "../mocks";
import { scoreToBand } from "../quality-bands";
import { segmentizeRoute } from "../segmentize";

function slicesForSeed(latOffset = 0) {
  const points = Array.from({ length: 40 }, (_, i) => ({
    lat: 49 + latOffset + i * 0.05,
    lng: 15 + Math.sin(i * 0.7) * 0.05,
  }));
  return segmentizeRoute(points, 1);
}

describe("mockJoinQuality", () => {
  it("is deterministic for identical geometry", () => {
    expect(mockJoinQuality(slicesForSeed())).toEqual(
      mockJoinQuality(slicesForSeed()),
    );
  });

  it("keeps band and score consistent", () => {
    for (const segment of mockJoinQuality(slicesForSeed())) {
      if (segment.band === "no_data") {
        expect(segment.score).toBeNull();
        expect(segment.passes).toBe(0);
        expect(segment.surface).toBe("unknown");
      } else {
        expect(segment.score).not.toBeNull();
        expect(scoreToBand(segment.score)).toBe(segment.band);
        expect(segment.passes).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("preserves slice geometry, ids, and lengths", () => {
    const slices = slicesForSeed();
    const segments = mockJoinQuality(slices);
    expect(segments.map((s) => s.id)).toEqual(slices.map((s) => s.id));
    expect(segments.map((s) => s.geometry)).toEqual(
      slices.map((s) => s.geometry),
    );
    expect(segments.map((s) => s.lengthKm)).toEqual(
      slices.map((s) => s.lengthKm),
    );
  });
});

describe("mockRoadPreview", () => {
  it("is deterministic for the same segment", () => {
    const [segment] = mockJoinQuality(slicesForSeed());
    if (!segment) throw new Error("expected at least one segment");
    expect(mockRoadPreview(segment)).toEqual(mockRoadPreview(segment));
  });

  it("builds the measured state for segments with data", () => {
    const measured = mockJoinQuality(slicesForSeed()).find(
      (s) => s.band !== "no_data",
    );
    if (!measured) throw new Error("expected a measured segment in fixture");
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
    // Scan a few seeds — the band mix is deterministic but seed-dependent.
    let noData;
    for (let offset = 0; offset < 20 && !noData; offset += 1) {
      noData = mockJoinQuality(slicesForSeed(offset)).find(
        (s) => s.band === "no_data",
      );
    }
    if (!noData) throw new Error("expected a no_data segment in fixtures");
    const preview = mockRoadPreview(noData);
    expect(preview.hasData).toBe(false);
    expect(preview.score).toBeUndefined();
    expect(preview.microStrip).toBeUndefined();
    expect(preview.passes).toBe(0);
    expect(preview.osmSurfaceTag).toBeTruthy();
    expect(preview.imageCapturedAt).toMatch(/^\d{4}-\d{2}$/);
  });
});
