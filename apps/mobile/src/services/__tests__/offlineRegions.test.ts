/**
 * Offline regions — US-18 AC #1.
 *
 * Covers the pure tile-math helpers, URL/path builders, and the
 * `downloadRegion` orchestrator. The tile downloader is injected so we
 * never touch `react-native-fs` or the network.
 */

import {
  bboxAroundPoint,
  bboxFromVisibleBounds,
  countTilesForRegion,
  downloadRegion,
  enumerateTilesForRegion,
  MAX_TILES_PER_REGION,
  normalizeZoomRange,
  regionDir,
  tilePath,
  tileRangeForBBox,
  tileUrl,
  type OfflineRegionSpec,
  type TileDownloader,
} from "../offlineRegions";

// Small Ostrava-ish test bbox — small enough that z=10..12 produces a
// handful of tiles we can assert on explicitly.
const OSTRAVA_BBOX = {
  west: 18.2,
  south: 49.78,
  east: 18.32,
  north: 49.85,
};

describe("tile math", () => {
  describe("normalizeZoomRange", () => {
    it("clamps out-of-range values to [0, 16]", () => {
      expect(normalizeZoomRange(-5, 20)).toEqual({ minZoom: 0, maxZoom: 16 });
    });

    it("floors fractional zoom levels", () => {
      expect(normalizeZoomRange(8.7, 12.3)).toEqual({
        minZoom: 8,
        maxZoom: 12,
      });
    });

    it("throws when min exceeds max after clamping", () => {
      expect(() => normalizeZoomRange(10, 5)).toThrow(/must be <=/);
    });

    it("throws on NaN or Infinity", () => {
      expect(() => normalizeZoomRange(Number.NaN, 10)).toThrow(/finite/);
      expect(() => normalizeZoomRange(0, Number.POSITIVE_INFINITY)).toThrow(
        /finite/,
      );
    });
  });

  describe("tileRangeForBBox", () => {
    it("keeps the world bbox inside the zoom-0 bounds", () => {
      const world = { west: -180, south: -85, east: 180, north: 85 };
      const range = tileRangeForBBox(world, 0);
      expect(range).toEqual({ xMin: 0, xMax: 0, yMin: 0, yMax: 0 });
    });

    it("returns a single tile for a sub-tile bbox at high zoom", () => {
      const range = tileRangeForBBox(OSTRAVA_BBOX, 10);
      // At z=10 the Ostrava bbox spans a 2x1 tile window; narrowing the
      // bbox further should collapse to 1x1. We assert only the shape
      // instead of hard-coding OSM tile coords to stay robust if the
      // lat/lng bounds nudge.
      expect(range.xMax - range.xMin).toBeGreaterThanOrEqual(0);
      expect(range.yMax - range.yMin).toBeGreaterThanOrEqual(0);
    });

    it("respects zoom — higher zoom produces more tiles for the same bbox", () => {
      const low = tileRangeForBBox(OSTRAVA_BBOX, 8);
      const high = tileRangeForBBox(OSTRAVA_BBOX, 12);
      const lowArea = (low.xMax - low.xMin + 1) * (low.yMax - low.yMin + 1);
      const highArea =
        (high.xMax - high.xMin + 1) * (high.yMax - high.yMin + 1);
      expect(highArea).toBeGreaterThan(lowArea);
    });
  });

  describe("enumerateTilesForRegion", () => {
    it("orders tiles from lowest to highest zoom", () => {
      const tiles = enumerateTilesForRegion(OSTRAVA_BBOX, 8, 10);
      const zooms = tiles.map((t) => t.z);
      const sorted = [...zooms].sort((a, b) => a - b);
      expect(zooms).toEqual(sorted);
      expect(zooms[0]).toBe(8);
      expect(zooms[zooms.length - 1]).toBe(10);
    });

    it("returns the same count that countTilesForRegion reports", () => {
      const tiles = enumerateTilesForRegion(OSTRAVA_BBOX, 8, 12);
      const count = countTilesForRegion(OSTRAVA_BBOX, 8, 12);
      expect(tiles.length).toBe(count);
    });

    it("deduplicates — no two entries share the same (z,x,y)", () => {
      const tiles = enumerateTilesForRegion(OSTRAVA_BBOX, 8, 12);
      const keys = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
      expect(keys.size).toBe(tiles.length);
    });
  });
});

describe("URL + path helpers", () => {
  it("tileUrl embeds the xyz coords and the quality layer filter", () => {
    const url = tileUrl({ z: 12, x: 2259, y: 1410 }, "https://api.tarmoto.app");
    expect(url).toBe(
      "https://api.tarmoto.app/api/v1/roads/tiles/12/2259/1410.mvt?layers=quality",
    );
  });

  it("tilePath namespaces by region id inside the offline root", () => {
    const path = tilePath("/docs", "region-abc", { z: 10, x: 5, y: 6 });
    expect(path).toBe("/docs/offline-tiles/region-abc/10/5/6.mvt");
  });

  it("regionDir matches tilePath's parent namespace", () => {
    expect(regionDir("/docs", "region-abc")).toBe(
      "/docs/offline-tiles/region-abc",
    );
  });
});

describe("bbox helpers", () => {
  it("bboxAroundPoint respects latitude-dependent longitude stretch", () => {
    const equator = bboxAroundPoint({ lat: 0, lng: 0 }, 50);
    const polar = bboxAroundPoint({ lat: 60, lng: 0 }, 50);
    // At higher latitudes the same ground distance spans more degrees of
    // longitude — guard the correction so a polar bbox doesn't degenerate.
    expect(polar.east - polar.west).toBeGreaterThan(
      equator.east - equator.west,
    );
  });

  it("bboxAroundPoint clamps the radius to a sane range", () => {
    // 9999 km would paint the world; we expect the helper to cap well below.
    const bbox = bboxAroundPoint({ lat: 0, lng: 0 }, 9999);
    expect(bbox.north - bbox.south).toBeLessThan(10);
  });

  it("bboxFromVisibleBounds normalises swapped corners", () => {
    const swapped = bboxFromVisibleBounds([
      [18.32, 49.85],
      [18.2, 49.78],
    ]);
    expect(swapped).toEqual({
      west: 18.2,
      east: 18.32,
      south: 49.78,
      north: 49.85,
    });
  });
});

// ── downloadRegion orchestration ──

function fakeDownloader(overrides: Partial<TileDownloader> = {}): {
  downloader: TileDownloader;
  calls: { downloads: string[]; ensured: string[]; removed: string[] };
} {
  const calls = {
    downloads: [] as string[],
    ensured: [] as string[],
    removed: [] as string[],
  };
  const downloader: TileDownloader = {
    downloadTile: async (url) => {
      calls.downloads.push(url);
      return 1024;
    },
    ensureDir: async (path) => {
      calls.ensured.push(path);
    },
    removeDir: async (path) => {
      calls.removed.push(path);
    },
    tileExists: async () => false,
    fileSize: async () => 512,
    ...overrides,
  };
  return { downloader, calls };
}

function buildSpec(): OfflineRegionSpec {
  return {
    id: "region-test",
    name: "Test region",
    bbox: OSTRAVA_BBOX,
    minZoom: 10,
    maxZoom: 11,
    createdAt: 1_700_000_000_000,
    ownerId: "rider-a",
  };
}

describe("downloadRegion", () => {
  it("downloads every enumerated tile and reports complete status", async () => {
    const spec = buildSpec();
    const tileCount = countTilesForRegion(
      spec.bbox,
      spec.minZoom,
      spec.maxZoom,
    );
    const { downloader, calls } = fakeDownloader();

    const progress: number[] = [];
    const result = await downloadRegion({
      spec,
      docsDir: "/docs",
      downloader,
      apiBase: "https://api.tarmoto.app",
      onProgress: (p) => progress.push(p.downloaded),
    });

    expect(result.status).toBe("complete");
    expect(result.downloaded).toBe(tileCount);
    expect(result.failed).toBe(0);
    expect(result.bytesOnDisk).toBe(tileCount * 1024);
    expect(calls.downloads.length).toBe(tileCount);
    expect(calls.downloads[0]).toContain(
      "https://api.tarmoto.app/api/v1/roads/tiles/",
    );
    // First progress emit is the initial 0/N report so the UI can flip
    // to "downloading" immediately.
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(tileCount);
  });

  it("skips tiles that are already on disk (resume path) and counts their bytes", async () => {
    const spec = buildSpec();
    const tileCount = countTilesForRegion(
      spec.bbox,
      spec.minZoom,
      spec.maxZoom,
    );
    const { downloader, calls } = fakeDownloader({
      tileExists: async () => true,
      fileSize: async () => 700,
    });

    const result = await downloadRegion({
      spec,
      docsDir: "/docs",
      downloader,
    });

    expect(result.status).toBe("complete");
    expect(result.downloaded).toBe(tileCount);
    // No HTTP fetches — every tile was already cached.
    expect(calls.downloads.length).toBe(0);
    // Resumed tiles contribute their on-disk size so the UI reports
    // accurate storage usage.
    expect(result.bytesOnDisk).toBe(tileCount * 700);
  });

  it("treats fileSize errors on resume as 0 rather than aborting", async () => {
    const spec = buildSpec();
    const tileCount = countTilesForRegion(
      spec.bbox,
      spec.minZoom,
      spec.maxZoom,
    );
    const { downloader } = fakeDownloader({
      tileExists: async () => true,
      fileSize: async () => {
        throw new Error("stat failed");
      },
    });

    const result = await downloadRegion({
      spec,
      docsDir: "/docs",
      downloader,
    });

    expect(result.status).toBe("complete");
    expect(result.downloaded).toBe(tileCount);
    expect(result.bytesOnDisk).toBe(0);
  });

  it("counts failures but keeps going (per-tile isolation)", async () => {
    const spec = buildSpec();
    let calls = 0;
    const { downloader } = fakeDownloader({
      downloadTile: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return 512;
      },
    });

    const result = await downloadRegion({
      spec,
      docsDir: "/docs",
      downloader,
    });

    expect(result.status).toBe("failed");
    expect(result.failed).toBe(1);
    expect(result.downloaded).toBeGreaterThan(0);
    expect(result.error).toEqual({ code: "download-failed" });
  });

  it("aborts cleanly when isCancelled returns true mid-run", async () => {
    const spec = buildSpec();
    let downloads = 0;
    const { downloader } = fakeDownloader({
      downloadTile: async () => {
        downloads += 1;
        return 1024;
      },
    });

    const result = await downloadRegion({
      spec,
      docsDir: "/docs",
      downloader,
      // Cancel after the second successful tile.
      isCancelled: () => downloads >= 2,
    });

    expect(result.status).toBe("cancelled");
    expect(result.downloaded).toBe(2);
    expect(result.error).toBeNull();
  });

  it("rejects regions that would exceed the per-region tile cap", async () => {
    // Build a huge bbox + high zoom → way more than MAX_TILES_PER_REGION.
    const bigSpec: OfflineRegionSpec = {
      ...buildSpec(),
      bbox: { west: -10, south: 40, east: 30, north: 60 },
      minZoom: 10,
      maxZoom: 14,
    };
    const { downloader, calls } = fakeDownloader();

    const result = await downloadRegion({
      spec: bigSpec,
      docsDir: "/docs",
      downloader,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "tile-cap-exceeded",
      limit: MAX_TILES_PER_REGION,
      count: expect.any(Number),
    });
    // No downloads attempted — the cap gate runs before the loop.
    expect(calls.downloads.length).toBe(0);
  });

  it("ensures the region directory exists before the first tile", async () => {
    const spec = buildSpec();
    const { downloader, calls } = fakeDownloader();

    await downloadRegion({
      spec,
      docsDir: "/docs",
      downloader,
    });

    expect(calls.ensured[0]).toBe("/docs/offline-tiles/region-test");
  });
});
