import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRIP_FILTERS,
  TRIP_STATUSES,
  applyTripFilters,
  countByStatus,
  tripDistanceKm,
  tripDistanceKmOrNull,
  type TripFilters,
} from "../trip-filters";
import type { Trip } from "../types";

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  const days = overrides.days ?? [
    {
      dayNumber: 1,
      waypoints: [],
      distanceKm: 100,
      durationMinutes: 120,
      elevationGain: 500,
      avgQuality: 4,
    },
  ];
  return {
    id: overrides.id ?? "trip_1",
    name: overrides.name ?? "Untitled",
    ...(overrides.description !== undefined
      ? { description: overrides.description }
      : {}),
    status: overrides.status ?? "draft",
    num_days: overrides.num_days ?? days.length,
    days,
    parameters: overrides.parameters ?? {
      days: 1,
      dailyKmTarget: 100,
      roadPreference: "mixed",
      surfacePreference: ["asphalt"],
      avoidHighways: false,
      avoidTolls: false,
      avoidUnpaved: false,
      minQuality: 3,
    },
    collaborators: overrides.collaborators ?? [
      { userId: "u1", displayName: "Me", role: "owner" },
    ],
    ...(overrides.folder_id !== undefined
      ? { folder_id: overrides.folder_id }
      : {}),
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-04-15T00:00:00Z",
  };
}

function makeFilters(overrides: Partial<TripFilters> = {}): TripFilters {
  return {
    search: overrides.search ?? "",
    statuses: new Set(overrides.statuses ?? TRIP_STATUSES),
    folderScope: overrides.folderScope ?? { kind: "all" },
    sort: overrides.sort ?? "updated",
  };
}

describe("applyTripFilters", () => {
  it("returns every trip with default filters", () => {
    const trips = [makeTrip({ id: "a" }), makeTrip({ id: "b" })];
    const result = applyTripFilters(trips, makeFilters());
    expect(result).toHaveLength(2);
  });

  it("filters by status", () => {
    const trips = [
      makeTrip({ id: "a", status: "draft" }),
      makeTrip({ id: "b", status: "completed" }),
    ];
    const result = applyTripFilters(
      trips,
      makeFilters({ statuses: new Set(["completed"]) }),
    );
    expect(result.map((t) => t.id)).toEqual(["b"]);
  });

  it("filters by folder id", () => {
    const trips = [
      makeTrip({ id: "a", folder_id: "fld_1" }),
      makeTrip({ id: "b", folder_id: "fld_2" }),
      makeTrip({ id: "c" }),
    ];
    const result = applyTripFilters(
      trips,
      makeFilters({ folderScope: { kind: "folder", id: "fld_1" } }),
    );
    expect(result.map((t) => t.id)).toEqual(["a"]);
  });

  it("filters unfiled trips (no folder_id)", () => {
    const trips = [
      makeTrip({ id: "a", folder_id: "fld_1" }),
      makeTrip({ id: "b" }),
    ];
    const result = applyTripFilters(
      trips,
      makeFilters({ folderScope: { kind: "unfiled" } }),
    );
    expect(result.map((t) => t.id)).toEqual(["b"]);
  });

  it("searches against the trip name (the only field on TripSummary)", () => {
    // `description` and `collaborator` searches were dropped along
    // with the type split — `TripSummaryDto` doesn't carry either
    // on the wire, so the previous behaviour was silently broken.
    const trips = [
      makeTrip({ id: "a", name: "Alps Loop" }),
      makeTrip({ id: "b", name: "Black Forest tour" }),
      makeTrip({ id: "c", name: "Coastal Ride" }),
    ];
    expect(
      applyTripFilters(trips, makeFilters({ search: "alps" })).map((t) => t.id),
    ).toEqual(["a"]);
    expect(
      applyTripFilters(trips, makeFilters({ search: "forest" })).map(
        (t) => t.id,
      ),
    ).toEqual(["b"]);
  });

  it("sorts by created date descending when 'updated' is requested", () => {
    // The list endpoint omits `updated_at` so the comparator falls
    // back to `createdAt`. Test fixture mirrors what the wire
    // actually returns.
    const trips = [
      makeTrip({ id: "old", createdAt: "2026-01-01T00:00:00Z" }),
      makeTrip({ id: "new", createdAt: "2026-04-15T00:00:00Z" }),
      makeTrip({ id: "mid", createdAt: "2026-03-01T00:00:00Z" }),
    ];
    const result = applyTripFilters(trips, makeFilters());
    expect(result.map((t) => t.id)).toEqual(["new", "mid", "old"]);
  });

  it("sorts by name alphabetically (case-insensitive)", () => {
    const trips = [
      makeTrip({ id: "a", name: "beskydy" }),
      makeTrip({ id: "b", name: "Alps" }),
      makeTrip({ id: "c", name: "carpathians" }),
    ];
    const result = applyTripFilters(trips, makeFilters({ sort: "name" }));
    expect(result.map((t) => t.name)).toEqual([
      "Alps",
      "beskydy",
      "carpathians",
    ]);
  });

  it("preserves filter order when 'distance' is requested on summary rows", () => {
    // Summary rows have no per-day distance, so the "distance" sort
    // is intentionally a no-op (rather than crashing or sorting on
    // a random key). The UI dropdown is unchanged; the comparator
    // just leaves the filter-stage order in place. Detail surfaces
    // sort via the standalone `tripDistanceKm` helper.
    const short = makeTrip({ id: "short" });
    const long = makeTrip({ id: "long" });
    const result = applyTripFilters(
      [short, long],
      makeFilters({ sort: "distance" }),
    );
    expect(result.map((t) => t.id)).toEqual(["short", "long"]);
  });

  it("does not mutate the input array", () => {
    const trips = [
      makeTrip({ id: "a", updatedAt: "2026-01-01T00:00:00Z" }),
      makeTrip({ id: "b", updatedAt: "2026-04-01T00:00:00Z" }),
    ];
    const before = trips.map((t) => t.id);
    applyTripFilters(trips, makeFilters());
    expect(trips.map((t) => t.id)).toEqual(before);
  });
});

describe("countByStatus", () => {
  it("counts every status, even ones with zero trips", () => {
    const counts = countByStatus([
      makeTrip({ status: "draft" }),
      makeTrip({ status: "draft" }),
      makeTrip({ status: "planned" }),
    ]);
    expect(counts).toEqual({
      draft: 2,
      planned: 1,
      active: 0,
      completed: 0,
    });
  });
});

describe("tripDistanceKm", () => {
  it("sums every day's distance", () => {
    const trip = makeTrip({
      days: [
        {
          dayNumber: 1,
          waypoints: [],
          distanceKm: 120,
          durationMinutes: 0,
          elevationGain: 0,
          avgQuality: 3,
        },
        {
          dayNumber: 2,
          waypoints: [],
          distanceKm: 80.5,
          durationMinutes: 0,
          elevationGain: 0,
          avgQuality: 3,
        },
      ],
    });
    expect(tripDistanceKm(trip)).toBeCloseTo(200.5);
  });
});

describe("tripDistanceKmOrNull", () => {
  // The summary-aware variant always returns `null` — the list
  // endpoint never returns per-day distance, so the helper exists
  // mainly to type-check call-sites that mistakenly try to compute
  // distance from a `TripSummary`. Detail-flow callers should use
  // `tripDistanceKm` directly.
  it("returns null for summary rows", () => {
    const trip = makeTrip();
    expect(tripDistanceKmOrNull(trip)).toBeNull();
  });
});

describe("DEFAULT_TRIP_FILTERS", () => {
  it("includes every status", () => {
    expect(DEFAULT_TRIP_FILTERS.statuses.size).toBe(TRIP_STATUSES.length);
  });

  it("scope defaults to 'all'", () => {
    expect(DEFAULT_TRIP_FILTERS.folderScope.kind).toBe("all");
  });
});
