import { DEMO_TRIP } from "@/lib/demo-trip";
import {
  generateTripOptions,
  regenerateTripDay,
} from "@/lib/trip-itinerary-generator";
import type { TripParameters } from "@/lib/types";

describe("trip-itinerary-generator", () => {
  const params: TripParameters = {
    days: 4,
    dailyKmTarget: 280,
    roadPreference: "scenic",
    surfacePreference: ["asphalt", "gravel"],
    avoidHighways: true,
    avoidTolls: false,
    avoidUnpaved: false,
    minQuality: 3,
  };

  it("builds comparable itinerary options that reflect the requested parameters", () => {
    const options = generateTripOptions(params);

    expect(options).toHaveLength(3);
    expect(options.map((option) => option.label)).toEqual([
      "Best fit",
      "Scenic sweep",
      "Fastest line",
    ]);

    for (const option of options) {
      expect(option.trip.parameters).toEqual(params);
      expect(option.trip.days).toHaveLength(4);
      expect(option.trip.days[0]?.overnightStop).toBeDefined();
      expect(
        option.trip.days[0]?.routeGeometry?.coordinates.length,
      ).toBeGreaterThanOrEqual(2);
      expect(option.trip.days.every((day) => day.distanceKm >= 100)).toBe(true);
      expect(option.trip.days.every((day) => day.distanceKm <= 500)).toBe(true);
      expect(
        option.trip.days.every((day) =>
          day.segments?.every((segment) =>
            params.surfacePreference.includes(segment.surfaceType),
          ),
        ),
      ).toBe(true);
    }

    expect(options[0]?.trip.parameters).not.toBe(options[1]?.trip.parameters);
    expect(options[0]?.trip.parameters.surfacePreference).not.toBe(
      options[1]?.trip.parameters.surfacePreference,
    );
  });

  it("regenerates only the selected day while keeping the trip boundaries intact", () => {
    const trip = generateTripOptions({
      ...params,
      days: 3,
    })[0]!.trip;

    const originalFirstDay = trip.days[0]!;
    const originalSecondDay = trip.days[1]!;
    const originalThirdDay = trip.days[2]!;

    const regenerated = regenerateTripDay(trip, params, 2);

    expect(regenerated.days[0]).toEqual(originalFirstDay);
    expect(regenerated.days[2]).toEqual(originalThirdDay);
    expect(regenerated.days[1]?.dayNumber).toBe(2);
    expect(regenerated.days[1]).not.toEqual(originalSecondDay);
    expect(regenerated.days[1]?.routeGeometry).not.toEqual(
      originalSecondDay.routeGeometry,
    );
    expect(regenerated.days[1]?.waypoints[0]).toEqual(
      originalSecondDay.waypoints[0],
    );
    expect(regenerated.days[1]?.waypoints.at(-1)).toEqual(
      originalSecondDay.waypoints.at(-1),
    );
  });

  it("keeps unpaved surfaces out when the rider asks to avoid them", () => {
    const options = generateTripOptions({
      ...params,
      surfacePreference: ["asphalt", "gravel", "dirt"],
      avoidUnpaved: true,
      minQuality: 4,
    });

    expect(
      options.every((option) =>
        option.trip.days.every((day) =>
          day.segments?.every(
            (segment) =>
              segment.surfaceType !== "gravel" &&
              segment.surfaceType !== "dirt",
          ),
        ),
      ),
    ).toBe(true);
  });

  it("can regenerate a demo-derived trip without mutating the original object", () => {
    const regenerated = regenerateTripDay(DEMO_TRIP, DEMO_TRIP.parameters, 1);

    expect(regenerated).not.toBe(DEMO_TRIP);
    expect(regenerated.days[0]).not.toBe(DEMO_TRIP.days[0]);
    expect(regenerated.days[0]?.overnightStop).not.toBe(
      DEMO_TRIP.days[0]?.overnightStop,
    );
    expect(regenerated.days[0]?.overnightStop?.location).not.toBe(
      DEMO_TRIP.days[0]?.overnightStop?.location,
    );
    expect(DEMO_TRIP.days[0]?.title).toBe("Passo dello Stelvio");
  });

  it("preserves the generated option preset when regenerating a day", () => {
    const fastestTrip = generateTripOptions({
      ...params,
      days: 3,
    })[2]!.trip;

    const regenerated = regenerateTripDay(fastestTrip, params, 2);

    expect(regenerated.days[1]?.title).toContain("Fastest line");
    expect(regenerated.days[1]?.title).not.toContain("Scenic sweep");
  });

  it("keeps the original trip-level parameters when regenerating a single day", () => {
    const trip = generateTripOptions({
      ...params,
      days: 3,
      dailyKmTarget: 260,
    })[0]!.trip;

    const regenerated = regenerateTripDay(
      trip,
      {
        ...params,
        days: 5,
        dailyKmTarget: 340,
        surfacePreference: ["asphalt", "gravel", "dirt"],
      },
      2,
    );

    expect(regenerated.parameters).toEqual(trip.parameters);
    expect(regenerated.parameters).not.toBe(trip.parameters);
    expect(regenerated.parameters.surfacePreference).not.toBe(
      trip.parameters.surfacePreference,
    );
  });
});
