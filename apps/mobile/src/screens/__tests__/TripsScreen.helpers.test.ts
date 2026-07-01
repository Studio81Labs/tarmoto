import { groupTripsByFolder } from "../TripsScreen.helpers";
import type { TripFolder, TripSummary } from "@/types";

function trip(overrides: Partial<TripSummary> = {}): TripSummary {
  return {
    id: overrides.id ?? "t1",
    title: overrides.title ?? "Loop",
    region: overrides.region ?? null,
    num_days: overrides.num_days ?? 1,
    status: overrides.status ?? "planned",
    member_count: overrides.member_count ?? 1,
    ...(overrides.folder_id !== undefined
      ? { folder_id: overrides.folder_id }
      : {}),
    created_at: overrides.created_at ?? "2026-04-20T10:00:00Z",
  };
}

function folder(overrides: Partial<TripFolder> = {}): TripFolder {
  return {
    id: overrides.id ?? "f1",
    user_id: overrides.user_id ?? "u1",
    name: overrides.name ?? "Alps",
    color: overrides.color ?? null,
    position: overrides.position ?? 0,
    created_at: overrides.created_at ?? "2026-04-01T10:00:00Z",
    updated_at: overrides.updated_at ?? "2026-04-01T10:00:00Z",
  };
}

describe("groupTripsByFolder", () => {
  it("returns a flat list (no headers) when the rider has no folders", () => {
    const trips = [trip({ id: "a" }), trip({ id: "b" })];
    const rows = groupTripsByFolder(trips, []);
    // Without folders, headers would just be visual noise. The rider's
    // entire library lives in one bucket.
    expect(rows).toEqual([
      { kind: "trip", key: "trip-a", trip: trips[0] },
      { kind: "trip", key: "trip-b", trip: trips[1] },
    ]);
  });

  it("emits Unfiled before named folders, in folder.position order", () => {
    const folders = [
      folder({ id: "alps", name: "Alps", position: 1 }),
      folder({ id: "beskydy", name: "Beskydy", position: 0 }),
    ];
    const trips = [
      trip({ id: "u1" }),
      trip({ id: "a1", folder_id: "alps" }),
      trip({ id: "b1", folder_id: "beskydy" }),
    ];
    const rows = groupTripsByFolder(trips, folders);
    const keys = rows.map((r) => r.key);
    // Unfiled bubbles to the top so a fresh import is one tap away;
    // named folders follow in their server-assigned position.
    expect(keys).toEqual([
      "header-unfiled",
      "trip-u1",
      "header-beskydy",
      "trip-b1",
      "header-alps",
      "trip-a1",
    ]);
  });

  it("collapses trips with a stale folder_id into Unfiled (folder deleted on another device)", () => {
    const folders = [
      folder({ id: "f-live", name: "Live folder", position: 0 }),
    ];
    const trips = [
      trip({ id: "live", folder_id: "f-live" }),
      // The folder this trip points at no longer exists in the
      // caller's folder list — without the fallback it would render
      // under no header at all and confuse the rider.
      trip({ id: "stale", folder_id: "f-deleted" }),
    ];
    const rows = groupTripsByFolder(trips, folders);
    expect(rows.map((r) => r.key)).toEqual([
      "header-unfiled",
      "trip-stale",
      "header-f-live",
      "trip-live",
    ]);
  });

  it("emits empty folders as headers with count 0", () => {
    const folders = [folder({ id: "empty", name: "Empty", position: 0 })];
    const rows = groupTripsByFolder([], folders);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      kind: "folder-header",
      key: "header-empty",
      label: "Empty",
      count: 0,
    });
  });

  it("suppresses the Unfiled header when every trip is in a folder", () => {
    const folders = [folder({ id: "f1", name: "F1", position: 0 })];
    const trips = [
      trip({ id: "a", folder_id: "f1" }),
      trip({ id: "b", folder_id: "f1" }),
    ];
    const rows = groupTripsByFolder(trips, folders);
    // No `header-unfiled` row when there are no unfiled trips —
    // dropping the empty section keeps the list compact.
    expect(rows.map((r) => r.kind)).toEqual(["folder-header", "trip", "trip"]);
  });

  it("preserves API-delivered trip order within each folder", () => {
    const folders = [folder({ id: "f1", name: "F1", position: 0 })];
    const trips = [
      trip({ id: "newest", folder_id: "f1" }),
      trip({ id: "older", folder_id: "f1" }),
    ];
    const rows = groupTripsByFolder(trips, folders);
    // The API already sorts by created_at DESC; re-sorting client-side
    // would just create drift between mobile and companion order.
    expect(rows.filter((r) => r.kind === "trip").map((r) => r.key)).toEqual([
      "trip-newest",
      "trip-older",
    ]);
  });
});
