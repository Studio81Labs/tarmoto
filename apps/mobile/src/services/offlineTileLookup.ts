/**
 * Offline tile lookup — US-18 AC #3 "Road quality overlay available offline".
 *
 * `services/offlineRegions.ts` is responsible for putting tile bytes on disk
 * at `<docsDir>/offline-tiles/<regionId>/<z>/<x>/<y>.mvt`. This module is the
 * read-side counterpart: given the current map viewport plus the list of
 * regions the rider has cached, pick the best region to serve from and build
 * the `file://` URL template MapLibre's `VectorSource` needs.
 *
 * Pure helpers on purpose — no `react-native-fs`, no MapLibre. Keeps this
 * testable in Jest and prevents accidental cross-import of the downloader
 * side (which requires native bindings).
 */

import type { BBox, OfflineRegion } from "./offlineRegions";
import { OFFLINE_ROOT_DIRNAME } from "./offlineRegions";
import type { LatLng } from "@/types";

/**
 * True when the point (lng, lat) is inside the closed bbox. Edges count as
 * inside — a rider parked exactly on the western edge of their cached
 * region should still see the overlay.
 */
export function bboxContains(bbox: BBox, lng: number, lat: number): boolean {
  return (
    lng >= bbox.west &&
    lng <= bbox.east &&
    lat >= bbox.south &&
    lat <= bbox.north
  );
}

/**
 * Pick the region whose cached tiles should feed the quality overlay right
 * now, if any. A region is eligible when:
 *
 *   - Its download is `"complete"` — partially-downloaded regions would
 *     show holes where MapLibre asked for a missing tile, which reads as a
 *     bug rather than a partial cache.
 *   - The current zoom is within the region's `[minZoom, maxZoom]` —
 *     outside this window the rider would see blank tiles where no cached
 *     bytes exist.
 *   - The map's centre coordinate falls inside the region's bbox.
 *
 * Tiebreak: most-recently-updated region wins. Riders typically cache a
 * fresh region right before a trip, so "newest covering this spot" is a
 * reliable proxy for "intentional for this trip".
 */
export function findBestOfflineRegion(
  regions: readonly OfflineRegion[],
  center: LatLng,
  zoom: number,
): OfflineRegion | null {
  let best: OfflineRegion | null = null;
  let bestTs = -Infinity;
  for (const region of regions) {
    if (region.status !== "complete") continue;
    if (zoom < region.minZoom || zoom > region.maxZoom) continue;
    if (!bboxContains(region.bbox, center.lng, center.lat)) continue;
    // `lastUpdatedAt` is `null` for regions that never ticked progress
    // (shouldn't happen for a complete region, but don't trust it) — fall
    // back to `createdAt` so the tiebreak is still deterministic.
    const ts = region.lastUpdatedAt ?? region.createdAt;
    if (ts > bestTs) {
      best = region;
      bestTs = ts;
    }
  }
  return best;
}

/**
 * Build the `file://` tile URL template for MapLibre's `VectorSource`.
 * MapLibre substitutes `{z}/{x}/{y}` at fetch time, so the layout here has
 * to mirror `tilePath()` in `offlineRegions.ts` exactly — drift between the
 * writer and the reader would silently serve 404s.
 *
 * The template intentionally omits the `?layers=quality` query string that
 * the online URL carries: cached bytes on disk already contain just the
 * quality layer, so re-appending the query would only confuse MapLibre's
 * cache keys.
 */
export function offlineTileUrlTemplate(
  docsDir: string,
  regionId: string,
): string {
  return `file://${docsDir}/${OFFLINE_ROOT_DIRNAME}/${regionId}/{z}/{x}/{y}.mvt`;
}
