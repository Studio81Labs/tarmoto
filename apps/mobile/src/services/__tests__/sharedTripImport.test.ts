/**
 * Coverage for the shared-trip preview helper (US-39 / #283 / #357).
 * Validates the snapshot → preview mapping the deep-link landing screen
 * relies on. The legacy snapshot → import-request flattener was removed
 * with #357 — the screen now hands the share token to
 * `POST /trips/from-share` instead, and the backend reconstructs the
 * full multi-day trip from the stored snapshot.
 */

import { buildSharedTripPreview } from "../sharedTripImport";
import type { TripSharePublic } from "@/types";

function share(snapshot: Record<string, unknown>): TripSharePublic {
  return {
    share_token: "tok-1",
    title: "Alps loop — demo",
    owner_name: "Adam",
    snapshot,
    view_count: 0,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

describe("buildSharedTripPreview", () => {
  it("rolls per-day distance and intermediate-stop counts up to a single preview row", () => {
    const preview = buildSharedTripPreview(
      share({
        days: [
          {
            distanceKm: 120,
            waypoints: [
              { id: "a", type: "start" },
              { id: "b", type: "fuel" },
              { id: "c", type: "via" },
            ],
          },
          {
            distanceKm: 80,
            waypoints: [
              { id: "d", type: "rest" },
              { id: "e", type: "end" },
            ],
          },
        ],
      }),
    );
    expect(preview).toEqual({
      title: "Alps loop — demo",
      ownerName: "Adam",
      dayCount: 2,
      totalDistanceKm: 200,
      // start (a) and end (e) excluded; b/c/d are real stops.
      stopCount: 3,
    });
  });

  it("excludes start/end and unknown waypoint types from stopCount", () => {
    const preview = buildSharedTripPreview(
      share({
        days: [
          {
            distanceKm: 50,
            waypoints: [
              { id: "1", type: "start" },
              { id: "2", type: "end" },
              { id: "3", type: "weird" },
              // No type field at all — also excluded.
              { id: "4" },
            ],
          },
        ],
      }),
    );
    expect(preview?.stopCount).toBe(0);
  });

  it("counts accommodation waypoints as stops (multi-day overnight handoff)", () => {
    // The `/trips/from-share` flow preserves accommodation waypoints
    // server-side (they survive the snapshot → trip_days roundtrip);
    // the preview row should reflect them so the rider sees a stop
    // count consistent with what they'll find inside the trip.
    const preview = buildSharedTripPreview(
      share({
        days: [
          {
            distanceKm: 200,
            waypoints: [
              { id: "a", type: "start" },
              { id: "b", type: "accommodation" },
              { id: "c", type: "end" },
            ],
          },
        ],
      }),
    );
    expect(preview?.stopCount).toBe(1);
  });

  it("returns null when the snapshot is missing days", () => {
    expect(buildSharedTripPreview(share({ name: "broken" }))).toBeNull();
  });

  it("falls back to snapshot.name when share.title is empty", () => {
    const preview = buildSharedTripPreview({
      ...share({
        name: "From snapshot",
        days: [{ distanceKm: 0, waypoints: [] }],
      }),
      title: "",
    });
    expect(preview?.title).toBe("From snapshot");
  });
});
