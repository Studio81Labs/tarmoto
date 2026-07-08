import { describe, expect, it } from "vitest";
import { projectOntoRoute, projectRingOntoRoute } from "./route-projection";

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

describe("projectRingOntoRoute", () => {
  const route = [
    { lat: 49.0, lng: 18.0 },
    { lat: 49.0, lng: 18.5 },
  ];

  it("measures a polygon against its edges, not just corner vertices", () => {
    // A tall box straddling the route (lat 49.0): the route runs through the
    // left/right edges *between* the corners, which sit ~11 km away at
    // lat 48.9 / 49.5. Edge (not vertex) projection must find the ~0 km contact.
    const box = [
      { lat: 48.9, lng: 18.1 },
      { lat: 48.9, lng: 18.4 },
      { lat: 49.5, lng: 18.4 },
      { lat: 49.5, lng: 18.1 },
    ];
    const p = projectRingOntoRoute(box, route);
    expect(p).not.toBeNull();
    expect(p!.distanceFromRouteKm).toBeLessThan(1);
    expect(p!.kmAlongRoute).toBeGreaterThan(0);
  });

  it("returns the perpendicular distance for a box entirely off the route", () => {
    // A small box ~11 km north (0.1° lat) of the line.
    const box = [
      { lat: 49.1, lng: 18.2 },
      { lat: 49.1, lng: 18.3 },
      { lat: 49.12, lng: 18.3 },
      { lat: 49.12, lng: 18.2 },
    ];
    const p = projectRingOntoRoute(box, route);
    expect(p!.distanceFromRouteKm).toBeGreaterThan(10);
    expect(p!.distanceFromRouteKm).toBeLessThan(13);
  });

  it("returns null for a degenerate route or empty ring", () => {
    expect(projectRingOntoRoute([{ lat: 49, lng: 18 }], route)).not.toBeNull();
    expect(projectRingOntoRoute([], route)).toBeNull();
    expect(
      projectRingOntoRoute([{ lat: 49, lng: 18 }], [{ lat: 49, lng: 18 }]),
    ).toBeNull();
  });
});
