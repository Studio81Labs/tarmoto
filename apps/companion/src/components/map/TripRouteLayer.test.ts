import type { TripSummary } from "@/lib/types";
import { tripsToRouteCollection } from "./TripRouteLayer";

function trip(over: Partial<TripSummary> = {}): TripSummary {
  return {
    id: "t1",
    name: "Alps loop",
    status: "planned",
    num_days: 2,
    ...over,
  } as TripSummary;
}

describe("tripsToRouteCollection", () => {
  it("emits one LineString per day polyline, carrying the trip id", () => {
    const fc = tripsToRouteCollection([
      trip({
        id: "t1",
        overviewGeometry: [
          [
            [14, 49],
            [14.1, 49.1],
          ],
          [
            [15, 50],
            [15.1, 50.1],
            [15.2, 50.2],
          ],
        ],
      }),
    ]);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]!.geometry.type).toBe("LineString");
    expect(fc.features[0]!.geometry.coordinates).toEqual([
      [14, 49],
      [14.1, 49.1],
    ]);
    expect(fc.features.every((f) => f.properties.tripId === "t1")).toBe(true);
  });

  it("skips single-point and missing geometry (drafts)", () => {
    const fc = tripsToRouteCollection([
      trip({ id: "a", overviewGeometry: [[[14, 49]]] }), // one point → dropped
      trip({ id: "b", overviewGeometry: null }),
      trip({ id: "c" }), // no geometry field
    ]);
    expect(fc.features).toHaveLength(0);
  });
});
