import { describe, expect, it } from "vitest";
import {
  polylineLengthKm,
  segmentCountForDistance,
  segmentizeRoute,
} from "../segmentize";

/** Points spaced ~11.1 km apart along a meridian (0.1° latitude steps). */
function meridianLine(pointCount: number): { lat: number; lng: number }[] {
  return Array.from({ length: pointCount }, (_, i) => ({
    lat: 49 + i * 0.1,
    lng: 15,
  }));
}

describe("segmentCountForDistance", () => {
  it("clamps to the minimum for short routes", () => {
    expect(segmentCountForDistance(0)).toBe(2);
    expect(segmentCountForDistance(5)).toBe(2);
  });

  it("targets ~12 km per segment in the mid range", () => {
    expect(segmentCountForDistance(80)).toBe(7);
  });

  it("clamps to the maximum for very long routes", () => {
    expect(segmentCountForDistance(1000)).toBe(12);
  });
});

describe("segmentizeRoute", () => {
  it("returns no segments for fewer than two points", () => {
    expect(segmentizeRoute([], 1)).toEqual([]);
    expect(segmentizeRoute([{ lat: 49, lng: 15 }], 1)).toEqual([]);
  });

  it("returns a single zero-length segment for coincident points", () => {
    const point = { lat: 49, lng: 15 };
    const slices = segmentizeRoute([point, point], 2);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.lengthKm).toBe(0);
    expect(slices[0]?.dayNumber).toBe(2);
  });

  it("splits a route into contiguous slices covering the full line", () => {
    const points = meridianLine(9); // ~89 km → 7 target slices
    const slices = segmentizeRoute(points, 1);

    expect(slices.length).toBeGreaterThanOrEqual(2);
    expect(slices.length).toBeLessThanOrEqual(points.length - 1);

    // First and last vertices of the route are preserved.
    expect(slices[0]?.geometry.coordinates[0]).toEqual([15, 49]);
    const last = slices[slices.length - 1];
    const lastCoords = last?.geometry.coordinates ?? [];
    expect(lastCoords[lastCoords.length - 1]).toEqual([15, 49.8]);

    // Adjacent slices share their boundary vertex (gap-free line).
    for (let i = 1; i < slices.length; i += 1) {
      const prevCoords = slices[i - 1]?.geometry.coordinates ?? [];
      const currCoords = slices[i]?.geometry.coordinates ?? [];
      expect(currCoords[0]).toEqual(prevCoords[prevCoords.length - 1]);
    }

    // Slice lengths sum to the full polyline length.
    const total = slices.reduce((sum, s) => sum + s.lengthKm, 0);
    expect(total).toBeCloseTo(polylineLengthKm(points), 6);

    // Every slice is a real line.
    for (const slice of slices) {
      expect(slice.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
      expect(slice.lengthKm).toBeGreaterThan(0);
    }
  });

  it("never produces more slices than edges on dense short routes", () => {
    const slices = segmentizeRoute(meridianLine(3), 1); // 2 edges, ~22 km
    expect(slices).toHaveLength(2);
  });

  it("is deterministic, including ids", () => {
    const points = meridianLine(9);
    expect(segmentizeRoute(points, 1)).toEqual(segmentizeRoute(points, 1));
    expect(segmentizeRoute(points, 1).map((s) => s.id)).toEqual(
      segmentizeRoute(points, 1).map((s) => s.id),
    );
  });

  it("stamps the day number into ids and slices", () => {
    const slices = segmentizeRoute(meridianLine(5), 3);
    for (const slice of slices) {
      expect(slice.dayNumber).toBe(3);
      expect(slice.id).toMatch(/^d3-s\d+$/);
    }
  });
});
