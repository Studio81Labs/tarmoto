import type { Trip } from "@/lib/types";

/**
 * Strip client-only day fields before a trip is serialized into a share-link or
 * mobile-push snapshot. `qualitySegments` (#862) duplicates line geometry per
 * segment — thousands on a long covered route — so shipping it verbatim can
 * push the snapshot past the backend's `MAX_TRIP_SNAPSHOT_BYTES` (1 MB) and
 * would store client-only data in a public snapshot. It's re-fetched on load,
 * never part of the share contract.
 */
export function tripSnapshotForSharing(trip: Trip): Trip {
  return {
    ...trip,
    days: trip.days.map((day) => {
      const shared = { ...day };
      delete shared.qualitySegments;
      return shared;
    }),
  };
}
