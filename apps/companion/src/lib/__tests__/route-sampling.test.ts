import { describe, expect, it } from "vitest";
import { MAX_CHECK_ROUTE_POINTS, sampleRoutePoints } from "../route-sampling";

function line(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

describe("sampleRoutePoints", () => {
  it("returns the input untouched when already within the cap", () => {
    const points = line(MAX_CHECK_ROUTE_POINTS);
    expect(sampleRoutePoints(points)).toBe(points);
    expect(sampleRoutePoints([])).toEqual([]);
  });

  it("caps dense polylines at the maximum", () => {
    const sampled = sampleRoutePoints(line(4000));
    expect(sampled.length).toBeLessThanOrEqual(MAX_CHECK_ROUTE_POINTS);
    expect(sampled.length).toBeGreaterThan(MAX_CHECK_ROUTE_POINTS * 0.9);
  });

  it("always keeps the first and last vertex", () => {
    const sampled = sampleRoutePoints(line(4000));
    expect(sampled[0]).toBe(0);
    expect(sampled[sampled.length - 1]).toBe(3999);
  });

  it("samples evenly and preserves order", () => {
    const sampled = sampleRoutePoints(line(1000), 11);
    expect(sampled).toEqual([
      0, 100, 200, 300, 400, 500, 599, 699, 799, 899, 999,
    ]);
  });

  it("keeps the JSON payload of a huge route under the backend body limit", () => {
    const points = Array.from({ length: 6000 }, (_, i) => ({
      lat: 49.4 + i * 0.0001,
      lng: 15.58 + i * 0.0001,
    }));
    const body = JSON.stringify({ route: sampleRoutePoints(points) });
    expect(body.length).toBeLessThan(100_000);
  });

  it("tolerates degenerate caps", () => {
    const points = line(10);
    expect(sampleRoutePoints(points, 1)).toBe(points);
    expect(sampleRoutePoints(points, 2)).toEqual([0, 9]);
  });
});
