import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bboxArg,
  paddedTileBbox,
  roadTileFileName,
  ROAD_TAGS_FILTER_EXPRESSIONS,
  subdivideRegion,
  TILE_EXTRACT_PAD_DEG,
  type PoiImportRegion,
  type RoadTile,
} from "@tarmoto/ingest";
import {
  refreshAll,
  refreshRegion,
  type RefreshDeps,
} from "./refresh-road-extracts.js";

const CZ: PoiImportRegion = {
  code: "CZ",
  bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
};
const SK: PoiImportRegion = {
  code: "SK",
  bbox: { minLng: 16.83, minLat: 47.73, maxLng: 22.57, maxLat: 49.61 },
};
// CZ + SK are each ≤ 6.77° wide / 2.51° tall — a 10° span keeps both a single
// 1×1 tile (== the region bbox), for tests that don't care about tiling itself.
const SINGLE_TILE_SPAN = 10;
// CZ (6.77°×2.51°) subdivides into 2 tiles (cols=2, rows=1) at this span — used
// by the producer's own multi-tile happy-path test.
const MULTI_TILE_SPAN = 5;

function fakeOsmium(): jest.Mock<Promise<void>, [readonly string[]]> {
  return jest.fn(async (args: readonly string[]) => {
    const out = args[args.indexOf("-o") + 1];
    if (out) await writeFile(out, `built:${args[0]}`);
  });
}
function fakeDownload(): jest.Mock<Promise<void>, [string, string]> {
  return jest.fn(async (_url: string, dest: string) => {
    await writeFile(dest, "pbf-bytes");
  });
}

describe("refresh-road-extracts", () => {
  let targetDir: string;
  let workDir: string;
  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "road-refresh-test-"));
    targetDir = join(root, "extracts");
    workDir = join(root, "work");
    await mkdir(targetDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(targetDir, ".."), { recursive: true, force: true });
  });

  describe("refreshRegion", () => {
    it("downloads, road-filters ONCE, then clips all tiles and publishes them only after every extract succeeds", async () => {
      const download = fakeDownload();
      const tiles = subdivideRegion(CZ, MULTI_TILE_SPAN);
      expect(tiles.length).toBeGreaterThan(1); // this test exercises real tiling
      const finalNames = tiles.map((t) => roadTileFileName(t, MULTI_TILE_SPAN));

      const osmium = jest.fn(async (args: readonly string[]) => {
        if (args[0] === "extract") {
          // Two-phase publish: while ANY tile is still being extracted, NONE
          // of the region's final tile files may exist yet — renames only
          // happen in a batch after every tile in the region has cleared its
          // extract, i.e. strictly after the LAST extract call too.
          const present = await readdir(targetDir);
          expect(present.some((name) => finalNames.includes(name))).toBe(false);
        }
        const out = args[args.indexOf("-o") + 1];
        if (out) await writeFile(out, `built:${args[0]}`);
      });

      await refreshRegion(
        CZ,
        targetDir,
        null,
        workDir,
        tiles,
        MULTI_TILE_SPAN,
        {
          download,
          osmium,
        },
      );

      expect(download).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledWith(
        expect.stringContaining("czech-republic-latest.osm.pbf"),
        expect.any(String),
      );

      const calls = osmium.mock.calls.map((c) => c[0]);
      const filterCalls = calls.filter((c) => c[0] === "tags-filter");
      const extractCalls = calls.filter((c) => c[0] === "extract");
      expect(filterCalls).toHaveLength(1); // filter runs ONCE, not per tile
      expect(filterCalls[0]).toContain(ROAD_TAGS_FILTER_EXPRESSIONS[0]);
      expect(extractCalls).toHaveLength(tiles.length); // one extract per tile

      // Every extract clips the FILTERED pbf (tags-filter's own "-o" output),
      // never the raw downloaded pbf — i.e. the tag filter really is applied
      // upstream of every tile's clip, not bypassed for some/all tiles.
      const pbfPath = download.mock.calls[0]?.[1];
      const filteredPath = filterCalls[0]?.[filterCalls[0].indexOf("-o") + 1];
      expect(filteredPath).toEqual(expect.any(String));
      expect(filteredPath).not.toBe(pbfPath);
      for (const call of extractCalls) {
        expect(call).toContain(filteredPath);
        expect(call).not.toContain(pbfPath);
      }

      for (const tile of tiles) {
        // The `-b` clip uses the PADDED bbox (Codex P2 #1) — a way crossing the
        // tile whose nodes sit just outside the exact tile must still be
        // captured. The bare (unpadded) tile bbox must NOT appear as the `-b`
        // arg — that was the pre-fix behaviour that dropped node-less crossers.
        const paddedArg = bboxArg(
          paddedTileBbox(tile.bbox, TILE_EXTRACT_PAD_DEG),
        );
        const bareArg = bboxArg(tile.bbox);
        expect(paddedArg).not.toBe(bareArg); // sanity: the pad actually changes the arg
        expect(extractCalls.some((c) => c.includes(paddedArg))).toBe(true);
        expect(extractCalls.some((c) => c.includes(bareArg))).toBe(false);

        // The FILENAME (which tile, and its on-disk name) stays the EXACT tile —
        // only the osmium clip selection is padded, never the reconcile identity.
        const fileName = roadTileFileName(tile, MULTI_TILE_SPAN);
        expect(fileName).toContain(
          `-s${String(MULTI_TILE_SPAN).replace(".", "_")}.osm`,
        );
        expect(await readFile(join(targetDir, fileName), "utf8")).toBe(
          "built:extract",
        );
      }
      expect(
        extractCalls.every(
          (c) => c.includes("-f") && c[c.indexOf("-f") + 1] === "osm",
        ),
      ).toBe(true);

      expect(await readdir(workDir)).toEqual([]);
      expect((await readdir(targetDir)).sort()).toEqual(
        tiles.map((t) => roadTileFileName(t, MULTI_TILE_SPAN)).sort(),
      );
    });

    it("writes a routing extract (drivable highways + ferries) from the PBF when a routing dir is set", async () => {
      const routingDir = join(targetDir, "..", "routing");
      await mkdir(routingDir, { recursive: true });
      const tiles = subdivideRegion(CZ, SINGLE_TILE_SPAN); // 1 tile keeps it simple
      const download = fakeDownload();
      const osmium = fakeOsmium();

      await refreshRegion(
        CZ,
        targetDir,
        routingDir,
        workDir,
        tiles,
        SINGLE_TILE_SPAN,
        { download, osmium },
      );

      const calls = osmium.mock.calls.map((c) => c[0]);
      const pbfPath = download.mock.calls[0]?.[1];

      // TWO tags-filter passes: the tiles' (highways only → filtered pbf), and the
      // routing extract's OWN filter of the raw PBF that ALSO keeps ferries
      // (GraphHopper routes route=ferry), written straight to <dir>/cz.osm.
      const tagFilterCalls = calls.filter((c) => c[0] === "tags-filter");
      expect(tagFilterCalls).toHaveLength(2);
      const routingCall = tagFilterCalls.find((c) =>
        c.some((a) => a.includes(join(routingDir, "cz.osm"))),
      ) as string[] | undefined;
      expect(routingCall).toBeDefined();
      const rc = routingCall as string[];
      expect(rc).toContain(pbfPath); // filters the raw PBF, not the highways-only `filtered`
      expect(rc).toContain("w/route=ferry"); // ferries preserved for routing
      expect(rc[rc.indexOf("-f") + 1]).toBe("osm");

      // Published (via the atomic `.part` → rename) alongside the tiles; work dir clean.
      expect(await readFile(join(routingDir, "cz.osm"), "utf8")).toBe(
        "built:tags-filter",
      );
      expect(await readdir(targetDir)).toEqual([
        roadTileFileName(tiles[0] as RoadTile, SINGLE_TILE_SPAN),
      ]);
      expect(await readdir(workDir)).toEqual([]);
    });

    it("clips every tile's extract to the PADDED bbox, not the exact tile bbox (Codex P2 #1)", async () => {
      // A dedicated, minimal assertion of the pad contract (beyond the happy-path
      // test above): `osmium extract -b` gets `paddedTileBbox(tile.bbox,
      // TILE_EXTRACT_PAD_DEG)`, never the bare `tile.bbox` — the padding is what
      // lets a way crossing the tile with no node inside the exact tile still be
      // selected by osmium's node-in-bbox `complete_ways` test.
      const tiles = subdivideRegion(CZ, SINGLE_TILE_SPAN);
      const tile = tiles[0]!;
      const osmium = fakeOsmium();

      await refreshRegion(
        CZ,
        targetDir,
        null,
        workDir,
        tiles,
        SINGLE_TILE_SPAN,
        {
          download: fakeDownload(),
          osmium,
        },
      );

      const extractCall = osmium.mock.calls
        .map((c) => c[0])
        .find((c) => c[0] === "extract")!;
      const bIndex = extractCall.indexOf("-b");
      expect(extractCall[bIndex + 1]).toBe(
        bboxArg(paddedTileBbox(tile.bbox, TILE_EXTRACT_PAD_DEG)),
      );
      expect(extractCall[bIndex + 1]).not.toBe(bboxArg(tile.bbox));
    });

    it("keeps the previous tile extract when a step fails", async () => {
      const tiles = subdivideRegion(CZ, MULTI_TILE_SPAN);
      const firstTile = roadTileFileName(tiles[0]!, MULTI_TILE_SPAN);
      await writeFile(join(targetDir, firstTile), "OLD-GOOD");
      const download = fakeDownload();
      const osmium = jest.fn(async (args: readonly string[]) => {
        if (args[0] === "extract") throw new Error("osmium extract boom");
        const out = args[args.indexOf("-o") + 1];
        if (out) await writeFile(out, "filtered");
      });
      await expect(
        refreshRegion(CZ, targetDir, null, workDir, tiles, MULTI_TILE_SPAN, {
          download,
          osmium,
        }),
      ).rejects.toThrow("osmium extract boom");
      expect(await readFile(join(targetDir, firstTile), "utf8")).toBe(
        "OLD-GOOD",
      );
      expect(await readdir(workDir)).toEqual([]);
    });

    it("publishes NEITHER tile when only tile 2's clip fails (atomic per-region publish)", async () => {
      const tiles = subdivideRegion(CZ, MULTI_TILE_SPAN);
      expect(tiles.length).toBeGreaterThanOrEqual(2); // exercises mixed tile state
      const tile1 = tiles[0]!;
      const tile2 = tiles[1]!;
      const tile1File = roadTileFileName(tile1, MULTI_TILE_SPAN);
      const tile2File = roadTileFileName(tile2, MULTI_TILE_SPAN);
      await writeFile(join(targetDir, tile1File), "OLD-TILE-1");
      await writeFile(join(targetDir, tile2File), "OLD-TILE-2");

      const download = fakeDownload();
      const tile2PaddedArg = bboxArg(
        paddedTileBbox(tile2.bbox, TILE_EXTRACT_PAD_DEG),
      );
      const osmium = jest.fn(async (args: readonly string[]) => {
        if (args[0] === "extract" && args.includes(tile2PaddedArg)) {
          throw new Error("tile 2 clip boom");
        }
        const out = args[args.indexOf("-o") + 1];
        if (out) await writeFile(out, `built:${args[0]}`);
      });

      await expect(
        refreshRegion(CZ, targetDir, null, workDir, tiles, MULTI_TILE_SPAN, {
          download,
          osmium,
        }),
      ).rejects.toThrow("tile 2 clip boom");

      // Tile 1's clip succeeded but publish is all-or-nothing per region — a
      // later tile's extract failure means NEITHER tile is republished this
      // run. Both keep their pre-seeded OLD content byte-for-byte.
      expect(await readFile(join(targetDir, tile1File), "utf8")).toBe(
        "OLD-TILE-1",
      );
      expect(await readFile(join(targetDir, tile2File), "utf8")).toBe(
        "OLD-TILE-2",
      );
      // No stray `.part` left behind either — the region's dir holds exactly
      // the two OLD final files, nothing else.
      expect((await readdir(targetDir)).sort()).toEqual(
        [tile1File, tile2File].sort(),
      );
      expect(await readdir(workDir)).toEqual([]);
    });

    it("leaves everything untouched and skips osmium when the download fails", async () => {
      const tiles = subdivideRegion(CZ, SINGLE_TILE_SPAN);
      const firstTile = roadTileFileName(tiles[0]!, SINGLE_TILE_SPAN);
      await writeFile(join(targetDir, firstTile), "OLD");
      const download = jest.fn((): Promise<void> =>
        Promise.reject(new Error("download failed (404 Not Found)")),
      );
      const osmium = fakeOsmium();

      await expect(
        refreshRegion(CZ, targetDir, null, workDir, tiles, SINGLE_TILE_SPAN, {
          download,
          osmium,
        }),
      ).rejects.toThrow("404");

      expect(osmium).not.toHaveBeenCalled();
      expect(await readFile(join(targetDir, firstTile), "utf8")).toBe("OLD");
    });

    it("throws for a region with no Geofabrik slug", async () => {
      const unknown = { code: "ZZ", bbox: CZ.bbox };
      const deps: RefreshDeps = { download: jest.fn(), osmium: jest.fn() };

      await expect(
        // Tiles are never touched — the slug check throws before any tile work.
        refreshRegion(
          unknown,
          targetDir,
          null,
          workDir,
          [],
          SINGLE_TILE_SPAN,
          deps,
        ),
      ).rejects.toThrow(/no Geofabrik slug/);
      expect(deps.download).not.toHaveBeenCalled();
    });
  });

  describe("refreshAll", () => {
    it("isolates a per-region failure, continues, and surfaces it in the summary", async () => {
      const download = fakeDownload();
      // Fail only SK's clip; CZ's succeeds. At SINGLE_TILE_SPAN each region is
      // exactly one tile == its own bbox, so this still targets SK only — the
      // `-b` arg osmium actually receives is the PADDED bbox now.
      const skPaddedArg = bboxArg(
        paddedTileBbox(SK.bbox, TILE_EXTRACT_PAD_DEG),
      );
      const osmium = jest.fn(async (args: readonly string[]) => {
        if (args[0] === "extract" && args.includes(skPaddedArg)) {
          throw new Error("SK clip boom");
        }
        const out = args[args.indexOf("-o") + 1];
        if (out) await writeFile(out, "out");
      });

      const summary = await refreshAll(
        {
          enabled: true,
          targetDir,
          routingDir: null,
          regions: [CZ, SK],
          tileSpanDeg: SINGLE_TILE_SPAN,
        },
        workDir,
        { download, osmium },
        () => undefined, // silence logs
      );

      expect(summary.ok).toEqual(["CZ"]);
      expect(summary.failed).toHaveLength(1);
      expect(summary.failed[0]?.code).toBe("SK");
      expect(summary.failed[0]?.error).toContain("SK clip boom");
      // Only CZ's tile landed; SK kept nothing (it had none) — no sk tile file.
      expect(await readdir(targetDir)).toEqual([
        roadTileFileName(
          subdivideRegion(CZ, SINGLE_TILE_SPAN)[0]!,
          SINGLE_TILE_SPAN,
        ),
      ]);
    });
  });
});
