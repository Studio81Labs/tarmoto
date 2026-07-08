import { describe, expect, it } from "vitest";
import {
  nearestPolygonContact,
  pointInPolygon,
  projectOntoRoute,
  projectRingOntoRoute,
} from "./route-projection";

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
    // lat 48.9 / 49.5. Analytic edge projection finds the 0 km crossing.
    const box = [
      { lat: 48.9, lng: 18.1 },
      { lat: 48.9, lng: 18.4 },
      { lat: 49.5, lng: 18.4 },
      { lat: 49.5, lng: 18.1 },
    ];
    const p = projectRingOntoRoute(box, route);
    expect(p).not.toBeNull();
    expect(p!.distanceFromRouteKm).toBe(0);
    expect(p!.kmAlongRoute).toBeGreaterThan(0);
  });

  it("reads 0 km when the route crosses a thin zone between its vertices", () => {
    // A single 18.0→19.0 leg crosses a narrow sliver near lng 18.5; no route
    // vertex lands inside it, and its edges are shorter than the old ~1 km
    // sampling step. Sampling would miss the true crossing by up to ~stepKm/2;
    // analytic segment/segment projection resolves it to exactly 0.
    const longRoute = [
      { lat: 49.0, lng: 18.0 },
      { lat: 49.0, lng: 19.0 },
    ];
    const sliver = [
      { lat: 48.98, lng: 18.49 },
      { lat: 48.98, lng: 18.51 },
      { lat: 49.02, lng: 18.51 },
      { lat: 49.02, lng: 18.49 },
    ];
    const p = projectRingOntoRoute(sliver, longRoute);
    expect(p!.distanceFromRouteKm).toBe(0);
    // Crossing sits near lng 18.5 of a ~73 km leg → roughly halfway.
    expect(p!.kmAlongRoute).toBeGreaterThan(30);
    expect(p!.kmAlongRoute).toBeLessThan(40);
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

describe("pointInPolygon", () => {
  const box = [
    { lat: 49.0, lng: 18.0 },
    { lat: 49.0, lng: 18.2 },
    { lat: 49.2, lng: 18.2 },
    { lat: 49.2, lng: 18.0 },
  ];

  it("detects inside vs outside", () => {
    expect(pointInPolygon({ lat: 49.1, lng: 18.1 }, box)).toBe(true);
    expect(pointInPolygon({ lat: 49.3, lng: 18.1 }, box)).toBe(false);
    expect(pointInPolygon({ lat: 49.1, lng: 18.5 }, box)).toBe(false);
  });
});

describe("nearestPolygonContact", () => {
  const route = [
    { lat: 49.0, lng: 18.0 },
    { lat: 49.0, lng: 18.5 },
  ];

  it("reports 0 km off for a hull that fully contains the route", () => {
    // A large box surrounding the whole line — no boundary crossing, but the
    // route sits inside, so (like the server's polygon ST_DWithin) it's on-route.
    const box = [
      { lat: 48.8, lng: 17.8 },
      { lat: 48.8, lng: 18.7 },
      { lat: 49.2, lng: 18.7 },
      { lat: 49.2, lng: 17.8 },
    ];
    const p = nearestPolygonContact(box, route);
    expect(p).not.toBeNull();
    expect(p!.distanceFromRouteKm).toBe(0);
    expect(p!.kmAlongRoute).toBe(0); // starts inside → anchored at the route start
  });

  it("anchors at the entry crossing, not a late interior vertex", () => {
    // Sparse geometry: the single leg enters the zone at ~km 36 (crossing the
    // left edge at lng 18.5) but the next vertex — the first one *inside* — is
    // at lng 18.9, ~km 66. The stop must sort at the entry, not ~30 km late.
    const sparseRoute = [
      { lat: 49.0, lng: 18.0 },
      { lat: 49.0, lng: 18.9 },
    ];
    const bigZone = [
      { lat: 48.9, lng: 18.5 },
      { lat: 48.9, lng: 19.0 },
      { lat: 49.1, lng: 19.0 },
      { lat: 49.1, lng: 18.5 },
    ];
    const p = nearestPolygonContact(bigZone, sparseRoute);
    expect(p!.distanceFromRouteKm).toBe(0);
    expect(p!.kmAlongRoute).toBeGreaterThan(34);
    expect(p!.kmAlongRoute).toBeLessThan(40); // ~36 (entry), not ~66 (vertex)
  });

  it("falls back to the boundary distance for a zone off the route", () => {
    const box = [
      { lat: 49.1, lng: 18.2 },
      { lat: 49.1, lng: 18.3 },
      { lat: 49.12, lng: 18.3 },
      { lat: 49.12, lng: 18.2 },
    ];
    expect(
      nearestPolygonContact(box, route)!.distanceFromRouteKm,
    ).toBeGreaterThan(10);
  });

  it("treats a thin zone the route passes through as on-route", () => {
    // The route crosses the sliver but neither endpoint is inside it, so the
    // containment check alone would miss it — the boundary-crossing contact
    // still reads 0 km off-route.
    const longRoute = [
      { lat: 49.0, lng: 18.0 },
      { lat: 49.0, lng: 19.0 },
    ];
    const sliver = [
      { lat: 48.98, lng: 18.49 },
      { lat: 48.98, lng: 18.51 },
      { lat: 49.02, lng: 18.51 },
      { lat: 49.02, lng: 18.49 },
    ];
    expect(nearestPolygonContact(sliver, longRoute)!.distanceFromRouteKm).toBe(
      0,
    );
  });

  it("returns null on a degenerate route or empty ring", () => {
    expect(nearestPolygonContact([], route)).toBeNull();
    expect(
      nearestPolygonContact([{ lat: 49, lng: 18 }], [{ lat: 49, lng: 18 }]),
    ).toBeNull();
  });
});
