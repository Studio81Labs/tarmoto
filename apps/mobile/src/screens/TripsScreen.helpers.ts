import type { TripFolder, TripSummary } from "@/types";

/**
 * Row variants the mobile trips list renders. The list is a flat
 * `FlatList` driven by these row entries rather than `SectionList`,
 * because we need the folder headers to interleave with an "Unfiled"
 * pseudo-bucket whose name isn't stored server-side. Building the rows
 * upfront keeps the renderer branch-free.
 */
export type TripsListRow =
  | {
      kind: "folder-header";
      key: string;
      /** Null identifies the locale-owned Unfiled pseudo-folder. */
      label: string | null;
      count: number;
    }
  | { kind: "trip"; key: string; trip: TripSummary };

/**
 * US-37 — group the trips list under their folder headers for the
 * mobile read-only display.
 *
 * Ordering rules (chosen to match the companion sidebar so a rider
 * sees the same shape on either device):
 *   1. Folders are emitted in their server-allocated `position` order.
 *   2. Within each folder, trips keep the order delivered by the API
 *      (which sorts by `created_at DESC`). We don't re-sort here.
 *   3. Trips with no `folder_id`, or with a `folder_id` referencing a
 *      folder the caller can no longer see (deleted on another device,
 *      not yet propagated, etc.) collapse into the "Unfiled" bucket so
 *      they don't disappear from the list.
 *   4. The "Unfiled" header is suppressed when there are no folders at
 *      all — a flat trip list doesn't need a header.
 *
 * Folders that contain zero trips are still emitted as headers (with
 * count 0) so the rider can see that the folder exists on this device
 * even when empty — matches the companion's empty-folder behavior.
 */
export function groupTripsByFolder(
  trips: readonly TripSummary[],
  folders: readonly TripFolder[],
): TripsListRow[] {
  const sortedFolders = folders.slice().sort((a, b) => a.position - b.position);
  const folderById = new Map(sortedFolders.map((f) => [f.id, f]));

  const tripsByFolder = new Map<string, TripSummary[]>();
  const unfiled: TripSummary[] = [];
  for (const trip of trips) {
    if (trip.folder_id && folderById.has(trip.folder_id)) {
      const list = tripsByFolder.get(trip.folder_id) ?? [];
      list.push(trip);
      tripsByFolder.set(trip.folder_id, list);
    } else {
      unfiled.push(trip);
    }
  }

  const rows: TripsListRow[] = [];

  if (sortedFolders.length === 0) {
    // No folders → flat list, no headers.
    for (const trip of trips) {
      rows.push({ kind: "trip", key: `trip-${trip.id}`, trip });
    }
    return rows;
  }

  // Unfiled goes first to mirror the companion left-rail order ("All
  // trips" / "Unfiled" before the named folders) — riders glance at
  // their bucket of fresh imports before drilling into a folder.
  if (unfiled.length > 0) {
    rows.push({
      kind: "folder-header",
      key: "header-unfiled",
      label: null,
      count: unfiled.length,
    });
    for (const trip of unfiled) {
      rows.push({ kind: "trip", key: `trip-${trip.id}`, trip });
    }
  }

  for (const folder of sortedFolders) {
    const folderTrips = tripsByFolder.get(folder.id) ?? [];
    rows.push({
      kind: "folder-header",
      key: `header-${folder.id}`,
      label: folder.name,
      count: folderTrips.length,
    });
    for (const trip of folderTrips) {
      rows.push({ kind: "trip", key: `trip-${trip.id}`, trip });
    }
  }

  return rows;
}
