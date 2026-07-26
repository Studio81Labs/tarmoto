import { describe, expect, it } from "vitest";
import {
  duplicateTripPayload as duplicateTripPayloadWithTranslate,
  nextCopyName as nextCopyNameWithTranslate,
  type DuplicateTripContext,
} from "../trip-duplicate";
import type { Trip } from "../types";
import { t as englishTranslate, type Translate } from "@/i18n";

const nextCopyName = (name: string, translate: Translate = englishTranslate) =>
  nextCopyNameWithTranslate(name, translate);
const duplicateTripPayload = (
  trip: Trip,
  context: DuplicateTripContext = { isOwner: true },
  translate: Translate = englishTranslate,
) => duplicateTripPayloadWithTranslate(trip, context, translate);

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: "trip_original",
    name: "Alps Loop",
    description: "Five days through the Alps",
    status: "planned",
    num_days: 1,
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
    folder_id: "fld_alps",
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

  it("uses the active catalog for generated copy names", () => {
    const translate = ((key: string, values?: Record<string, unknown>) => {
      if (key === "Trip") return "Výlet";
      if (key === "{name} (copy)") return `${String(values?.name)} (kopie)`;
      return key;
    }) as Translate;

    expect(nextCopyName("Alps Loop", translate)).toBe("Alps Loop (kopie)");
    expect(nextCopyName(" ", translate)).toBe("Výlet (kopie)");
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

  it("preserves description and folder_id when the caller owns the source", () => {
    const payload = duplicateTripPayload(makeTrip(), { isOwner: true });
    expect(payload.description).toBe("Five days through the Alps");
    expect(payload.folder_id).toBe("fld_alps");
  });

  it("omits description and folder_id when absent", () => {
    const {
      description: _description,
      folder_id: _folder_id,
      ...trip
    } = makeTrip();
    const payload = duplicateTripPayload(trip, { isOwner: true });
    expect(payload).not.toHaveProperty("description");
    expect(payload).not.toHaveProperty("folder_id");
  });

  it("strips folder_id when the caller is NOT the source's owner", () => {
    // Folders are private per-user (US-37). The backend's POST /trips
    // ownership check resolves folder_id against the CALLING user's
    // folders, so a co-collaborator forwarding the source's folder_id
    // used to 404 every duplicate of a filed trip. The companion
    // mirrors the server-side `carryFolderId` guard.
    const payload = duplicateTripPayload(makeTrip(), { isOwner: false });
    expect(payload).not.toHaveProperty("folder_id");
    // Description still comes through — only folder_id is privileged.
    expect(payload.description).toBe("Five days through the Alps");
  });

  it("defaults to owner-style preservation when no context is supplied (back-compat)", () => {
    const payload = duplicateTripPayload(makeTrip());
    expect(payload.folder_id).toBe("fld_alps");
  });

  it("preserves an explicitly empty description", () => {
    const payload = duplicateTripPayload(makeTrip({ description: "" }));
    expect(payload.description).toBe("");
  });

  it("applies the (copy) suffix to the duplicated name", () => {
    expect(duplicateTripPayload(makeTrip()).name).toBe("Alps Loop (copy)");
  });

  it("deep-copies waypoint locations", () => {
    const trip = makeTrip();
    const payload = duplicateTripPayload(trip);
    expect(payload.days[0]?.waypoints[0]?.location).not.toBe(
      trip.days[0]?.waypoints[0]?.location,
    );
  });

  it("omits overnight bookings, cached geometry, and segment previews", () => {
    const trip = makeTrip({
      days: [
        {
          dayNumber: 1,
          waypoints: [],
          distanceKm: 250,
          durationMinutes: 400,
          elevationGain: 2000,
          avgQuality: 4,
          overnightStop: {
            id: "poi_1",
            name: "Hotel",
            type: "accommodation",
            location: { lng: 10, lat: 45 },
          },
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [10, 45],
              [11, 46],
            ],
          },
          segments: [],
        },
      ],
    });
    const payload = duplicateTripPayload(trip);
    expect(payload.days[0]).not.toHaveProperty("overnightStop");
    expect(payload.days[0]).not.toHaveProperty("routeGeometry");
    expect(payload.days[0]).not.toHaveProperty("segments");
  });
});
