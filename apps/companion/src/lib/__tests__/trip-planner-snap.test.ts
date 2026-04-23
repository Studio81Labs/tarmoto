import { snapWaypointToRoadFeatures } from "../trip-planner-snap";

describe("snapWaypointToRoadFeatures", () => {
  it("snaps to the nearest point on the closest road line", () => {
    const snapped = snapWaypointToRoadFeatures({ lng: 14.435, lat: 50.102 }, [
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [14.42, 50.1],
            [14.46, 50.1],
          ],
        },
        properties: { quality_score: 3.2 },
      },
    ]);

    expect(snapped).toEqual({
      lng: 14.435,
      lat: 50.1,
    });
  });

  it("prefers a higher-quality nearby road when candidates are similarly close", () => {
    const snapped = snapWaypointToRoadFeatures({ lng: 14.45, lat: 50.11 }, [
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [14.44, 50.105],
            [14.48, 50.105],
          ],
        },
        properties: { quality_score: 2.1 },
      },
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [14.445, 50.112],
            [14.485, 50.112],
          ],
        },
        properties: { quality_score: 4.8 },
      },
    ]);

    expect(snapped).toEqual({
      lng: 14.45,
      lat: 50.112,
    });
  });

  it("returns null when no road geometry is available", () => {
    expect(snapWaypointToRoadFeatures({ lng: 14.45, lat: 50.11 }, [])).toBe(
      null,
    );
  });
});
