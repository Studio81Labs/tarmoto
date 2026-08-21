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
  clampRegionMaxZoom,
  isRegionUsableBy,
  regionDir,
  type BBox,
  type OfflineRegionSpec,
  type TileDownloader,
} from "@/services/offlineRegions";
import { getFeatureLimit } from "@tarmoto/shared";
import { useAuthStore, useOfflineStore } from "@/stores";

/**
 * The rider's resolved `road_quality_max_zoom`, read outside React so
 * `saveRegion` can consult it at the moment of the tap (#1279). Same source
 * `useLimit` reads — the entitlement snapshot on the auth store.
 */
function readQualityMaxZoom(): { limit: number | null; isResolved: boolean } {
  const limits = useAuthStore.getState().user?.limits ?? null;
  return {
    limit: limits ? getFeatureLimit(limits, "road_quality_max_zoom") : null,
    isResolved: limits != null,
  };
}

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
  /**
   * Who is signed in right now. A download is bound to the rider who started
   * it (#1279) — see `runDownload`. Injected in tests; the default lazily
   * requires `typedClient` for the same native-binding reason as `downloader`.
   */
  getRiderId?: () => string | null;
  /**
   * The rider's resolved `road_quality_max_zoom`. Injected in tests; the
   * default reads the same entitlement snapshot `useLimit` does.
   */
  getQualityMaxZoom?: () => { limit: number | null; isResolved: boolean };
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
  const allRegions = useOfflineStore((s) => s.regions);
  // Subscribed, not read imperatively: this is what makes the hook re-render
  // when the account changes while a screen stays mounted.
  const storeRiderId = useAuthStore((s) => s.user?.id ?? null);
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

  /**
   * Builds a tile downloader bound to ONE download's rider (#1279).
   *
   * `isOwner` is consulted in the same call that resolves the credential —
   * the adapter's first await — so there is no window between "still the same
   * rider" and "fetch with this bearer". The loop's own `isCancelled` poll
   * covers the gaps between tiles; this covers the gap inside one.
   *
   * Called with no argument for the non-download uses (`removeDir`), where
   * ownership is irrelevant.
   */
  const createDownloader = useMemo(() => {
    if (deps.downloader) {
      const injected = deps.downloader;
      return (): TileDownloader => injected;
    }
    // Lazily required for the same reason `createRNFSDownloader` lazily
    // requires RNFS: `typedClient` pulls in the keychain and MMKV native
    // bindings, and this hook must stay importable under Jest (where tests
    // always inject `deps.downloader` and never reach this branch).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getFreshAccessToken } =
      require("@/services/typedClient") as typeof import("@/services/typedClient");
    return (isOwner: () => boolean = () => true): TileDownloader =>
      // The getter, not a token: a region download runs serially for minutes,
      // the adapter resolves it per tile, and the REFRESH-aware variant is what
      // stops a pack that outlives the access token from finishing anonymously
      // — these raw RNFS requests bypass the typed client's 401 retry (#1279).
      createRNFSDownloader(async () => {
        if (!isOwner()) {
          // Fail the tile rather than returning null: null would fetch it
          // anonymously and write a free-capped tile into this rider's pack.
          // The loop counts the failure and its next poll ends the region
          // `cancelled`.
          throw new Error("Offline download changed rider mid-flight");
        }
        return getFreshAccessToken();
      });
  }, [deps.downloader]);
  const downloader = useMemo(() => createDownloader(), [createDownloader]);
  const docsDir = useMemo(
    () => deps.docsDir ?? getDefaultDocsDir(),
    [deps.docsDir],
  );
  const getRiderId = useMemo(() => {
    if (deps.getRiderId) return deps.getRiderId;
    // Required on CALL, not at memo time — unlike the downloader above, whose
    // branch every test skips by injecting `deps.downloader`. Deferring it
    // keeps merely RENDERING this hook free of the keychain/MMKV bindings, so
    // a test that does not care about session binding needs no new stub.
    return (): string | null => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getAuthenticatedUserId } =
        require("@/services/typedClient") as typeof import("@/services/typedClient");
      return getAuthenticatedUserId();
    };
  }, [deps.getRiderId]);
  const getQualityMaxZoom = deps.getQualityMaxZoom ?? readQualityMaxZoom;
  const now = deps.now ?? Date.now;
  // Only this rider's packs (#1279). Filtering HERE rather than at the screen
  // covers three things at once: the list stops showing another rider's region
  // names, `regions.length` scopes the `max_offline_regions` quota to the rider
  // whose packs they are, and nothing downstream can forget the check.
  // Render-time rider identity. `getRiderId` is an imperative getter with a
  // STABLE function identity, so a memo keyed on it would never recompute when
  // the account changed under a mounted screen — a warm `tarmoto://link-account`
  // navigation over the existing stack does exactly that, and the list would
  // keep showing the previous rider's regions, count them against the new
  // rider's quota, and offer them for deletion. Read the value, not the getter.
  const riderId = deps.getRiderId ? deps.getRiderId() : storeRiderId;
  const regions = useMemo(
    () => allRegions.filter((r) => isRegionUsableBy(r, riderId)),
    [allRegions, riderId],
  );

  const runDownload = useCallback(
    (spec: OfflineRegionSpec): Promise<void> => {
      setActiveRegionId(spec.id);
      beginDownload(spec.id);
      cancelFlags.set(spec.id, false);
      // Bind the download to the rider who STARTED it (#1279). Downloads
      // deliberately survive screen unmounts, and the tile adapter resolves the
      // current bearer per tile — so without this, a sign-out or an account
      // switch mid-download would silently hand the rest of the pack to
      // somebody else's entitlement: a lower cap free-caps the remaining
      // deep-zoom tiles into a pack still marked complete, a higher one lends
      // the first rider access they are not entitled to.
      const ownerId = getRiderId();
      const isOwner = () => getRiderId() === ownerId;

      const work = (async () => {
        try {
          const result = await downloadRegion({
            spec,
            docsDir,
            // Bound to this download's rider, so the credential can never be
            // resolved for anyone else — see `createDownloader`.
            downloader: createDownloader(isOwner),
            // Polled between tiles AND immediately before each request, so a
            // rider change stops the run rather than fetching one more tile
            // under the new entitlement. The region lands `cancelled` —
            // retryable, and never mistaken for a complete pack.
            isCancelled: () => cancelFlags.get(spec.id) === true || !isOwner(),
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
    [
      createDownloader,
      docsDir,
      getRiderId,
      beginDownload,
      updateProgress,
      finishDownload,
    ],
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

      const { limit: qualityMaxZoom, isResolved: qualityMaxZoomResolved } =
        getQualityMaxZoom();
      const cappedMaxZoom = clampRegionMaxZoom(
        maxZoom,
        qualityMaxZoom,
        qualityMaxZoomResolved,
      );
      const tileCount = countTilesForRegion(bbox, minZoom, cappedMaxZoom);
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
        // Never deeper than this rider may see (#1279). Packs hold quality
        // tiles only, and the backend withholds that layer above their cap —
        // so requesting past it spends a round trip per tile to be handed a
        // 204 that is neither data nor an error. See `clampRegionMaxZoom`.
        maxZoom: cappedMaxZoom,
        createdAt: now(),
        // Stamped at registration so the pack stays attributable for its whole
        // life, not just for this download run (#1279).
        ownerId: getRiderId(),
      };
      addRegion(spec, tileCount);

      // Fire and forget — the store already reflects the pending region,
      // so the list re-renders immediately with a progress row. Awaiting
      // here would block the caller's UI handler for the entire download.
      void runDownload(spec);

      return { ok: true, regionId: spec.id };
    },
    [addRegion, getQualityMaxZoom, getRiderId, now, runDownload],
  );

  const retryRegion = useCallback<UseOfflineRegionsResult["retryRegion"]>(
    async (regionId) => {
      const region = getRegion(regionId);
      if (!region) return;
      // Resuming ANOTHER rider's pack would be the worst version of the
      // cross-rider problem: `tileExists` skips everything already fetched
      // under them, so the retry would top up their tiles with this rider's
      // and hand back a pack that is half somebody else's entitlement (#1279).
      if (!isRegionUsableBy(region, getRiderId())) return;
      await runDownload(region);
    },
    [getRegion, getRiderId, runDownload],
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
      // Never destroy another rider's pack (#1279). The list filter above
      // already keeps it off screen, so this is defence in depth — against a
      // stale id held by a screen that rendered before the account changed.
      const existing = getRegion(regionId);
      if (existing && !isRegionUsableBy(existing, riderId)) return;

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
