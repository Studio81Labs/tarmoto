import { BadRequestException, ConflictException } from "@nestjs/common";
import { PoiInternalService } from "./poi-internal.service.js";

// A fake PoiImportService registry entry — only the getters the internal
// service reads.
function fakeImporter(over: {
  source: string;
  enabled: boolean;
  regions: string[];
  extractDirConfigured?: boolean;
}) {
  return {
    source: over.source,
    enabled: over.enabled,
    regions: over.regions.map((code) => ({
      code,
      bbox: { minLng: 0, minLat: 0, maxLng: 1, maxLat: 1 },
    })),
    extractDirConfigured: over.extractDirConfigured ?? false,
    getExtractPath: (code: string) => `/extracts/${code.toLowerCase()}.osm`,
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
