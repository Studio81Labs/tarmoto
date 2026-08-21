/**
 * useOfflineRegions — download-registry ownership.
 *
 * Focus: the in-flight download registry lives at MODULE scope, not in
 * per-hook refs, so a download survives the screen mount that started it and
 * a LATER mount (or the exported `cancelAllOfflineDownloads`) can still cancel
 * it. This is the cross-mount revocation path: start a download, leave the
 * screen (unmount), come back (fresh hook), then lose `offline_maps` — the new
 * instance's cancel must reach the job the prior mount started.
 */

import { renderHook, act, waitFor } from "@testing-library/react-native";
import {
  useOfflineRegions,
  cancelAllOfflineDownloads,
  __resetOfflineDownloadRegistryForTest,
} from "../useOfflineRegions";
import { useOfflineStore } from "@/stores";
import type { BBox, TileDownloader } from "@/services/offlineRegions";

// A bbox/zoom pair that enumerates several tiles, so the download loop polls
// `isCancelled()` between tiles (a single-tile region would finish before the
// cancel could land).
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

describe("useOfflineRegions download registry", () => {
  beforeEach(() => {
    useOfflineStore.getState().clearAll();
    __resetOfflineDownloadRegistryForTest();
  });

  it("cancels a download started by a PRIOR mount via the module-level registry", async () => {
    // The first tile blocks until we release it, holding the download in flight
    // while we swap mounts. Every later tile would resolve instantly — but the
    // loop must never reach one once cancellation lands.
    const firstTile = deferred<number>();
    let downloadCalls = 0;
    const downloader: TileDownloader = {
      downloadTile: () => {
        downloadCalls += 1;
        return downloadCalls === 1 ? firstTile.promise : Promise.resolve(100);
      },
      ensureDir: () => Promise.resolve(),
      removeDir: () => Promise.resolve(),
      tileExists: () => Promise.resolve(false),
      fileSize: () => Promise.resolve(0),
    };
    const deps = {
      downloader,
      docsDir: "/tmp/tiles",
      now: () => 1,
      // Injected for the same reason as `downloader`: the default reaches for
      // `typedClient`, which pulls in the keychain/MMKV native bindings.
      // Session binding itself is covered in `useOfflineRegions.session.test`.
      getRiderId: () => "rider-a",
    };

    // ── Mount A: start the download, then leave the screen. ──
    const mountA = await renderHook(() => useOfflineRegions(deps));
    let regionId = "";
    await act(async () => {
      const outcome = await mountA.result.current.saveRegion(
        "Test area",
        BBOX,
        MIN_ZOOM,
        MAX_ZOOM,
      );
      if (outcome.ok) regionId = outcome.regionId;
    });
    expect(regionId).not.toBe("");

    // The loop has reached the first (blocked) tile — download is in flight.
    await waitFor(() => expect(downloadCalls).toBe(1));
    expect(useOfflineStore.getState().getRegion(regionId)?.status).toBe(
      "downloading",
    );

    // Rider taps Back — the hook that started the download unmounts.
    mountA.unmount();

    // ── Mount B: reopen the screen (fresh hook), then lose access. ──
    await renderHook(() => useOfflineRegions(deps));

    // Revocation: the module-level cancel reaches the job started by mount A.
    await act(async () => {
      cancelAllOfflineDownloads();
      // Release the blocked tile so the loop advances to its next iteration,
      // where the now-set cancel flag aborts it.
      firstTile.resolve(100);
    });

    await waitFor(() =>
      expect(useOfflineStore.getState().getRegion(regionId)?.status).toBe(
        "cancelled",
      ),
    );
    // The loop stopped at the cancel check — the second tile was never fetched.
    expect(downloadCalls).toBe(1);
  });
});
