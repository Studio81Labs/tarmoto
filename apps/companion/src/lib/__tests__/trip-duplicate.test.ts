import { describe, expect, it } from "vitest";
import { duplicateTripPayload, nextCopyName } from "../trip-duplicate";
import type { Trip } from "../types";

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: "trip_original",
    name: "Alps Loop",
    description: "Five days through the Alps",
    status: "planned",
    days: [
      {
        dayNumber: 1,
        waypoints: [
          {
            id: "wp_1",
            name: "Start",
            location: { lng: 10, lat: 45 },
            type: "start",
          },
        ],
        distanceKm: 250,
        durationMinutes: 400,
        elevationGain: 2000,
        avgQuality: 4,
      },
    ],
    parameters: {
      days: 5,
      dailyKmTarget: 250,
      roadPreference: "curvy",
      surfacePreference: ["asphalt"],
      avoidHighways: true,
      avoidTolls: false,
      avoidUnpaved: false,
      minQuality: 3,
    },
    collaborators: [
      { userId: "u1", displayName: "Owner", role: "owner" },
      { userId: "u2", displayName: "Friend", role: "editor" },
    ],
    folderId: "fld_alps",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-14T00:00:00Z",
    ...overrides,
  };
}

describe("nextCopyName", () => {
  it("adds a suffix to a plain name", () => {
    expect(nextCopyName("Alps Loop")).toBe("Alps Loop (copy)");
  });

  it("strips an existing (copy) suffix so duplicates of duplicates don't cascade", () => {
    expect(nextCopyName("Alps Loop (copy)")).toBe("Alps Loop (copy)");
    expect(nextCopyName("Alps Loop (copy 2)")).toBe("Alps Loop (copy)");
  });

  it("falls back to 'Trip (copy)' when the original is blank", () => {
    expect(nextCopyName("   ")).toBe("Trip (copy)");
  });
});

describe("duplicateTripPayload", () => {
  it("strips server-owned fields and collaborators", () => {
    const trip = makeTrip();
    const payload = duplicateTripPayload(trip);
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("createdAt");
    expect(payload).not.toHaveProperty("updatedAt");
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("collaborators");
  });

  it("copies days, waypoints, and parameters without sharing references", () => {
    const trip = makeTrip();
    const payload = duplicateTripPayload(trip);
    expect(payload.days[0]).not.toBe(trip.days[0]);
    expect(payload.days[0]?.waypoints[0]).not.toBe(trip.days[0]?.waypoints[0]);
    expect(payload.parameters).not.toBe(trip.parameters);
    expect(payload.parameters.surfacePreference).not.toBe(
      trip.parameters.surfacePreference,
    );
    expect(payload.parameters.surfacePreference).toEqual(["asphalt"]);
  });

  it("preserves description and folderId when present", () => {
    const payload = duplicateTripPayload(makeTrip());
    expect(payload.description).toBe("Five days through the Alps");
    expect(payload.folderId).toBe("fld_alps");
  });

  it("omits description and folderId when absent", () => {
    const payload = duplicateTripPayload(
      makeTrip({ description: undefined, folderId: undefined }),
    );
    expect(payload).not.toHaveProperty("description");
    expect(payload).not.toHaveProperty("folderId");
  });

  it("applies the (copy) suffix to the duplicated name", () => {
    expect(duplicateTripPayload(makeTrip()).name).toBe("Alps Loop (copy)");
  });
});
