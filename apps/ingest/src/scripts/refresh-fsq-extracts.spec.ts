import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoiImportRegion } from "@tarmoto/ingest";
import {
  refreshAll,
  refreshRegion,
  type FsqRefreshDeps,
} from "./refresh-fsq-extracts.js";

const CZ: PoiImportRegion = {
  code: "CZ",
  bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
};
const SK: PoiImportRegion = {
  code: "SK",
  bbox: { minLng: 16.83, minLat: 47.73, maxLng: 22.57, maxLat: 49.61 },
};

/** duckdb double: parses the COPY `TO '<path>'` out of the SQL and writes a
 *  placeholder NDJSON file there, exactly as a real DuckDB COPY would. */
function fakeDuckdb(): jest.Mock<Promise<void>, [string]> {
  return jest.fn(async (sql: string) => {
    const out = /TO '([^']+)' \(FORMAT json\)/.exec(sql)?.[1];
    if (out) await writeFile(out, '{"fsq_place_id":"x"}\n');
  });
}

describe("refresh-fsq-extracts", () => {
  let targetDir: string;
  let workDir: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "fsq-refresh-test-"));
    targetDir = join(root, "extracts");
    workDir = join(root, "work");
    await mkdir(targetDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(targetDir, ".."), { recursive: true, force: true });
  });

  describe("refreshRegion", () => {
    it("runs duckdb and atomically writes <code>.fsq.jsonl", async () => {
      const duckdb = fakeDuckdb();

      await refreshRegion(CZ, targetDir, workDir, "secret-token", { duckdb });

      // The live extract exists (written via the atomic rename of the temp).
      expect(await readFile(join(targetDir, "cz.fsq.jsonl"), "utf8")).toBe(
        '{"fsq_place_id":"x"}\n',
      );
      // The SQL scoped to CZ and carried the token (never a CLI arg).
      const sql = duckdb.mock.calls[0]?.[0] ?? "";
      expect(sql).toContain("AND country = 'CZ'");
      expect(sql).toContain("TOKEN 'secret-token'");
      // No stray `.part`; only the final file remains.
      expect(await readdir(targetDir)).toEqual(["cz.fsq.jsonl"]);
    });

    it("keeps the previous extract (no truncated write) when duckdb fails", async () => {
      await writeFile(join(targetDir, "cz.fsq.jsonl"), "OLD-GOOD");
      const duckdb = jest.fn(async (sql: string) => {
        // Simulate DuckDB writing a partial file then erroring mid-COPY.
        const out = /TO '([^']+)' \(FORMAT json\)/.exec(sql)?.[1];
        if (out) await writeFile(out, "partial");
        throw new Error("duckdb exit 1: IO Error");
      });

      await expect(
        refreshRegion(CZ, targetDir, workDir, "tok", { duckdb }),
      ).rejects.toThrow("duckdb exit 1");

      // Live extract untouched; the partial temp cleaned up.
      expect(await readFile(join(targetDir, "cz.fsq.jsonl"), "utf8")).toBe(
        "OLD-GOOD",
      );
      expect(await readdir(targetDir)).toEqual(["cz.fsq.jsonl"]);
    });
  });

  describe("refreshAll", () => {
    it("throws when the target dir is not configured", async () => {
      await expect(
        refreshAll(
          { enabled: true, token: "tok", targetDir: null, regions: [CZ] },
          workDir,
          { duckdb: fakeDuckdb() },
        ),
      ).rejects.toThrow(/TARMOTO_FSQ_POI_IMPORT_DIR/);
    });

    it("throws when the token is missing", async () => {
      await expect(
        refreshAll(
          { enabled: true, token: null, targetDir, regions: [CZ] },
          workDir,
          { duckdb: fakeDuckdb() },
        ),
      ).rejects.toThrow(/TARMOTO_FSQ_POI_TOKEN/);
    });

    it("isolates a per-region failure, continues, and surfaces it in the summary", async () => {
      const duckdb = jest.fn(async (sql: string) => {
        // Fail only SK's query; CZ's succeeds.
        if (sql.includes("AND country = 'SK'")) {
          throw new Error("SK query boom");
        }
        const out = /TO '([^']+)' \(FORMAT json\)/.exec(sql)?.[1];
        if (out) await writeFile(out, '{"fsq_place_id":"x"}\n');
      });

      const summary = await refreshAll(
        { enabled: true, token: "tok", targetDir, regions: [CZ, SK] },
        workDir,
        { duckdb },
        () => undefined, // silence logs
      );

      expect(summary.ok).toEqual(["CZ"]);
      expect(summary.failed).toHaveLength(1);
      expect(summary.failed[0]?.code).toBe("SK");
      expect(summary.failed[0]?.error).toContain("SK query boom");
      // Only CZ's extract landed; SK kept nothing (it had none).
      expect(await readdir(targetDir)).toEqual(["cz.fsq.jsonl"]);
    });

    it("passes each region its own temp path as the COPY target", async () => {
      const targets: string[] = [];
      const duckdb: FsqRefreshDeps["duckdb"] = jest.fn(async (sql: string) => {
        const out = /TO '([^']+)' \(FORMAT json\)/.exec(sql)?.[1];
        if (out) {
          targets.push(out);
          await writeFile(out, "{}\n");
        }
      });

      await refreshAll(
        { enabled: true, token: "tok", targetDir, regions: [CZ, SK] },
        workDir,
        { duckdb },
        () => undefined,
      );

      // Each COPY targets a distinct `.refresh.part` sibling of the final file.
      expect(targets).toHaveLength(2);
      expect(targets[0]).toContain("cz.fsq.jsonl.");
      expect(targets[0]?.endsWith(".refresh.part")).toBe(true);
      expect(targets[1]).toContain("sk.fsq.jsonl.");
      expect(new Set(targets).size).toBe(2);
    });
  });
});
