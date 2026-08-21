/**
 * useOfflineRegions — a download is bound to the rider who STARTED it (#1279).
 *
 * Downloads deliberately survive the screen mount that started them, and since
 * #1279 the tile adapter resolves the current bearer per tile. Together those
 * mean a sign-out or an account switch mid-download would silently hand the
 * rest of the pack to somebody else's entitlement: a lower zoom cap free-caps
 * the remaining deep-zoom tiles into a pack still marked COMPLETE, a higher one
 * lends the first rider access they were never entitled to.
 *
 * Kept in its own FILE rather than beside the download-registry cases: those
 * leave a download in flight on purpose, and its unwinding overlaps the `act()`
 * scope of whatever renders next in the same file. A separate file gets a clean
 * React environment instead of a drain helper that has to be remembered.
 */

import { renderHook, act, waitFor } from "@testing-library/react-native";
import {
  useOfflineRegions,
  __resetOfflineDownloadRegistryForTest,
} from "../useOfflineRegions";
import { useOfflineStore } from "@/stores";
import type { BBox, TileDownloader } from "@/services/offlineRegions";

// A bbox/zoom pair that enumerates several tiles, so the download loop polls
// `isCancelled()` between them — a single-tile region would finish before a
// rider change could land.
const BBOX: BBox = { west: 18.2, south: 49.78, east: 18.32, north: 49.85 };
const MIN_ZOOM = 10;
const MAX_ZOOM = 11;

/** A deferred whose promise a test resolves on demand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function countingDownloader(first?: Promise<number>): {
  downloader: TileDownloader;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    downloader: {
      downloadTile: () => {
        calls += 1;
        return calls === 1 && first ? first : Promise.resolve(100);
      },
      ensureDir: () => Promise.resolve(),
      removeDir: () => Promise.resolve(),
      tileExists: () => Promise.resolve(false),
      fileSize: () => Promise.resolve(0),
    },
  };
}

describe("useOfflineRegions session binding", () => {
  beforeEach(() => {
    useOfflineStore.getState().clearAll();
    __resetOfflineDownloadRegistryForTest();
  });

  it("cancels an in-flight download when the rider changes", async () => {
    const firstTile = deferred<number>();
    const { downloader, calls } = countingDownloader(firstTile.promise);
    let riderId: string | null = "rider-a";
    const deps = {
      downloader,
      docsDir: "/tmp/tiles",
      now: () => 1,
      getRiderId: () => riderId,
    };

    const mount = await renderHook(() => useOfflineRegions(deps));
    let regionId = "";
    await act(async () => {
      const outcome = await mount.result.current.saveRegion(
        "Test area",
        BBOX,
        MIN_ZOOM,
        MAX_ZOOM,
      );
      if (outcome.ok) regionId = outcome.regionId;
    });

    // The loop is parked on the first (blocked) tile.
    await waitFor(() => expect(calls()).toBe(1));

    // Rider A signs out, rider B signs in, while the pack is still downloading.
    await act(async () => {
      riderId = "rider-b";
      firstTile.resolve(100);
    });

    // CANCELLED, not complete: a half-entitled pack must never look finished,
    // and cancelled is a state whose UI offers Retry.
    await waitFor(() =>
      expect(useOfflineStore.getState().getRegion(regionId)?.status).toBe(
        "cancelled",
      ),
    );
    // It stopped at the next cancel check rather than fetching on as rider B.
    expect(calls()).toBe(1);
  });

  it("does not fetch one more tile when the rider changes mid-iteration", async () => {
    // The loop's top-of-iteration poll is not enough on its own: `tileExists`
    // and `ensureDir` are both awaits, so a switch landing between them and the
    // request would fetch that tile under the NEW rider and write it into the
    // previous rider's pack — where `tileExists` makes every later retry skip
    // it. The recheck immediately before the request is what closes that.
    let riderId: string | null = "rider-a";
    let fetched = 0;
    const downloader: TileDownloader = {
      downloadTile: () => {
        fetched += 1;
        return Promise.resolve(100);
      },
      ensureDir: () => {
        // The switch happens while the loop is inside this await, i.e. AFTER
        // the iteration's opening poll already passed.
        riderId = "rider-b";
        return Promise.resolve();
      },
      removeDir: () => Promise.resolve(),
      tileExists: () => Promise.resolve(false),
      fileSize: () => Promise.resolve(0),
    };
    const deps = {
      downloader,
      docsDir: "/tmp/tiles",
      now: () => 1,
      getRiderId: () => riderId,
    };

    const mount = await renderHook(() => useOfflineRegions(deps));
    let regionId = "";
    await act(async () => {
      const outcome = await mount.result.current.saveRegion(
        "Test area",
        BBOX,
        MIN_ZOOM,
        MAX_ZOOM,
      );
      if (outcome.ok) regionId = outcome.regionId;
    });

    await waitFor(() =>
      expect(useOfflineStore.getState().getRegion(regionId)?.status).toBe(
        "cancelled",
      ),
    );
    // Not one tile was fetched under rider B.
    expect(fetched).toBe(0);
  });

  it("keeps downloading while the same rider stays signed in", async () => {
    // The guard must key on the RIDER, not on the credential: a token rotation
    // mid-download is routine and must not abort the pack.
    const { downloader, calls } = countingDownloader();
    const deps = {
      downloader,
      docsDir: "/tmp/tiles",
      now: () => 1,
      getRiderId: () => "rider-a",
    };

    const mount = await renderHook(() => useOfflineRegions(deps));
    let regionId = "";
    await act(async () => {
      const outcome = await mount.result.current.saveRegion(
        "Test area",
        BBOX,
        MIN_ZOOM,
        MAX_ZOOM,
      );
      if (outcome.ok) regionId = outcome.regionId;
    });

    await waitFor(() =>
      expect(useOfflineStore.getState().getRegion(regionId)?.status).toBe(
        "complete",
      ),
    );
    expect(calls()).toBeGreaterThan(1);
  });
});

/**
 * #1279 — a pack outlives the session that downloaded it, so ownership has to
 * be persisted, not merely held for the run. The store is device-global and
 * sign-out does not clear downloaded content.
 */
describe("useOfflineRegions pack ownership", () => {
  const inertDownloader: TileDownloader = {
    downloadTile: () => Promise.resolve(100),
    ensureDir: () => Promise.resolve(),
    removeDir: () => Promise.resolve(),
    // Every tile already on disk, so a run finishes without fetching and
    // leaves no async work settling into the next case's `act()` scope.
    tileExists: () => Promise.resolve(true),
    fileSize: () => Promise.resolve(100),
  };

  beforeEach(() => {
    useOfflineStore.getState().clearAll();
    __resetOfflineDownloadRegistryForTest();
  });

  const depsFor = (riderId: string | null) => ({
    downloader: inertDownloader,
    docsDir: "/tmp/tiles",
    now: () => 1,
    getRiderId: () => riderId,
  });

  /** A completed pack belonging to `ownerId`, seeded straight into the store. */
  const seedPack = (id: string, ownerId: string | null) => {
    useOfflineStore.getState().addRegion(
      {
        id,
        name: `${ownerId ?? "legacy"}'s area`,
        bbox: BBOX,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        createdAt: 1,
        ownerId,
      },
      4,
    );
    useOfflineStore.getState().finishDownload(id, {
      status: "complete",
      downloaded: 4,
      failed: 0,
      bytesOnDisk: 400,
      error: null,
    });
  };

  it("stamps the downloading rider onto the saved pack", async () => {
    const mount = await renderHook(() => useOfflineRegions(depsFor("rider-a")));
    let regionId = "";
    await act(async () => {
      const outcome = await mount.result.current.saveRegion(
        "Test area",
        BBOX,
        MIN_ZOOM,
        MAX_ZOOM,
      );
      if (outcome.ok) regionId = outcome.regionId;
    });
    // Let the (no-op) run finish inside this case rather than leaking into the
    // next one's act scope.
    await waitFor(() =>
      expect(useOfflineStore.getState().getRegion(regionId)?.status).toBe(
        "complete",
      ),
    );

    expect(useOfflineStore.getState().getRegion(regionId)?.ownerId).toBe(
      "rider-a",
    );
  });

  it("hides another rider's packs from the list and the quota", async () => {
    // Filtering in the hook is what keeps `regions.length` — the input to the
    // `max_offline_regions` cap — counting only this rider's packs, and stops
    // their rider-authored region names showing to somebody else.
    seedPack("region-a", "rider-a");

    const b = await renderHook(() => useOfflineRegions(depsFor("rider-b")));

    expect(b.result.current.regions).toHaveLength(0);
    // The bytes and the record survive — B cannot see them, A gets them back.
    expect(useOfflineStore.getState().regions).toHaveLength(1);
  });

  it("still shows a rider their own packs, and unattributed ones", async () => {
    seedPack("region-a", "rider-a");
    seedPack("region-legacy", null);

    const a = await renderHook(() => useOfflineRegions(depsFor("rider-a")));

    expect(a.result.current.regions.map((r) => r.id).sort()).toEqual([
      "region-a",
      "region-legacy",
    ]);
  });

  it("refuses to resume a pack belonging to another rider", async () => {
    // The worst version of the leak: `tileExists` skips everything already
    // fetched under A, so a resume would top A's tiles up with B's and hand
    // back a pack that is half somebody else's entitlement.
    seedPack("region-a", "rider-a");
    let downloads = 0;
    const counting: TileDownloader = {
      ...inertDownloader,
      tileExists: () => Promise.resolve(false),
      downloadTile: () => {
        downloads += 1;
        return Promise.resolve(100);
      },
    };

    const b = await renderHook(() =>
      useOfflineRegions({ ...depsFor("rider-b"), downloader: counting }),
    );
    await act(async () => {
      await b.result.current.retryRegion("region-a");
    });

    expect(downloads).toBe(0);
    expect(useOfflineStore.getState().getRegion("region-a")?.status).toBe(
      "complete",
    );
  });
});
