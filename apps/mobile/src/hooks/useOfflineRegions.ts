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

import { useCallback, useMemo, useState } from "react";
import {
  countTilesForRegion,
  createRNFSDownloader,
  downloadRegion,
  getDefaultDocsDir,
  MAX_TILES_PER_REGION,
  regionDir,
  type BBox,
  type OfflineRegionSpec,
  type TileDownloader,
} from "@/services/offlineRegions";
import { useOfflineStore } from "@/stores";

// ── Module-level download registry ──
// Ownership of in-flight downloads lives at MODULE scope, not in per-hook refs,
// so a download outlives the screen mount that started it. A rider can start a
// download, tap Back (this hook unmounts), reopen the screen (a fresh hook
// instance mounts), and then lose `offline_maps` — the new instance's
// revocation effect must be able to cancel the job the PRIOR mount started.
// Hook-local refs couldn't reach it; these shared maps can. There is only ever
// one OfflineRegionsScreen at a time, so a single shared registry is correct
// (the serial-pipeline `busy` guard still enforces one active download).
//
//   - `cancelFlags`: per-region abort flag the downloader polls between tiles.
//     Setting it true aborts the loop at its next `isCancelled()` check,
//     leaving already-downloaded tiles intact for a later retry.
//   - `runPromises`: per-region in-flight run promise `deleteRegion` awaits so a
//     delete-while-downloading doesn't race the loop into orphaned tile files.
const cancelFlags = new Map<string, boolean>();
const runPromises = new Map<string, Promise<void>>();

/**
 * Abort every in-flight download, regardless of which screen mount started it.
 * The screen gate calls this when `offline_maps` is revoked so the paid
 * pipeline stops consuming bandwidth/disk the instant access is lost — reaching
 * jobs started by earlier mounts that a hook-local registry would have missed.
 */
export function cancelAllOfflineDownloads(): void {
  for (const id of cancelFlags.keys()) cancelFlags.set(id, true);
}

/** Test reset — clear the shared registry between cases. */
export function __resetOfflineDownloadRegistryForTest(): void {
  cancelFlags.clear();
  runPromises.clear();
}

export type AddRegionOutcome =
  | { ok: true; regionId: string }
  | {
      ok: false;
      reason: "too-many-tiles" | "invalid-bbox" | "busy";
      tileCount: number;
    };

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
  /**
   * Abort every in-flight download. Used by the screen gate when the
   * `offline_maps` entitlement is revoked mid-download so the paid pipeline
   * stops consuming bandwidth/disk the instant access is lost.
   */
  cancelAllDownloads: () => void;
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
  // `cancelFlags` / `runPromises` are the MODULE-level registry declared above,
  // shared across every mount of this hook — reads/writes below are synchronous
  // (no re-render between a cancel tap and the next tile check).

  // NOTE: downloads are intentionally NOT cancelled on unmount. A rider who
  // starts a large region download and taps Back to the map expects it to keep
  // running (the fire-and-forget loops in `runDownload` survive the screen pop),
  // and killing them on every unmount would strand thousands-of-tile downloads
  // whenever the rider leaves this screen. Revocation of `offline_maps` mid-
  // download is instead handled by the screen gate calling `cancelAllDownloads`
  // on the true->false transition. Because the registry is module-level, that
  // cancel reaches downloads started by a PRIOR mount too (start → Back →
  // reopen → lose access), which a hook-local registry could not.

  const downloader = useMemo(() => {
    if (deps.downloader) return deps.downloader;
    // Lazily required for the same reason `createRNFSDownloader` lazily
    // requires RNFS: `typedClient` pulls in the keychain and MMKV native
    // bindings, and this hook must stay importable under Jest (where tests
    // always inject `deps.downloader` and never reach this branch).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAccessToken } =
      require("@/services/typedClient") as typeof import("@/services/typedClient");
    // The getter, not a token: a region download runs for minutes and the
    // adapter reads it per tile, so a rotation mid-download is picked up
    // rather than baked in (#1279).
    return createRNFSDownloader(getAccessToken);
  }, [deps.downloader]);
  const docsDir = useMemo(
    () => deps.docsDir ?? getDefaultDocsDir(),
    [deps.docsDir],
  );
  const now = deps.now ?? Date.now;

  const runDownload = useCallback(
    (spec: OfflineRegionSpec): Promise<void> => {
      setActiveRegionId(spec.id);
      beginDownload(spec.id);
      cancelFlags.set(spec.id, false);

      const work = (async () => {
        try {
          const result = await downloadRegion({
            spec,
            docsDir,
            downloader,
            isCancelled: () => cancelFlags.get(spec.id) === true,
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
        } catch {
          // Unexpected throws from the downloader adapter shouldn't leave
          // the region stuck on "downloading". Route them through the
          // regular failed path so the UI shows an actionable retry.
          finishDownload(spec.id, {
            status: "failed",
            downloaded: 0,
            failed: 0,
            bytesOnDisk: 0,
            // Downloader diagnostics are intentionally not persisted. The
            // screen translates this stable reason using the current locale.
            error: { code: "download-failed" },
          });
        } finally {
          cancelFlags.delete(spec.id);
          runPromises.delete(spec.id);
          setActiveRegionId((curr) => (curr === spec.id ? null : curr));
        }
      })();

      runPromises.set(spec.id, work);
      return work;
    },
    [downloader, docsDir, beginDownload, updateProgress, finishDownload],
  );

  const saveRegion = useCallback<UseOfflineRegionsResult["saveRegion"]>(
    async (name, bbox, minZoom, maxZoom) => {
      // Serial pipeline: refuse a second save while one's in flight. The
      // module header explains why — mobile bandwidth is bottlenecked and
      // the backend rate-limits aggressive parallel tile bursts — and
      // without this guard two quick taps would spawn parallel downloads,
      // leaving `activeRegionId` pointing at only the last one started.
      if (runPromises.size > 0) {
        return { ok: false, reason: "busy", tileCount: 0 };
      }

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
      if (tileCount === 0 || tileCount > MAX_TILES_PER_REGION) {
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
      if (cancelFlags.has(regionId)) {
        cancelFlags.set(regionId, true);
      }
    },
    [],
  );

  const cancelAllDownloads = useCallback<
    UseOfflineRegionsResult["cancelAllDownloads"]
  >(() => cancelAllOfflineDownloads(), []);

  const deleteRegion = useCallback<UseOfflineRegionsResult["deleteRegion"]>(
    async (regionId) => {
      // If a download is in flight we MUST stop the loop and wait for it
      // to return before touching the filesystem. Otherwise the loop would
      // keep calling `ensureDir` + `downloadTile` after we've rm'd the
      // directory, orphaning tile files that the UI can no longer reach.
      const active = runPromises.get(regionId);
      if (active) {
        cancelFlags.set(regionId, true);
        // `active` never rejects — the inner try/catch in runDownload
        // routes everything through `finishDownload` — so awaiting is safe.
        await active;
      }

      // Best-effort disk cleanup. If this fails we still drop the store
      // entry so the rider's intent wins; a future launch can GC the
      // stragglers by walking the on-disk region-id set against the store.
      try {
        await downloader.removeDir(regionDir(docsDir, regionId));
      } catch {
        // Ignore — tiles might not exist yet (region never downloaded)
        // or the FS might be temporarily unhappy.
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
    cancelAllDownloads,
    deleteRegion,
  };
}
