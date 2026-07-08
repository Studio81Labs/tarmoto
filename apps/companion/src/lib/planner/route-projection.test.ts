import { describe, expect, it } from "vitest";
import { projectOntoRoute } from "./route-projection";

describe("projectOntoRoute", () => {
  // ~36 km due east at lat 49 (0.5° lng × 111.32 × cos 49°).
  const route = [
    { lat: 49.0, lng: 18.0 },
    { lat: 49.0, lng: 18.5 },
  ];

  it("returns ~0 off-route + the along-route km for a point on the line", () => {
    const p = projectOntoRoute({ lat: 49.0, lng: 18.25 }, route);
    expect(p).not.toBeNull();
    expect(p!.distanceFromRouteKm).toBeLessThanOrEqual(0.1);
    // Midpoint → ~half of the ~36 km leg.
    expect(p!.kmAlongRoute).toBeGreaterThan(16);
    expect(p!.kmAlongRoute).toBeLessThan(20);
  });

  it("measures the perpendicular distance for a point off the line", () => {
    // 0.1° lat north of the midpoint ≈ 11 km.
    const p = projectOntoRoute({ lat: 49.1, lng: 18.25 }, route);
    expect(p!.distanceFromRouteKm).toBeGreaterThan(10);
    expect(p!.distanceFromRouteKm).toBeLessThan(12);
  });

  it("clamps to the nearest endpoint for a point beyond the line", () => {
    // Well east of the end vertex → nearest point is the endpoint itself.
    const p = projectOntoRoute({ lat: 49.0, lng: 19.0 }, route);
    expect(p!.kmAlongRoute).toBeGreaterThan(30); // ~full leg length
  });

  it("returns null for a degenerate route", () => {
    expect(
      projectOntoRoute({ lat: 49, lng: 18 }, [{ lat: 49, lng: 18 }]),
    ).toBeNull();
  });
});
