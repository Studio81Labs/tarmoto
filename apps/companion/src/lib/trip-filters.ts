import type { Trip, TripSummary } from "@/lib/types";
import {
  localeSearchIncludes,
  normalizeForLocaleSearch,
} from "@tarmoto/shared";

export type TripStatus = TripSummary["status"];

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
//   "unfiled"  → trips with no folder_id
//   string id  → trips assigned to that folder
// Kept as a discriminated shape rather than `string | null` so callers can't
// confuse "all" with "unfiled".
export type FolderScope =
  { kind: "all" } | { kind: "unfiled" } | { kind: "folder"; id: string };

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

/**
 * List-page filter pipeline. Types against `TripSummary` because the
 * list endpoint (`GET /api/v1/trips`) only returns summary fields —
 * `description`, `collaborators`, `updatedAt`, and `days` aren't on
 * the wire here. Detail-only sort/search would have been silently
 * broken on real list data before the type split; we now lean on
 * the compiler to keep the comparator honest.
 */
export function applyTripFilters(
  trips: readonly TripSummary[],
  filters: TripFilters,
  locale: string,
): TripSummary[] {
  const needle = normalizeForLocaleSearch(filters.search, locale);

  const filtered = trips.filter((trip) => {
    if (!filters.statuses.has(trip.status)) return false;

    const scope = filters.folderScope;
    if (scope.kind === "unfiled" && trip.folder_id) return false;
    if (scope.kind === "folder" && trip.folder_id !== scope.id) return false;

    if (needle && !localeSearchIncludes(trip.name, needle, locale))
      return false;
    return true;
  });

  return sortTrips(filtered, filters.sort, locale);
}

function sortTrips(
  trips: TripSummary[],
  sort: TripSortKey,
  locale: string,
): TripSummary[] {
  const copy = trips.slice();
  switch (sort) {
    case "updated":
      // Summary rows don't carry `updated_at` — the wire dto omits
      // it. Fall back to `createdAt` so "newest first" still does
      // something sensible (was producing `NaN` sort keys before
      // the type split silently). Trip detail pages still have
      // `updatedAt` for surfaces that need the real value.
      copy.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
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
        a.name.localeCompare(b.name, locale, { sensitivity: "base" }),
      );
      return copy;
    case "distance":
      // List rows don't have per-day distance either — leave the
      // sort key visible (no UI change) but no-op on the comparator
      // so the order stays whatever the filter step produced. The
      // detail-only `tripDistanceKm` helper below still works for
      // surfaces that DO have day data.
      return copy;
    default: {
      const _exhaustive: never = sort;
      void _exhaustive;
      return copy;
    }
  }
}

/**
 * Detail-only — sums per-day distance. Typed against `Trip`
 * (= `TripDetail`) because `days` only exists on the detail
 * response. Surfaces that need a list-row distance get `null`
 * (it isn't on the wire) rather than a misleading `0`.
 */
export function tripDistanceKm(trip: Trip): number {
  return trip.days.reduce((sum, d) => sum + d.distanceKm, 0);
}

/**
 * Summary-aware variant: list-endpoint payloads don't carry
 * `days`, so per-day distance is genuinely unknown there.
 * Returning `null` lets cards / chips hide the distance row
 * instead of rendering a confidently-wrong `0 km`. Detail
 * surfaces should call `tripDistanceKm` directly.
 */
export function tripDistanceKmOrNull(_trip: TripSummary): number | null {
  return null;
}

// Returns how many trips sit in each status, regardless of the current search
// or folder scope. Used by the status filter chips to show counts.
export function countByStatus(
  trips: readonly TripSummary[],
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

/**
 * Trips that count against `max_active_trips`, mirroring the backend rule
 * (`apps/backend/src/modules/trips/trips.service.ts` OPEN_TRIP_STATUSES):
 * owner-held trips in draft/planned/active — NOT completed.
 */
const OPEN_TRIP_STATUSES: readonly TripStatus[] = [
  "draft",
  "planned",
  "active",
];

export function countOpenOwnedTrips(
  trips: readonly TripSummary[],
  userId: string | null,
): number {
  if (!userId) return 0;
  return trips.filter(
    (t) => t.owner_id === userId && OPEN_TRIP_STATUSES.includes(t.status),
  ).length;
}
