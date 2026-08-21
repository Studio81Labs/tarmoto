/**
 * Offline regions Zustand store — US-18 AC #1.
 *
 * Covers the in-memory state transitions; MMKV persistence itself falls
 * back to the in-process shim under Jest (see the guarded require in
 * stores/index.ts) so a fresh test run always starts clean.
 */

import { regionProgress, useOfflineStore } from "../index";
import type { OfflineRegionSpec } from "../../services/offlineRegions";

function buildSpec(
  overrides: Partial<OfflineRegionSpec> = {},
): OfflineRegionSpec {
  return {
    id: "region-test",
    name: "Test region",
    bbox: { west: 18.2, south: 49.78, east: 18.32, north: 49.85 },
    minZoom: 10,
    maxZoom: 11,
    createdAt: 1_700_000_000_000,
    ownerId: "rider-a",
    ...overrides,
  };
}

describe("useOfflineStore", () => {
  beforeEach(() => {
    useOfflineStore.getState().clearAll();
  });

  it("adds a region in pending state with zeroed counters", () => {
    const spec = buildSpec();
    useOfflineStore.getState().addRegion(spec, 42);

    const region = useOfflineStore.getState().getRegion(spec.id);
    expect(region).toBeDefined();
    expect(region?.status).toBe("pending");
    expect(region?.totalTiles).toBe(42);
    expect(region?.downloadedTiles).toBe(0);
    expect(region?.failedTiles).toBe(0);
    expect(region?.lastError).toBeNull();
    expect(region?.lastUpdatedAt).toBeNull();
  });

  it("upserts on duplicate id so a re-save resets counters", () => {
    const spec = buildSpec();
    useOfflineStore.getState().addRegion(spec, 20);
    useOfflineStore.getState().updateProgress(spec.id, {
      downloaded: 15,
      failed: 0,
      bytesOnDisk: 1024,
    });
    // Re-add with a larger tile count should replace the row rather
    // than creating a second entry pointing at the same on-disk tree.
    useOfflineStore.getState().addRegion(spec, 40);

    const all = useOfflineStore.getState().regions;
    const match = all.filter((r) => r.id === spec.id);
    expect(match).toHaveLength(1);
    expect(match[0]?.totalTiles).toBe(40);
    expect(match[0]?.downloadedTiles).toBe(0);
  });

  it("beginDownload flips to downloading and clears lastError", () => {
    const spec = buildSpec();
    useOfflineStore.getState().addRegion(spec, 10);
    useOfflineStore.getState().finishDownload(spec.id, {
      status: "failed",
      downloaded: 3,
      failed: 2,
      bytesOnDisk: 100,
      error: { code: "download-failed" },
    });
    useOfflineStore.getState().beginDownload(spec.id);

    const region = useOfflineStore.getState().getRegion(spec.id);
    expect(region?.status).toBe("downloading");
    expect(region?.lastError).toBeNull();
  });

  it("updateProgress advances counters and stamps lastUpdatedAt", () => {
    const spec = buildSpec();
    useOfflineStore.getState().addRegion(spec, 10);
    useOfflineStore.getState().updateProgress(spec.id, {
      downloaded: 4,
      failed: 1,
      bytesOnDisk: 2048,
    });

    const region = useOfflineStore.getState().getRegion(spec.id);
    expect(region?.downloadedTiles).toBe(4);
    expect(region?.failedTiles).toBe(1);
    expect(region?.bytesOnDisk).toBe(2048);
    expect(region?.lastUpdatedAt).not.toBeNull();
  });

  it("updateProgress leaves only the changed region's reference stale", () => {
    // Confirms the per-tile path doesn't churn every row's identity — only
    // the region that ticked should see a new object, so a memoised list
    // item in the UI can skip re-rendering siblings.
    const a = buildSpec({ id: "region-a" });
    const b = buildSpec({ id: "region-b" });
    useOfflineStore.getState().addRegion(a, 10);
    useOfflineStore.getState().addRegion(b, 10);

    const before = useOfflineStore.getState().regions;
    const beforeB = before.find((r) => r.id === b.id);

    useOfflineStore.getState().updateProgress(a.id, {
      downloaded: 3,
      failed: 0,
      bytesOnDisk: 0,
    });

    const afterB = useOfflineStore
      .getState()
      .regions.find((r) => r.id === b.id);
    expect(afterB).toBe(beforeB);
  });

  it("finishDownload records the terminal outcome", () => {
    const spec = buildSpec();
    useOfflineStore.getState().addRegion(spec, 10);
    useOfflineStore.getState().finishDownload(spec.id, {
      status: "complete",
      downloaded: 10,
      failed: 0,
      bytesOnDisk: 4096,
      error: null,
    });

    const region = useOfflineStore.getState().getRegion(spec.id);
    expect(region?.status).toBe("complete");
    expect(region?.downloadedTiles).toBe(10);
    expect(region?.bytesOnDisk).toBe(4096);
  });

  it("removeRegion drops the entry", () => {
    const spec = buildSpec();
    useOfflineStore.getState().addRegion(spec, 10);
    useOfflineStore.getState().removeRegion(spec.id);
    expect(useOfflineStore.getState().getRegion(spec.id)).toBeUndefined();
  });
});

describe("regionProgress", () => {
  it("returns 1 for empty regions so the UI bar is never stuck at 0", () => {
    const region = {
      id: "r",
      name: "r",
      bbox: { west: 0, south: 0, east: 1, north: 1 },
      minZoom: 10,
      maxZoom: 10,
      createdAt: 0,
      ownerId: "rider-a",
      status: "complete" as const,
      totalTiles: 0,
      downloadedTiles: 0,
      failedTiles: 0,
      bytesOnDisk: 0,
      lastError: null,
      lastUpdatedAt: null,
    };
    expect(regionProgress(region)).toBe(1);
  });

  it("counts downloaded + failed as the numerator", () => {
    const region = {
      id: "r",
      name: "r",
      bbox: { west: 0, south: 0, east: 1, north: 1 },
      minZoom: 10,
      maxZoom: 10,
      createdAt: 0,
      ownerId: "rider-a",
      status: "failed" as const,
      totalTiles: 10,
      downloadedTiles: 6,
      failedTiles: 2,
      bytesOnDisk: 0,
      lastError: null,
      lastUpdatedAt: null,
    };
    expect(regionProgress(region)).toBeCloseTo(0.8);
  });
});
