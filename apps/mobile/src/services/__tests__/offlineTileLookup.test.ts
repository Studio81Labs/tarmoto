/**
 * Offline tile lookup — US-18 AC #3.
 *
 * Pure helpers only, so no native bindings or filesystem access here.
 */

import type { OfflineRegion } from "../offlineRegions";
import {
  bboxContains,
  findBestOfflineRegion,
  offlineTileUrlTemplate,
} from "../offlineTileLookup";

const OSTRAVA_BBOX = {
  west: 18.2,
  south: 49.78,
  east: 18.32,
  north: 49.85,
};

function makeRegion(overrides: Partial<OfflineRegion> = {}): OfflineRegion {
  return {
    id: "region-1",
    name: "Ostrava weekend",
    bbox: OSTRAVA_BBOX,
    minZoom: 8,
    maxZoom: 14,
    createdAt: 1_700_000_000_000,
    ownerId: "rider-a",
    status: "complete",
    totalTiles: 100,
    downloadedTiles: 100,
    failedTiles: 0,
    bytesOnDisk: 1024 * 512,
    lastError: null,
    lastUpdatedAt: 1_700_000_100_000,
    ...overrides,
  };
}

describe("bboxContains", () => {
  it("accepts a point inside the bbox", () => {
    expect(bboxContains(OSTRAVA_BBOX, 18.26, 49.82)).toBe(true);
  });

  it("treats edges as inside", () => {
    // Western and southern edges exactly.
    expect(bboxContains(OSTRAVA_BBOX, 18.2, 49.78)).toBe(true);
    // Eastern and northern edges exactly.
    expect(bboxContains(OSTRAVA_BBOX, 18.32, 49.85)).toBe(true);
  });

  it("rejects points outside any edge", () => {
    expect(bboxContains(OSTRAVA_BBOX, 18.1, 49.82)).toBe(false); // west of
    expect(bboxContains(OSTRAVA_BBOX, 18.4, 49.82)).toBe(false); // east of
    expect(bboxContains(OSTRAVA_BBOX, 18.26, 49.7)).toBe(false); // south of
    expect(bboxContains(OSTRAVA_BBOX, 18.26, 49.9)).toBe(false); // north of
  });
});

describe("findBestOfflineRegion", () => {
  const center = { lat: 49.82, lng: 18.26 };

  it("returns null when there are no regions", () => {
    expect(findBestOfflineRegion([], center, 12)).toBeNull();
  });

  it("skips regions whose download is not complete", () => {
    const incomplete = makeRegion({ status: "downloading" });
    expect(findBestOfflineRegion([incomplete], center, 12)).toBeNull();
  });

  it("skips regions whose zoom range doesn't cover the current zoom", () => {
    const narrow = makeRegion({ minZoom: 10, maxZoom: 11 });
    expect(findBestOfflineRegion([narrow], center, 14)).toBeNull();
    expect(findBestOfflineRegion([narrow], center, 8)).toBeNull();
  });

  it("matches on the integer zoom so fractional camera zooms still resolve", () => {
    // MapLibre's zoom is a float during pinch/settle, but tile requests
    // use the floor of it. A region capped at maxZoom=14 must still match
    // a camera at 14.3 because MapLibre asks for z=14 tiles either way.
    const upperEdge = makeRegion({ minZoom: 8, maxZoom: 14 });
    expect(findBestOfflineRegion([upperEdge], center, 14.3)).toBe(upperEdge);
    // Symmetric check on the lower bound: 8.9 floors to 8, which is in-range.
    const lowerEdge = makeRegion({ minZoom: 8, maxZoom: 14 });
    expect(findBestOfflineRegion([lowerEdge], center, 8.9)).toBe(lowerEdge);
    // 7.9 floors to 7 — below the region's minZoom — so no match.
    expect(findBestOfflineRegion([lowerEdge], center, 7.9)).toBeNull();
  });

  it("skips regions whose bbox doesn't contain the map centre", () => {
    const elsewhere = makeRegion({
      bbox: { west: 10, south: 50, east: 11, north: 51 },
    });
    expect(findBestOfflineRegion([elsewhere], center, 12)).toBeNull();
  });

  it("returns the matching region when all criteria are met", () => {
    const ok = makeRegion();
    expect(findBestOfflineRegion([ok], center, 12)).toBe(ok);
  });

  it("prefers the most recently updated region when multiple match", () => {
    const older = makeRegion({ id: "a", lastUpdatedAt: 1_000 });
    const newer = makeRegion({ id: "b", lastUpdatedAt: 2_000 });
    expect(findBestOfflineRegion([older, newer], center, 12)).toBe(newer);
    // Order shouldn't matter.
    expect(findBestOfflineRegion([newer, older], center, 12)).toBe(newer);
  });

  it("falls back to createdAt when lastUpdatedAt is null", () => {
    const withoutTick = makeRegion({
      id: "a",
      lastUpdatedAt: null,
      createdAt: 5_000,
      ownerId: "rider-a",
    });
    const older = makeRegion({
      id: "b",
      lastUpdatedAt: 1_000,
      createdAt: 1_000,
      ownerId: "rider-a",
    });
    expect(findBestOfflineRegion([withoutTick, older], center, 12)).toBe(
      withoutTick,
    );
  });
});

describe("offlineTileUrlTemplate", () => {
  it("builds a file:// template that mirrors the downloader's on-disk layout", () => {
    const template = offlineTileUrlTemplate("/var/mobile/Docs", "region-1");
    expect(template).toBe(
      "file:///var/mobile/Docs/offline-tiles/region-1/{z}/{x}/{y}.mvt",
    );
  });

  it("does not append the layers query string", () => {
    // Cached bytes are already just the quality layer; the query would
    // only pollute MapLibre's tile cache key.
    const template = offlineTileUrlTemplate("/d", "r");
    expect(template).not.toContain("?");
  });
});
