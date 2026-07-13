import type { RideTrack } from "./RideRouteLayer";
import { rideTracksToRouteCollection } from "./RideRouteLayer";

function track(id: string, geometry: unknown): RideTrack {
  return { id, geometry } as unknown as RideTrack;
}

describe("rideTracksToRouteCollection", () => {
  it("wraps each track's geometry in a feature carrying its ride id", () => {
    const fc = rideTracksToRouteCollection([
      track("r1", {
        type: "LineString",
        coordinates: [
          [14, 49],
          [14.1, 49.1],
        ],
      }),
    ]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]!.properties.rideId).toBe("r1");
    expect(fc.features[0]!.geometry.type).toBe("LineString");
  });

  it("skips tracks with no geometry (never routed)", () => {
    const fc = rideTracksToRouteCollection([
      track("a", null),
      track("b", { type: "LineString", coordinates: [] }),
    ]);
    expect(fc.features.map((f) => f.properties.rideId)).toEqual(["b"]);
  });
});
