/**
 * Coverage for the shared-trip import helpers (US-39 / #283).
 * Validates the snapshot → preview / import-request mapping the deep-link
 * landing screen relies on.
 */

import {
  buildSharedTripPreview,
  sharedSnapshotToImportRequest,
} from "../sharedTripImport";
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
  it("rolls per-day distance and waypoint counts up to a single preview row", () => {
    const preview = buildSharedTripPreview(
      share({
        days: [
          {
            distanceKm: 120,
            waypoints: [{ id: "a" }, { id: "b" }],
          },
          {
            distanceKm: 80,
            waypoints: [{ id: "c" }],
          },
        ],
      }),
    );
    expect(preview).toEqual({
      title: "Alps loop — demo",
      ownerName: "Adam",
      dayCount: 2,
      totalDistanceKm: 200,
      waypointCount: 3,
    });
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

describe("sharedSnapshotToImportRequest", () => {
  it("flattens day route geometry across all days", () => {
    const request = sharedSnapshotToImportRequest(
      share({
        days: [
          {
            routeGeometry: {
              coordinates: [
                [10.0, 46.0],
                [10.1, 46.05],
              ],
            },
            waypoints: [],
          },
          {
            routeGeometry: {
              coordinates: [
                [10.2, 46.1],
                [10.3, 46.15],
              ],
            },
            waypoints: [],
          },
        ],
      }),
    );
    expect(request).not.toBeNull();
    expect(request!.geometry).toEqual([
      { lat: 46.0, lng: 10.0 },
      { lat: 46.05, lng: 10.1 },
      { lat: 46.1, lng: 10.2 },
      { lat: 46.15, lng: 10.3 },
    ]);
    expect(request!.source_format).toBe("gpx");
  });

  it("collects waypoints from each day with name passthrough", () => {
    const request = sharedSnapshotToImportRequest(
      share({
        days: [
          {
            routeGeometry: {
              coordinates: [
                [10, 46],
                [11, 47],
              ],
            },
            waypoints: [
              {
                location: { lat: 46.4, lng: 10.4 },
                name: "Bormio",
                type: "start",
              },
              { location: { lat: 46.5, lng: 10.5 }, type: "via" },
            ],
          },
        ],
      }),
    );
    expect(request!.waypoints).toEqual([
      { lat: 46.4, lng: 10.4, name: "Bormio" },
      { lat: 46.5, lng: 10.5, name: undefined },
    ]);
  });

  it("falls back to waypoint coordinates when no day carries route geometry", () => {
    const request = sharedSnapshotToImportRequest(
      share({
        days: [
          {
            waypoints: [
              { location: { lat: 1, lng: 2 }, name: "A", type: "start" },
              { location: { lat: 3, lng: 4 }, name: "B", type: "end" },
            ],
          },
        ],
      }),
    );
    expect(request).not.toBeNull();
    expect(request!.geometry).toEqual([
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
    ]);
  });

  it("returns null when neither geometry nor waypoints make a 2-point line", () => {
    expect(
      sharedSnapshotToImportRequest(
        share({
          days: [
            { waypoints: [{ location: { lat: 1, lng: 2 }, type: "start" }] },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("returns null when the snapshot shape is unrecognised", () => {
    expect(
      sharedSnapshotToImportRequest(share({ unrelated: true })),
    ).toBeNull();
  });

  it("skips malformed coordinate entries instead of throwing", () => {
    const request = sharedSnapshotToImportRequest(
      share({
        days: [
          {
            routeGeometry: {
              coordinates: [
                [10.0, 46.0],
                ["bad", "data"],
                [10.1, 46.05],
                null,
                [10.2, 46.1],
              ],
            },
            waypoints: [],
          },
        ],
      }),
    );
    expect(request!.geometry).toEqual([
      { lat: 46.0, lng: 10.0 },
      { lat: 46.05, lng: 10.1 },
      { lat: 46.1, lng: 10.2 },
    ]);
  });
});
