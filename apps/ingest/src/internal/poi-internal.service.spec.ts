// Mock `node:fs/promises` so `stat` is deterministic for the extract-path
// guard tests below (the `configured && extractDirConfigured` branch of
// `statusFor`). requireActual keeps the rest of fs/promises intact.
jest.mock("node:fs/promises", () => {
  const actual =
    jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    stat: jest.fn(),
  };
});

import { stat } from "node:fs/promises";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PoiInternalService } from "./poi-internal.service.js";

const statMock = jest.mocked(stat);

// A fake PoiImportService registry entry — only the getters the internal
// service reads.
function fakeImporter(over: {
  source: string;
  enabled: boolean;
  regions: string[];
  extractDirConfigured?: boolean;
  getExtractPath?: (code: string) => string;
}) {
  return {
    source: over.source,
    enabled: over.enabled,
    regions: over.regions.map((code) => ({
      code,
      bbox: { minLng: 0, minLat: 0, maxLng: 1, maxLat: 1 },
    })),
    extractDirConfigured: over.extractDirConfigured ?? false,
    getExtractPath:
      over.getExtractPath ??
      ((code: string) => `/extracts/${code.toLowerCase()}.osm`),
  };
}

describe("PoiInternalService", () => {
  describe("listRegionStatus", () => {
    it("emits rows only for ENABLED sources, scoped to each source's OWN configured regions (#1011 review, FIX 1)", async () => {
      const dataSource = {
        isInitialized: true,
        query: jest.fn((sql: string) => {
          if (sql.includes("poi_import_regions"))
            return [{ code: "CZ", imported_at: "2026-07-10T00:00:00Z" }];
          if (sql.toLowerCase().includes("group by"))
            return [{ source: "osm", import_region: "CZ", n: "42" }];
          return [];
        }),
      };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const queue = { getJobs: jest.fn().mockResolvedValue([]) };
      const importers = [
        fakeImporter({ source: "osm", enabled: true, regions: ["CZ", "SK"] }),
        fakeImporter({ source: "fsq", enabled: false, regions: ["CZ"] }),
      ];

      const svc = new PoiInternalService(
        dataSource as never,
        runsRepo as never,
        queue as never,
        importers as never,
      );

      const rows = await svc.listRegionStatus();

      // fsq is disabled → zero fsq rows; osm enabled → EXACTLY its own
      // configured regions (CZ, SK) — not the full DEFAULT_REGIONS list.
      expect(rows.every((r) => r.source === "osm")).toBe(true);
      expect(rows.map((r) => r.code).sort()).toEqual(["CZ", "SK"]);
      const osmCz = rows.find((r) => r.code === "CZ");
      expect(osmCz).toMatchObject({
        source: "osm",
        code: "CZ",
        configured: true,
        poi_count: 42,
        imported_at: "2026-07-10T00:00:00.000Z",
        live_state: "idle",
      });
      // A code NOT in the source's regions list (DE is outside osm's
      // ['CZ','SK']) must be ABSENT from the response entirely — NOT a
      // `configured:false` row. The admin table (`PoiImportsScreen`) only
      // renders its "Not configured" state for an ABSENT cell; a PRESENT row
      // with `configured:false` still shows as a real, clickable cell, which
      // is exactly the bug FIX 1 closes.
      expect(rows.find((r) => r.code === "DE")).toBeUndefined();
    });

    // #1011 review (FIX 1): BEFORE this fix, `pairs` was built from every
    // enabled source × the full `DEFAULT_REGIONS` list, so "enabled source,
    // extract dir configured, code NOT in its regions" was a real, everyday
    // production shape (e.g. FSQ is CZ-only) that reached `statusFor` with
    // `configured: false` — and the `configured &&` guard below was the only
    // thing stopping the real `getExtractPath` (which THROWS for an
    // out-of-scope code) from rejecting the whole `Promise.all` in
    // `listRegionStatus` (a 500 on the entire admin coverage endpoint).
    //
    // FIX 1 changed `pairs` to come from each importer's OWN `regions`, so an
    // out-of-scope code is now simply ABSENT from `pairs` — `statusFor` is
    // never invoked with `configured: false` in production anymore, and the
    // `&&` guard is kept purely as defence against a future regression
    // reopening that path (see `listRegionStatus`'s own comment). The tests
    // below now cover the ordinary present-file / ENOENT branches for a
    // genuinely CONFIGURED code.
    describe("extract stat (present-file / ENOENT) via statusFor's extractDirConfigured guard", () => {
      beforeEach(() => {
        statMock.mockReset();
      });

      // Minimal harness shared by both tests below — only the importer list
      // and `stat` behaviour differ per test.
      function harnessWith(importers: unknown[]): PoiInternalService {
        const dataSource = { isInitialized: true, query: jest.fn(() => []) };
        const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
        const queue = { getJobs: jest.fn().mockResolvedValue([]) };
        return new PoiInternalService(
          dataSource as never,
          runsRepo as never,
          queue as never,
          importers as never,
        );
      }

      it("stats a configured region's extract (present file)", async () => {
        // Mirrors the real getExtractPath: throws for any code outside
        // `regions`. Under FIX 1 this importer's ONLY row is CZ (its own
        // `regions` list), so an out-of-scope code (e.g. DE) never reaches
        // `listRegionStatus`'s `pairs` at all anymore — there is no longer a
        // reachable `listRegionStatus` path that calls `getExtractPath` for a
        // code outside `regions` to short-circuit around (that scenario was
        // dropped here; see the describe-level comment above). `getExtractPath`
        // stays a jest.fn so the assertions below can still pin exactly how
        // many times, and with what argument, it's invoked.
        const getExtractPath = jest.fn((code: string) => {
          if (code !== "CZ") {
            throw new Error(`Unknown POI import region code: ${code}`);
          }
          return "/extracts/cz.osm";
        });
        const mtimeMs = new Date("2026-07-10T12:00:00Z").getTime();
        statMock.mockResolvedValueOnce({
          isFile: () => true,
          size: 2048,
          mtimeMs,
        } as unknown as Awaited<ReturnType<typeof stat>>);
        const svc = harnessWith([
          fakeImporter({
            source: "fsq",
            enabled: true,
            regions: ["CZ"], // narrow — FSQ is CZ-only in production
            extractDirConfigured: true,
            getExtractPath,
          }),
        ]);

        const rows = await svc.listRegionStatus();

        // CZ is the ONLY row (fsq's own `regions`, FIX 1) — configured AND
        // dir configured → the present-file branch runs.
        expect(rows).toHaveLength(1);
        const cz = rows.find((r) => r.code === "CZ");
        expect(cz?.configured).toBe(true);
        expect(cz?.extract).toEqual({
          present: true,
          size_bytes: 2048,
          modified_at: new Date(mtimeMs).toISOString(),
        });
        expect(getExtractPath).toHaveBeenCalledTimes(1);
        expect(getExtractPath).toHaveBeenCalledWith("CZ");
      });

      it("reports extract: null (swallows ENOENT) when a configured region's extract file has not been uploaded yet", async () => {
        statMock.mockRejectedValueOnce(
          Object.assign(new Error("ENOENT: no such file or directory"), {
            code: "ENOENT",
          }),
        );
        const svc = harnessWith([
          fakeImporter({
            source: "fsq",
            enabled: true,
            regions: ["CZ"],
            extractDirConfigured: true,
          }),
        ]);

        const rows = await svc.listRegionStatus();

        expect(rows).toHaveLength(1);
        const cz = rows.find((r) => r.code === "CZ");
        expect(cz?.configured).toBe(true);
        expect(cz?.extract).toBeNull();
      });
    });
  });

  describe("triggerImport", () => {
    const enabledOsm = () => [
      fakeImporter({ source: "osm", enabled: true, regions: ["CZ", "SK"] }),
    ];

    it("400s an unknown source", async () => {
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        {} as never,
        enabledOsm() as never,
      );
      await expect(svc.triggerImport("bogus", "CZ")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("400s an unknown region code (not in DEFAULT_REGIONS) — distinct from the enablement 400 below", async () => {
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        {} as never,
        enabledOsm() as never, // osm is enabled and configured for CZ/SK
      );
      await expect(svc.triggerImport("osm", "ZZ")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("400s a disabled/unconfigured pair (enablement view)", async () => {
      const importers = [
        fakeImporter({ source: "fsq", enabled: false, regions: ["CZ"] }),
      ];
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        { getJobs: jest.fn() } as never,
        importers as never,
      );
      await expect(svc.triggerImport("fsq", "CZ")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("enqueues a manual region job and returns its id", async () => {
      const add = jest.fn();
      const queue = { getJobs: jest.fn().mockResolvedValue([]), add };
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        queue as never,
        enabledOsm() as never,
      );

      const res = await svc.triggerImport("osm", "CZ");

      expect(res.job_id).toBe("import-region_manual_osm_CZ");
      expect(add).toHaveBeenCalledWith(
        "import-region",
        { code: "CZ", source: "osm", trigger: "manual" },
        expect.objectContaining({
          jobId: "import-region_manual_osm_CZ",
          attempts: 3,
          removeOnComplete: true,
          removeOnFail: true,
        }),
      );
    });

    it("409s when a job for the same (source, code) is already in flight", async () => {
      const queue = {
        getJobs: jest
          .fn()
          .mockResolvedValue([{ data: { code: "CZ", source: "osm" } }]),
        add: jest.fn(),
      };
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        queue as never,
        enabledOsm() as never,
      );
      await expect(svc.triggerImport("osm", "CZ")).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  // Backs `GET /internal/poi/import-status` (#1011 review, FIX 2) — the
  // backend's `storeExtract` best-effort-calls this to restore the
  // upload-vs-import guard Phase 3 dropped. A thin wrapper over the SAME
  // `importInFlight` scan `triggerImport`'s own 409 test above exercises, so
  // these tests pin the wrapper's `{ in_flight }` shape and the scoping
  // (same source AND code — not source-only or code-only) rather than
  // re-deriving the underlying queue-scan behavior from scratch.
  describe("importStatus", () => {
    it("reports in_flight: true when a job for the same (source, code) is queued/active", async () => {
      const queue = {
        getJobs: jest
          .fn()
          .mockResolvedValue([{ data: { code: "CZ", source: "osm" } }]),
      };
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        queue as never,
        [] as never,
      );

      await expect(svc.importStatus("osm", "CZ")).resolves.toEqual({
        in_flight: true,
      });
    });

    it("reports in_flight: false when no job is queued/active at all", async () => {
      const queue = { getJobs: jest.fn().mockResolvedValue([]) };
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        queue as never,
        [] as never,
      );

      await expect(svc.importStatus("osm", "CZ")).resolves.toEqual({
        in_flight: false,
      });
    });

    it("reports in_flight: false when the only queued jobs are for a DIFFERENT region or source (scoped match)", async () => {
      const queue = {
        getJobs: jest.fn().mockResolvedValue([
          { data: { code: "SK", source: "osm" } }, // same source, different code
          { data: { code: "CZ", source: "fsq" } }, // same code, different source
        ]),
      };
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        queue as never,
        [] as never,
      );

      await expect(svc.importStatus("osm", "CZ")).resolves.toEqual({
        in_flight: false,
      });
    });
  });
});
