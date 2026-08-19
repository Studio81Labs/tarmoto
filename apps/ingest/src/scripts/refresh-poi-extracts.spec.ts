import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoiImportRegion } from "@tarmoto/ingest";
import { bboxArg } from "@tarmoto/ingest";
import {
  refreshAll,
  refreshRegion,
  type RefreshDeps,
} from "./refresh-poi-extracts.js";

const CZ: PoiImportRegion = {
  code: "CZ",
  bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
};
const SK: PoiImportRegion = {
  code: "SK",
  bbox: { minLng: 16.83, minLat: 47.73, maxLng: 22.57, maxLat: 49.61 },
};

/** osmium double that "produces" its `-o` output file, so the rename step has a
 *  real file to move (unless a test makes it throw first). */
function fakeOsmium(): jest.Mock<Promise<void>, [readonly string[]]> {
  return jest.fn(async (args: readonly string[]) => {
    const out = args[args.indexOf("-o") + 1];
    if (out) await writeFile(out, `built:${args[0]}`);
  });
}
/** download double that writes a placeholder PBF at `dest`. */
function fakeDownload(): jest.Mock<Promise<void>, [string, string]> {
  return jest.fn(async (_url: string, dest: string) => {
    await writeFile(dest, "pbf-bytes");
  });
}

describe("refresh-poi-extracts", () => {
  let targetDir: string;
  let workDir: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "poi-refresh-test-"));
    targetDir = join(root, "extracts");
    workDir = join(root, "work");
    await mkdir(targetDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(targetDir, ".."), { recursive: true, force: true });
  });

  describe("refreshRegion", () => {
    it("downloads, tags-filters, clips, and atomically writes <code>.osm", async () => {
      const download = fakeDownload();
      const osmium = fakeOsmium();

      await refreshRegion(CZ, targetDir, workDir, { download, osmium });

      // The live extract exists (written via the atomic rename of the -o temp).
      expect(await readFile(join(targetDir, "cz.osm"), "utf8")).toBe(
        "built:extract",
      );
      // Downloaded the CZ Geofabrik country PBF.
      expect(download).toHaveBeenCalledWith(
        expect.stringContaining("czech-republic-latest.osm.pbf"),
        expect.any(String),
      );
      // tags-filter (POI superset) THEN extract (CZ bbox), in that order.
      const calls = osmium.mock.calls.map((c) => c[0]);
      expect(calls[0]?.[0]).toBe("tags-filter");
      expect(calls[0]).toContain(
        "nwr/amenity=fuel,restaurant,cafe,fast_food,ice_cream",
      );
      expect(calls[1]?.[0]).toBe("extract");
      expect(calls[1]).toContain(bboxArg(CZ.bbox));
      // Explicit output format — osmium can't detect it from the `.part` temp
      // suffix, so the extract must pass `-f osm` (#976 review).
      expect(calls[1]).toEqual(expect.arrayContaining(["-f", "osm"]));
      // Intermediates cleaned; only the final file remains, never a `.part`.
      expect(await readdir(workDir)).toEqual([]);
      expect(await readdir(targetDir)).toEqual(["cz.osm"]);
    });

    it("keeps the previous extract (no truncated write) when a step fails", async () => {
      await writeFile(join(targetDir, "cz.osm"), "OLD-GOOD");
      const download = fakeDownload();
      const osmium = jest.fn(async (args: readonly string[]) => {
        if (args[0] === "extract") throw new Error("osmium extract boom");
        const out = args[args.indexOf("-o") + 1];
        if (out) await writeFile(out, "filtered");
      });

      await expect(
        refreshRegion(CZ, targetDir, workDir, { download, osmium }),
      ).rejects.toThrow("osmium extract boom");

      // Live extract untouched; no stray `.part`; intermediates cleaned.
      expect(await readFile(join(targetDir, "cz.osm"), "utf8")).toBe(
        "OLD-GOOD",
      );
      expect(await readdir(targetDir)).toEqual(["cz.osm"]);
      expect(await readdir(workDir)).toEqual([]);
    });

    it("leaves everything untouched and skips osmium when the download fails", async () => {
      await writeFile(join(targetDir, "cz.osm"), "OLD");
      const download = jest.fn((): Promise<void> =>
        Promise.reject(new Error("download failed (404 Not Found)")),
      );
      const osmium = fakeOsmium();

      await expect(
        refreshRegion(CZ, targetDir, workDir, { download, osmium }),
      ).rejects.toThrow("404");

      expect(osmium).not.toHaveBeenCalled();
      expect(await readFile(join(targetDir, "cz.osm"), "utf8")).toBe("OLD");
    });

    it("throws for a region with no Geofabrik slug", async () => {
      const unknown = { code: "ZZ", bbox: CZ.bbox };
      const deps: RefreshDeps = { download: jest.fn(), osmium: jest.fn() };

      await expect(
        refreshRegion(unknown, targetDir, workDir, deps),
      ).rejects.toThrow(/no Geofabrik slug/);
      expect(deps.download).not.toHaveBeenCalled();
    });
  });

  describe("refreshAll", () => {
    it("throws when the target dir is not configured", async () => {
      await expect(
        refreshAll({ enabled: true, targetDir: null, regions: [CZ] }, workDir, {
          download: fakeDownload(),
          osmium: fakeOsmium(),
        }),
      ).rejects.toThrow(/TARMOTO_OSM_POI_IMPORT_DIR/);
    });

    it("isolates a per-region failure, continues, and surfaces it in the summary", async () => {
      const download = fakeDownload();
      const osmium = jest.fn(async (args: readonly string[]) => {
        // Fail only SK's clip; CZ's succeeds.
        if (args[0] === "extract" && args.includes(bboxArg(SK.bbox))) {
          throw new Error("SK clip boom");
        }
        const out = args[args.indexOf("-o") + 1];
        if (out) await writeFile(out, "out");
      });

      const summary = await refreshAll(
        { enabled: true, targetDir, regions: [CZ, SK] },
        workDir,
        { download, osmium },
        () => undefined, // silence logs
      );

      expect(summary.ok).toEqual(["CZ"]);
      expect(summary.failed).toHaveLength(1);
      expect(summary.failed[0]?.code).toBe("SK");
      expect(summary.failed[0]?.error).toContain("SK clip boom");
      // Only CZ's extract landed; SK kept nothing (it had none) — no sk.osm.
      expect(await readdir(targetDir)).toEqual(["cz.osm"]);
    });

    it("sweeps only STALE refresh temps — keeps a recent (possibly active) one and any upload .part (#976 review)", async () => {
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago > 1h threshold
      // Stale orphan from a killed run → reclaimed.
      await writeFile(join(targetDir, "cz.osm.9.dead.refresh.part"), "orphan");
      await utimes(join(targetDir, "cz.osm.9.dead.refresh.part"), old, old);
      // Recently-written refresh temp → could be a CONCURRENT run's active
      // output, so it must NOT be swept even though the suffix matches.
      await writeFile(join(targetDir, "sk.osm.8.beef.refresh.part"), "active");
      // An admin upload's plain `.part` — never ours, kept even when old.
      await writeFile(join(targetDir, "cz.osm.1.abc.part"), "upload");
      await utimes(join(targetDir, "cz.osm.1.abc.part"), old, old);
      await writeFile(join(targetDir, "cz.osm"), "live extract");

      await refreshAll(
        { enabled: true, targetDir, regions: [] },
        workDir,
        { download: fakeDownload(), osmium: fakeOsmium() },
        () => undefined,
      );

      // Stale orphan gone; recent temp, upload `.part`, and live extract kept.
      expect((await readdir(targetDir)).sort()).toEqual([
        "cz.osm",
        "cz.osm.1.abc.part",
        "sk.osm.8.beef.refresh.part",
      ]);
    });
  });
});
