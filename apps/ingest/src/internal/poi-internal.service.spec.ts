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
    it("emits DEFAULT_REGIONS rows only for ENABLED sources, with configured reflecting the regions list", async () => {
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

      // fsq is disabled → zero fsq rows; osm enabled → one row per
      // DEFAULT_REGIONS code.
      expect(rows.every((r) => r.source === "osm")).toBe(true);
      const osmCz = rows.find((r) => r.code === "CZ");
      expect(osmCz).toMatchObject({
        source: "osm",
        code: "CZ",
        configured: true,
        poi_count: 42,
        imported_at: "2026-07-10T00:00:00.000Z",
        live_state: "idle",
      });
      // A code NOT in the source's regions list is configured:false.
      const osmDe = rows.find((r) => r.code === "DE");
      expect(osmDe?.configured).toBe(false);
    });

    // Review gap: every `fakeImporter(...)` above omits `extractDirConfigured`
    // (defaults false), so `statusFor`'s `if (configured &&
    // importer.extractDirConfigured)` block was never exercised. That guard is
    // safety-critical: the real `getExtractPath` THROWS for a code outside the
    // importer's `regions`, and `configured &&` is the only thing stopping
    // that throw from rejecting the whole `Promise.all` in `listRegionStatus`
    // (a 500 on the entire admin coverage endpoint). "Enabled source, extract
    // dir configured, code not in its regions" is the everyday production
    // shape (e.g. FSQ is CZ-only), so it must be covered.
    describe("extract-path guard (statusFor's configured && extractDirConfigured branch)", () => {
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

      it("stats a configured region's extract, and short-circuits (never calls getExtractPath) for an out-of-scope region on the SAME importer", async () => {
        // Mirrors the real getExtractPath: throws for any code outside
        // `regions` — a jest.fn so we can assert it's never invoked for DE.
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

        // CZ: configured AND dir configured → the present-file branch runs.
        const cz = rows.find((r) => r.code === "CZ");
        expect(cz?.configured).toBe(true);
        expect(cz?.extract).toEqual({
          present: true,
          size_bytes: 2048,
          modified_at: new Date(mtimeMs).toISOString(),
        });

        // DE: NOT in this importer's regions → configured:false. Proving the
        // short-circuit (not a swallowed throw) requires showing
        // getExtractPath was never called for it.
        const de = rows.find((r) => r.code === "DE");
        expect(de?.configured).toBe(false);
        expect(de?.extract).toBeNull();
        expect(getExtractPath).not.toHaveBeenCalledWith("DE");
        // Stronger: called exactly once, for CZ only — proves every other
        // DEFAULT_REGIONS code short-circuited before reaching it.
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
});
