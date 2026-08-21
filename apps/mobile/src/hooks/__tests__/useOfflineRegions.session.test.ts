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
