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
  ROAD_TAGS_FILTER_EXPRESSIONS,
  type PoiImportRegion,
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
    it("downloads, road-filters, clips, and atomically writes <code>.osm", async () => {
      const download = fakeDownload();
      const osmium = fakeOsmium();
      await refreshRegion(CZ, targetDir, workDir, { download, osmium });

      expect(await readFile(join(targetDir, "cz.osm"), "utf8")).toBe(
        "built:extract",
      );
      expect(download).toHaveBeenCalledWith(
        expect.stringContaining("czech-republic-latest.osm.pbf"),
        expect.any(String),
      );
      const calls = osmium.mock.calls.map((c) => c[0]);
      expect(calls[0]?.[0]).toBe("tags-filter");
      expect(calls[0]).toContain(ROAD_TAGS_FILTER_EXPRESSIONS[0]);
      expect(calls[1]?.[0]).toBe("extract");
      expect(calls[1]).toContain(bboxArg(CZ.bbox));
      expect(calls[1]).toEqual(expect.arrayContaining(["-f", "osm"]));
      expect(await readdir(workDir)).toEqual([]);
      expect(await readdir(targetDir)).toEqual(["cz.osm"]);
    });

    it("keeps the previous extract when a step fails", async () => {
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
      expect(await readFile(join(targetDir, "cz.osm"), "utf8")).toBe(
        "OLD-GOOD",
      );
      expect(await readdir(workDir)).toEqual([]);
    });

    it("leaves everything untouched and skips osmium when the download fails", async () => {
      await writeFile(join(targetDir, "cz.osm"), "OLD");
      const download = jest.fn(
        (): Promise<void> =>
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
  });
});
