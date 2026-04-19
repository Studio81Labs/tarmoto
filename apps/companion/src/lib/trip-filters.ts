import type { Trip } from "@/lib/types";

export type TripStatus = Trip["status"];

export const TRIP_STATUSES: readonly TripStatus[] = [
  "draft",
  "planned",
  "active",
  "completed",
] as const;

export type TripSortKey = "updated" | "created" | "name" | "distance";

export const TRIP_SORT_KEYS: readonly TripSortKey[] = [
  "updated",
  "created",
  "name",
  "distance",
] as const;

// `folderScope` mirrors the left-sidebar in the trips page:
//   "all"      → every trip
//   "unfiled"  → trips with no folderId
//   string id  → trips assigned to that folder
// Kept as a discriminated shape rather than `string | null` so callers can't
// confuse "all" with "unfiled".
export type FolderScope =
  | { kind: "all" }
  | { kind: "unfiled" }
  | { kind: "folder"; id: string };

export interface TripFilters {
  search: string;
  statuses: Set<TripStatus>;
  folderScope: FolderScope;
  sort: TripSortKey;
}

export const DEFAULT_TRIP_FILTERS: TripFilters = {
  search: "",
  statuses: new Set(TRIP_STATUSES),
  folderScope: { kind: "all" },
  sort: "updated",
};

export function applyTripFilters(
  trips: readonly Trip[],
  filters: TripFilters,
): Trip[] {
  const needle = filters.search.trim().toLowerCase();

  const filtered = trips.filter((trip) => {
    if (!filters.statuses.has(trip.status)) return false;

    const scope = filters.folderScope;
    if (scope.kind === "unfiled" && trip.folderId) return false;
    if (scope.kind === "folder" && trip.folderId !== scope.id) return false;

    if (needle) {
      const hay = [
        trip.name,
        trip.description ?? "",
        ...trip.collaborators.map((c) => c.displayName),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  return sortTrips(filtered, filters.sort);
}

function sortTrips(trips: Trip[], sort: TripSortKey): Trip[] {
  const copy = trips.slice();
  switch (sort) {
    case "updated":
      copy.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      return copy;
    case "created":
      copy.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      return copy;
    case "name":
      copy.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
      return copy;
    case "distance":
      copy.sort((a, b) => tripDistanceKm(b) - tripDistanceKm(a));
      return copy;
  }
}

export function tripDistanceKm(trip: Trip): number {
  return trip.days.reduce((sum, d) => sum + d.distanceKm, 0);
}

// Returns how many trips sit in each status, regardless of the current search
// or folder scope. Used by the status filter chips to show counts.
export function countByStatus(
  trips: readonly Trip[],
): Record<TripStatus, number> {
  const counts: Record<TripStatus, number> = {
    draft: 0,
    planned: 0,
    active: 0,
    completed: 0,
  };
  for (const t of trips) counts[t.status] += 1;
  return counts;
}
