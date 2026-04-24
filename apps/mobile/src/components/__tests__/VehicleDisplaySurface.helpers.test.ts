import { projectRouteToCanvas } from "../VehicleDisplaySurface";

describe("projectRouteToCanvas", () => {
  it("returns null when the route is too short to draw", () => {
    expect(projectRouteToCanvas([], null, 300, 160)).toBeNull();
    expect(
      projectRouteToCanvas([{ lat: 49.5, lng: 18.1 }], null, 300, 160),
    ).toBeNull();
  });

  it("normalises the route into the requested canvas box", () => {
    const result = projectRouteToCanvas(
      [
        { lat: 49.5, lng: 18.1 },
        { lat: 49.6, lng: 18.2 },
        { lat: 49.55, lng: 18.3 },
      ],
      { lat: 49.56, lng: 18.22 },
      300,
      160,
    );

    expect(result).not.toBeNull();
    expect(result?.path.startsWith("M ")).toBe(true);
    expect(result?.points).toHaveLength(3);
    expect(result?.marker?.x).toBeGreaterThanOrEqual(0);
    expect(result?.marker?.x).toBeLessThanOrEqual(300);
    expect(result?.marker?.y).toBeGreaterThanOrEqual(0);
    expect(result?.marker?.y).toBeLessThanOrEqual(160);
  });
});
