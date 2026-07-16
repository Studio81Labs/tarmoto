import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REFRESH_TMP_SUFFIX,
  describeExecError,
  refreshTmpPath,
  sweepStaleTempFiles,
} from "./refresh-common.js";

describe("refresh-common", () => {
  describe("refreshTmpPath", () => {
    it("is a sibling of the final file carrying the refresh marker suffix", () => {
      const tmp = refreshTmpPath("/data/poi-extracts/cz.osm");
      expect(tmp.startsWith("/data/poi-extracts/cz.osm.")).toBe(true);
      expect(tmp.endsWith(REFRESH_TMP_SUFFIX)).toBe(true);
      // NOT the admin upload's plain `.part` — the sweep must tell them apart.
      expect(tmp.endsWith(".part") && !tmp.endsWith(REFRESH_TMP_SUFFIX)).toBe(
        false,
      );
    });

    it("is unique per call so concurrent runs never collide", () => {
      const a = refreshTmpPath("/x/cz.osm");
      const b = refreshTmpPath("/x/cz.osm");
      expect(a).not.toBe(b);
    });
  });

  describe("describeExecError", () => {
    it("flags a SIGKILL as a likely OOM (the killer case for a country PBF)", () => {
      expect(
        describeExecError("osmium tags-filter", { signal: "SIGKILL" }),
      ).toBe("osmium tags-filter killed by SIGKILL (out of memory?)");
    });

    it("names a non-SIGKILL signal without the OOM hint", () => {
      expect(describeExecError("duckdb", { signal: "SIGTERM" })).toBe(
        "duckdb killed by SIGTERM",
      );
    });

    it("reports the exit code + the tool stderr for a normal error exit", () => {
      const msg = describeExecError("osmium extract", {
        code: 1,
        stderr: "Open failed for output file 'x': No space left on device",
      });
      expect(msg).toContain("osmium extract exit 1");
      expect(msg).toContain("No space left on device");
    });

    it("falls back to a `?` exit when neither signal nor code is present", () => {
      expect(describeExecError("duckdb", {})).toBe("duckdb exit ?");
    });
  });

  describe("sweepStaleTempFiles", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "refresh-common-test-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reclaims stale refresh temps but keeps recent ones and any upload .part", async () => {
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h > 1h threshold
      // Stale orphan from a killed run → reclaimed.
      await writeFile(join(dir, "cz.osm.9.dead.refresh.part"), "orphan");
      await utimes(join(dir, "cz.osm.9.dead.refresh.part"), old, old);
      // Recently-written refresh temp → could be a CONCURRENT run's active
      // output, so it must NOT be swept even though the suffix matches.
      await writeFile(join(dir, "sk.osm.8.beef.refresh.part"), "active");
      // An admin upload's plain `.part` — never ours, kept even when old.
      await writeFile(join(dir, "cz.osm.1.abc.part"), "upload");
      await utimes(join(dir, "cz.osm.1.abc.part"), old, old);
      // A live extract — untouched.
      await writeFile(join(dir, "cz.osm"), "live");

      const logs: string[] = [];
      await sweepStaleTempFiles(dir, (m) => logs.push(m));

      expect((await readdir(dir)).sort()).toEqual([
        "cz.osm",
        "cz.osm.1.abc.part",
        "sk.osm.8.beef.refresh.part",
      ]);
      expect(logs.join("\n")).toContain("swept 1 stale temp file");
    });

    it("is silent when there is nothing to sweep", async () => {
      await writeFile(join(dir, "cz.osm"), "live");
      const logs: string[] = [];
      await sweepStaleTempFiles(dir, (m) => logs.push(m));
      expect(logs).toEqual([]);
    });
  });
});
