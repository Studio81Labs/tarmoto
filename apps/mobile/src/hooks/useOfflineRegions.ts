/**
 * Hook that drives the offline-region download lifecycle (US-18 AC #1).
 *
 * The Zustand store holds the durable list of regions; this hook wires
 * it to the tile downloader in `services/offlineRegions.ts`. Everything
 * UI-facing (start, retry, delete, current download state) lives here
 * so the screen stays a thin render layer.
 *
 * Design notes:
 *   - Only one region downloads at a time. Mobile links are bottlenecked
 *     and the backend rate-limits aggressive map-tile bursts; a serial
 *     pipeline is simpler than a worker pool and matches the sensor-
 *     upload queue's ergonomics.
 *   - Cancellation flips a ref the downloader polls between tiles, so
 *     an abort leaves already-downloaded tiles intact for a later retry.
 *   - Progress is funnelled into the store through `updateProgress` at
 *     most once per tile; with `MAX_TILES_PER_REGION` at 5000 that's an
 *     acceptable write rate for MMKV.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  countTilesForRegion,
  createRNFSDownloader,
  downloadRegion,
  getDefaultDocsDir,
  regionDir,
  type BBox,
  type OfflineRegionSpec,
  type TileDownloader,
} from "@/services/offlineRegions";
import { useOfflineStore } from "@/stores";

export type AddRegionOutcome =
  | { ok: true; regionId: string }
  | { ok: false; reason: "too-many-tiles" | "invalid-bbox"; tileCount: number };

interface UseOfflineRegionsDeps {
  /** Injected in tests so jest doesn't touch the native FS binding. */
  downloader?: TileDownloader;
  /** Injected in tests so we don't hit `DocumentDirectoryPath`. */
  docsDir?: string;
  /** Clock override — keeps generated ids deterministic in tests. */
  now?: () => number;
}

export interface UseOfflineRegionsResult {
  regions: ReturnType<typeof useOfflineStore.getState>["regions"];
  /** Id of the region currently downloading, if any. */
  activeRegionId: string | null;
  /**
   * Register a region and start its download immediately. Returns early
   * with a diagnostic when the bbox would overrun our tile budget.
   */
  saveRegion: (
    name: string,
    bbox: BBox,
    minZoom: number,
    maxZoom: number,
  ) => Promise<AddRegionOutcome>;
  /** Re-run the download for an existing region (only makes sense on failed). */
  retryRegion: (regionId: string) => Promise<void>;
  /** Abort the in-progress download for `regionId`. No-op otherwise. */
  cancelDownload: (regionId: string) => void;
  /** Remove a region from the list and delete its on-disk tiles. */
  deleteRegion: (regionId: string) => Promise<void>;
}

export function useOfflineRegions(
  deps: UseOfflineRegionsDeps = {},
): UseOfflineRegionsResult {
  const regions = useOfflineStore((s) => s.regions);
  const addRegion = useOfflineStore((s) => s.addRegion);
  const beginDownload = useOfflineStore((s) => s.beginDownload);
  const updateProgress = useOfflineStore((s) => s.updateProgress);
  const finishDownload = useOfflineStore((s) => s.finishDownload);
  const removeRegion = useOfflineStore((s) => s.removeRegion);
  const getRegion = useOfflineStore((s) => s.getRegion);

  const [activeRegionId, setActiveRegionId] = useState<string | null>(null);
  // Cancellation flag per region id. Using a ref-backed map keeps cancel()
  // synchronous (no re-render between the tap and the next tile check).
  const cancelFlags = useRef<Map<string, boolean>>(new Map());

  const downloader = useMemo(
    () => deps.downloader ?? createRNFSDownloader(),
    [deps.downloader],
  );
  const docsDir = useMemo(
    () => deps.docsDir ?? getDefaultDocsDir(),
    [deps.docsDir],
  );
  const now = deps.now ?? Date.now;

  const runDownload = useCallback(
    async (spec: OfflineRegionSpec) => {
      setActiveRegionId(spec.id);
      beginDownload(spec.id);
      cancelFlags.current.set(spec.id, false);

      try {
        const result = await downloadRegion({
          spec,
          docsDir,
          downloader,
          isCancelled: () => cancelFlags.current.get(spec.id) === true,
          onProgress: (update) => {
            updateProgress(spec.id, {
              downloaded: update.downloaded,
              failed: update.failed,
              bytesOnDisk: update.bytesOnDisk,
            });
          },
        });

        finishDownload(spec.id, {
          status: result.status,
          downloaded: result.downloaded,
          failed: result.failed,
          bytesOnDisk: result.bytesOnDisk,
          error: result.error,
        });
      } catch (err) {
        // Unexpected throws from the downloader adapter shouldn't leave
        // the region stuck on "downloading". Route them through the
        // regular failed path so the UI shows an actionable retry.
        finishDownload(spec.id, {
          status: "failed",
          downloaded: 0,
          failed: 0,
          bytesOnDisk: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        cancelFlags.current.delete(spec.id);
        setActiveRegionId((curr) => (curr === spec.id ? null : curr));
      }
    },
    [downloader, docsDir, beginDownload, updateProgress, finishDownload],
  );

  const saveRegion = useCallback<UseOfflineRegionsResult["saveRegion"]>(
    async (name, bbox, minZoom, maxZoom) => {
      if (
        !Number.isFinite(bbox.west) ||
        !Number.isFinite(bbox.east) ||
        !Number.isFinite(bbox.south) ||
        !Number.isFinite(bbox.north) ||
        bbox.west >= bbox.east ||
        bbox.south >= bbox.north
      ) {
        return { ok: false, reason: "invalid-bbox", tileCount: 0 };
      }

      const tileCount = countTilesForRegion(bbox, minZoom, maxZoom);
      // The downloader will also reject over-cap specs, but catching it
      // here keeps the error off the store (no half-registered region).
      // The UI uses the returned count to phrase the message.
      if (tileCount === 0 || tileCount > 5000) {
        return {
          ok: false,
          reason: "too-many-tiles",
          tileCount,
        };
      }

      const spec: OfflineRegionSpec = {
        id: `region-${now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        name,
        bbox,
        minZoom,
        maxZoom,
        createdAt: now(),
      };
      addRegion(spec, tileCount);

      // Fire and forget — the store already reflects the pending region,
      // so the list re-renders immediately with a progress row. Awaiting
      // here would block the caller's UI handler for the entire download.
      void runDownload(spec);

      return { ok: true, regionId: spec.id };
    },
    [addRegion, now, runDownload],
  );

  const retryRegion = useCallback<UseOfflineRegionsResult["retryRegion"]>(
    async (regionId) => {
      const region = getRegion(regionId);
      if (!region) return;
      await runDownload(region);
    },
    [getRegion, runDownload],
  );

  const cancelDownload = useCallback<UseOfflineRegionsResult["cancelDownload"]>(
    (regionId) => {
      if (cancelFlags.current.has(regionId)) {
        cancelFlags.current.set(regionId, true);
      }
    },
    [],
  );

  const deleteRegion = useCallback<UseOfflineRegionsResult["deleteRegion"]>(
    async (regionId) => {
      // Best-effort disk cleanup first so a store remove followed by a
      // FS failure doesn't orphan the tiles — the store is the "source
      // of truth" and losing regions here matches the rider's intent.
      try {
        await downloader.removeDir(regionDir(docsDir, regionId));
      } catch {
        // Ignore — tiles might not exist yet (region never downloaded)
        // or the FS might be temporarily unhappy. Either way the store
        // entry should still go away to match user intent.
      }
      removeRegion(regionId);
    },
    [downloader, docsDir, removeRegion],
  );

  return {
    regions,
    activeRegionId,
    saveRegion,
    retryRegion,
    cancelDownload,
    deleteRegion,
  };
}
