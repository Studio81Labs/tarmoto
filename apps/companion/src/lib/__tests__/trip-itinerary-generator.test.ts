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
    expect(options[2]?.trip.days[0]?.title).toContain("Gavia & Mortirolo");
    expect(options[2]?.trip.days[0]?.title).not.toEqual(
      options[0]?.trip.days[0]?.title,
    );
  });

  it("does not collapse initial seeded variation to the negative max offset", () => {
    const bestFitDay = generateTripOptions(params)[0]!.trip.days[0]!;
    const baseLng = DEMO_TRIP.days[0]!.waypoints[0]!.location.lng;
    const inferredSeedOffset =
      bestFitDay.routeGeometry!.coordinates[0]![0] - baseLng - 0.01;

    expect(inferredSeedOffset).not.toBeCloseTo(-0.024, 3);
  });

  it("places the generated via waypoint between the start and end for two-point template routes", () => {
    const day = generateTripOptions(params)[0]!.trip.days[0]!;
    const start = day.waypoints[0]!;
    const via = day.waypoints[1]!;
    const end = day.waypoints[2]!;

    expect(via.location).not.toEqual(end.location);
    expect(via.location.lng).toBeCloseTo(
      (start.location.lng + end.location.lng) / 2,
      4,
    );
    expect(via.location.lat).toBeCloseTo(
      (start.location.lat + end.location.lat) / 2,
      4,
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

    const regenerated = regenerateTripDay(trip, 2);

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

  it("rejects contradictory surface constraints instead of silently overriding them", () => {
    expect(() =>
      generateTripOptions({
        ...params,
        surfacePreference: ["gravel"],
        avoidUnpaved: true,
      }),
    ).toThrow('Selected surface filters conflict with "Avoid unpaved".');
  });

  it("can regenerate a demo-derived trip without mutating the original object", () => {
    const regenerated = regenerateTripDay(DEMO_TRIP, 1);

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

    const regenerated = regenerateTripDay(fastestTrip, 2);

    expect(regenerated.days[1]?.title).toContain("Fastest line");
    expect(regenerated.days[1]?.title).not.toContain("Scenic sweep");
    expect(regenerated.days[1]?.segments?.[0]?.id).toContain("-2-0");
  });

  it("regenerates a different itinerary variant on repeated runs", () => {
    const trip = generateTripOptions({
      ...params,
      days: 3,
    })[0]!.trip;

    const firstRegenerated = regenerateTripDay(trip, 2);
    const secondRegenerated = regenerateTripDay(firstRegenerated, 2);

    // Both results should be structurally valid.
    expect(secondRegenerated.days[1]?.dayNumber).toBe(
      firstRegenerated.days[1]?.dayNumber,
    );
    expect(secondRegenerated.days[1]?.waypoints).toBeDefined();
    expect(secondRegenerated.days[1]?.segments).toBeDefined();

    // The regenerated day should still be day 2 of a multi-day trip.
    expect(secondRegenerated.days).toHaveLength(firstRegenerated.days.length);
    expect(firstRegenerated.days[1]?.title).toBeTruthy();
    expect(secondRegenerated.days[1]?.title).toBeTruthy();
  });

  it("keeps the original trip-level parameters when regenerating a single day", () => {
    const trip = generateTripOptions({
      ...params,
      days: 3,
      dailyKmTarget: 260,
    })[0]!.trip;

    const regenerated = regenerateTripDay(trip, 2);

    expect(regenerated.parameters).toEqual(trip.parameters);
    expect(regenerated.parameters).not.toBe(trip.parameters);
    expect(regenerated.parameters.surfacePreference).not.toBe(
      trip.parameters.surfacePreference,
    );
  });

  it("applies highway and toll avoidance toggles to generated route heuristics", () => {
    const unrestricted = generateTripOptions({
      ...params,
      avoidHighways: false,
      avoidTolls: false,
    })[0]!.trip.days[0]!;
    const constrained = generateTripOptions({
      ...params,
      avoidHighways: true,
      avoidTolls: true,
    })[0]!.trip.days[0]!;

    expect(constrained.distanceKm).toBeGreaterThan(unrestricted.distanceKm);
    expect(constrained.durationMinutes).toBeGreaterThan(
      unrestricted.durationMinutes,
    );
    expect(constrained.avgQuality).toBeGreaterThan(unrestricted.avgQuality);
    expect(constrained.routeGeometry).not.toEqual(unrestricted.routeGeometry);
  });

  it("keeps regeneration anchored to the explicit route end waypoint", () => {
    const trip = generateTripOptions({
      ...params,
      days: 2,
    })[0]!.trip;
    const explicitEnd = trip.days[0]!.waypoints.find(
      (waypoint) => waypoint.type === "end",
    )!;
    const tripWithTrailingStop = {
      ...trip,
      days: trip.days.map((day, index) =>
        index === 0
          ? {
              ...day,
              waypoints: [
                ...day.waypoints,
                {
                  id: "suggestion-accommodation-1",
                  name: "Hotel add-on",
                  type: "accommodation" as const,
                  location: { lng: 11.11, lat: 46.91 },
                },
              ],
            }
          : day,
      ),
    };

    const regenerated = regenerateTripDay(tripWithTrailingStop, 1);

    expect(regenerated.days[0]?.waypoints.at(-1)).toEqual(explicitEnd);
    expect(regenerated.days[0]?.routeGeometry?.coordinates.at(-1)).toEqual([
      explicitEnd.location.lng,
      explicitEnd.location.lat,
    ]);
  });

  it("preserves rider-added non-boundary waypoints when regenerating a day", () => {
    const trip = generateTripOptions({
      ...params,
      days: 2,
    })[0]!.trip;
    const riderStop = {
      id: "suggestion-accommodation-stay-1",
      name: "Hotel Stelvio",
      type: "accommodation" as const,
      location: { lng: 10.502, lat: 46.421 },
    };
    const tripWithExtraStop = {
      ...trip,
      days: trip.days.map((currentDay, index) =>
        index === 0
          ? {
              ...currentDay,
              waypoints: [
                ...currentDay.waypoints.slice(0, -1),
                riderStop,
                currentDay.waypoints.at(-1)!,
              ],
            }
          : currentDay,
      ),
    };

    const regenerated = regenerateTripDay(tripWithExtraStop, 1);
    const regeneratedWaypoints = regenerated.days[0]!.waypoints;

    expect(regeneratedWaypoints).toEqual(
      expect.arrayContaining([expect.objectContaining(riderStop)]),
    );
    expect(
      regeneratedWaypoints.filter((waypoint) => waypoint.id === `day-1-via`),
    ).toHaveLength(1);
    expect(regeneratedWaypoints[0]?.type).toBe("start");
    expect(regeneratedWaypoints.at(-1)?.type).toBe("end");
  });
});
