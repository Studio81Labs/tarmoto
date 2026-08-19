// Mock `node:fs` so the file-existence check + read are deterministic
// (createReadStream's return is handed straight to the source's `parse`,
// which the OSM stub below ignores; the FSQ source reads a REAL stream, so
// its tests override `createReadStream` with one via `mockFsqExtract`).
// requireActual keeps the rest of fs intact for TypeORM et al. loaded here.
jest.mock("node:fs", () => {
  const actual = jest.requireActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: jest.fn(() => true),
    createReadStream: jest.fn(
      () => ({}) as ReturnType<typeof actual.createReadStream>,
    ),
  };
});

import { ServiceUnavailableException } from "@nestjs/common";
import type { DataSource } from "typeorm";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { PoiImportService, WIPE_GUARD_WARNING } from "./poi-import.service.js";
import {
  FsqPoiImportSource,
  type AccommodationPoi,
  type ImportedPoi,
  type PoiImportRegion,
  type PoiImportSource,
  type StorableImportRow,
  type StoredPoiFields,
} from "@tarmoto/ingest";
import type { PoiImportConfig } from "./poi-import.config.js";

const existsSyncMock = jest.mocked(existsSync);
const createReadStreamMock = jest.mocked(createReadStream);

// --- fixtures --------------------------------------------------------------

const NO_STORED_FIELDS: StoredPoiFields = {
  opening_hours: null,
  address_street: null,
  address_city: null,
  address_postcode: null,
  address_country: null,
  cuisine: null,
  brand: null,
  tags: null,
};

type ExtractItem = { poi: ImportedPoi } | { accommodation: AccommodationPoi };

function poi(over: Partial<ImportedPoi> = {}): ExtractItem {
  return {
    poi: {
      external_id: "node/1",
      name: "U Fleku",
      kind: "restaurant",
      lat: 49.5,
      lng: 18.4,
      website: null,
      phone: null,
      ...NO_STORED_FIELDS,
      ...over,
    },
  };
}

function accommodation(over: Partial<AccommodationPoi> = {}): ExtractItem {
  return {
    accommodation: {
      external_id: "way/10",
      name: "Hotel Beskyd",
      kind: "hotel",
      lat: 49.55,
      lng: 18.45,
      website: null,
      phone: null,
      stars: 3,
      ...NO_STORED_FIELDS,
      ...over,
    },
  };
}

// Controllable OSM-shaped source. importRegion() streams through source.parse(),
// so setting `stubExtract` replaces the old parsePoiExtract module-mock (which a
// package-boundary jest.mock can no longer intercept now that the parser is
// package-internal). Unwraps ExtractItem exactly like the real OsmPoiImportSource.
let stubExtract: ExtractItem[] = [];
let stubParseCalls = 0;
class StubOsmSource implements PoiImportSource {
  readonly source = "osm";
  extractFilename(region: PoiImportRegion): string {
    return `${region.code.toLowerCase()}.osm`;
  }
  async *parse(): AsyncGenerator<StorableImportRow> {
    stubParseCalls += 1;
    await Promise.resolve(); // async boundary — mirrors the streaming parser shape
    for (const item of stubExtract) {
      yield "poi" in item ? item.poi : item.accommodation;
    }
  }
}

/** Point the stub source at a fresh set of items (generators are single-use per call). */
function mockExtract(...items: ExtractItem[]): void {
  stubExtract = items;
}

/**
 * One line of FSQ OS Places NDJSON (see `FsqPoiImportSource.parse`), inside
 * `REGION`'s bbox (lng 18.4, lat 49.5) and classifying to `restaurant`.
 * Unlike OSM (driven through `StubOsmSource` above), the FSQ strategy reads
 * the stream `createReadStream` returns directly — so driving a real FSQ
 * import needs an actual `Readable`.
 */
function fsqLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    fsq_place_id: "a",
    name: "U Fleku FSQ",
    latitude: 49.5,
    longitude: 18.4,
    category_ids: null,
    category_labels: "Restaurant",
    tel: null,
    website: null,
    address: null,
    locality: null,
    postcode: null,
    country: null,
    ...over,
  });
}

/** Point the next `createReadStream` call at a real NDJSON stream of the given lines. */
function mockFsqExtract(...lines: string[]): void {
  createReadStreamMock.mockReturnValueOnce(
    Readable.from([lines.join("\n")]) as unknown as ReturnType<
      typeof createReadStream
    >,
  );
}

describe("PoiImportService", () => {
  // The launch region; fixture points (lng 18.4, lat 49.5) fall inside it.
  const REGION: PoiImportRegion = {
    code: "CZ",
    bbox: { minLng: 18, minLat: 49.3, maxLng: 18.9, maxLat: 49.75 },
  };

  let upsert: jest.Mock;
  let txQuery: jest.Mock;
  let probe: jest.Mock;
  let runnerConnect: jest.Mock;
  let runnerQuery: jest.Mock;
  let runnerRelease: jest.Mock;
  let createQueryRunner: jest.Mock;
  let dataSource: DataSource;
  let config: PoiImportConfig;
  let service: PoiImportService;

  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    stubExtract = []; // default: empty extract
    stubParseCalls = 0;

    upsert = jest.fn().mockResolvedValue(undefined);
    // Default: no live rows inside the bbox → nothing to tombstone. The
    // coverage-stamp UPDATE (RETURNING "code", #978) resolves to one row — the
    // normal case where the region's boundary was loaded before importing — so
    // the "no boundary row" warning stays silent unless a test forces [].
    txQuery = jest
      .fn()
      .mockImplementation((sql: string) =>
        Promise.resolve(
          typeof sql === "string" && sql.includes('SET "imported_at"')
            ? [{ code: REGION.code }]
            : [],
        ),
      );
    const tx = { getRepository: jest.fn(() => ({ upsert })), query: txQuery };
    const repo = {
      manager: {
        transaction: jest.fn(
          (cb: (m: typeof tx) => Promise<unknown>): Promise<unknown> => cb(tx),
        ),
      },
    };
    probe = jest.fn().mockResolvedValue([{ "?column?": 1 }]);
    // The per-(source, region) advisory lock (#847) runs on a dedicated
    // QueryRunner (connection affinity for lock + unlock), not the pooled
    // `dataSource.query`. Default to "lock acquired" so every existing import
    // test proceeds unaffected; the lock-specific tests below override
    // `runnerQuery`'s resolved value per case.
    runnerConnect = jest.fn().mockResolvedValue(undefined);
    runnerQuery = jest.fn().mockResolvedValue([{ locked: true }]);
    runnerRelease = jest.fn().mockResolvedValue(undefined);
    createQueryRunner = jest.fn(() => ({
      connect: runnerConnect,
      query: runnerQuery,
      release: runnerRelease,
    }));
    dataSource = {
      isInitialized: true,
      query: probe,
      getRepository: jest.fn(() => repo),
      createQueryRunner,
    } as unknown as DataSource;
    config = { enabled: true, extractDir: "/extracts", regions: [REGION] };
    service = new PoiImportService(dataSource, config, new StubOsmSource());
  });

  /** Rows passed to the first `upsert` call. */
  const firstUpsertRows = (): Array<Record<string, unknown>> => {
    const call = upsert.mock.calls[0] as
      [Array<Record<string, unknown>>, unknown] | undefined;
    if (!call) throw new Error("expected upsert to have been called");
    return call[0];
  };

  /** Make the bbox-bounded stale load return these live in-bbox rows. */
  const loadInBbox = (
    rows: Array<{
      id: string;
      external_id: string;
      lng?: number;
      lat?: number;
      import_region?: string | null;
    }>,
  ): void => {
    txQuery.mockImplementation((sql: string) =>
      sql.includes("ST_MakeEnvelope")
        ? Promise.resolve(rows)
        : sql.includes('SET "imported_at"')
          ? // Coverage stamp (RETURNING "code", #978) hits its boundary row —
            // these tombstone tests assume boundaries were loaded.
            Promise.resolve([{ code: REGION.code }])
          : Promise.resolve(undefined),
    );
  };

  it("reflects the enabled flag and the configured regions", () => {
    expect(service.enabled).toBe(true);
    expect(service.regions).toEqual([REGION]);
  });

  describe("getExtractPath (#847 admin status read)", () => {
    it("resolves a configured region to <extractDir>/<code>.osm for the OSM strategy", () => {
      expect(service.getExtractPath("CZ")).toBe("/extracts/cz.osm");
    });

    it("resolves to <extractDir>/<code>.fsq.jsonl for the FSQ strategy", () => {
      const fsqService = new PoiImportService(
        dataSource,
        config,
        new FsqPoiImportSource(),
      );
      expect(fsqService.getExtractPath("CZ")).toBe("/extracts/cz.fsq.jsonl");
    });

    it("throws for a code outside this instance's configured regions", () => {
      expect(() => service.getExtractPath("XX")).toThrow(
        /Unknown POI import region/,
      );
    });

    it("throws when extractDir is not configured, same as the internal resolver", () => {
      config.extractDir = null;
      service = new PoiImportService(dataSource, config, new StubOsmSource());
      expect(() => service.getExtractPath("CZ")).toThrow(
        /TARMOTO_OSM_POI_IMPORT_DIR is not set/,
      );
    });
  });

  describe("per-region advisory lock (#847: manual trigger vs. cron)", () => {
    it("acquires and releases the lock on ONE pinned QueryRunner (connection affinity)", async () => {
      mockExtract(poi({ external_id: "node/1" }));

      await service.importRegion(REGION);

      // Exactly one QueryRunner is created for the whole call — the lock and
      // the unlock must run on the SAME connection, not two pool checkouts.
      expect(createQueryRunner).toHaveBeenCalledTimes(1);
      expect(runnerConnect).toHaveBeenCalledTimes(1);
      expect(runnerQuery).toHaveBeenCalledTimes(2);
      const lockCalls = runnerQuery.mock.calls as Array<[string, unknown[]]>;
      expect(lockCalls[0]?.[0]).toMatch(/pg_try_advisory_lock/);
      expect(lockCalls[1]?.[0]).toMatch(/pg_advisory_unlock/);
      // Both calls target the same (namespace, key) pair.
      expect(lockCalls[1]?.[1]).toEqual(lockCalls[0]?.[1]);
      expect(runnerRelease).toHaveBeenCalledTimes(1);
      // The pooled `dataSource.query` never sees the advisory-lock SQL — the
      // lock/unlock ran on the pinned runner, never the shared pool.
      expect(probe).not.toHaveBeenCalledWith(
        expect.stringContaining("advisory"),
      );
    });

    it("throws (and never touches the extract) when the region is already locked by a concurrent import", async () => {
      runnerQuery.mockResolvedValueOnce([{ locked: false }]); // the pg_try_advisory_lock call only

      await expect(service.importRegion(REGION)).rejects.toThrow(
        /already running/,
      );
      expect(existsSyncMock).not.toHaveBeenCalled();
      expect(stubParseCalls).toBe(0);
      expect(upsert).not.toHaveBeenCalled();
      // No unlock call — the lock was never acquired — but the runner backing
      // the failed attempt is still released back to the pool.
      expect(runnerQuery).toHaveBeenCalledTimes(1);
      expect(runnerRelease).toHaveBeenCalledTimes(1);
    });

    it("still unlocks and releases the runner when the import body throws", async () => {
      mockExtract(poi({ external_id: "node/1" }));
      upsert.mockRejectedValueOnce(new Error("boom"));

      await expect(service.importRegion(REGION)).rejects.toThrow("boom");

      // The finally-unwind still ran despite the throw deep inside the body.
      expect(runnerQuery).toHaveBeenCalledTimes(2);
      const unlockCalls = runnerQuery.mock.calls as Array<[string, unknown[]]>;
      expect(unlockCalls[1]?.[0]).toMatch(/pg_advisory_unlock/);
      expect(runnerRelease).toHaveBeenCalledTimes(1);
    });
  });

  it("imports a region: upserts by (source, external_id) with a revive (deactivated_at:null) and a Point geom", async () => {
    mockExtract(
      poi({ external_id: "node/1" }),
      poi({ external_id: "node/2", kind: "cafe", lat: 49.6, lng: 18.5 }),
    );

    const result = await service.importRegion(REGION);

    // Extract path is `<dir>/<code>.osm`, lower-cased.
    expect(existsSyncMock).toHaveBeenCalledWith("/extracts/cz.osm");
    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows, options] = upsert.mock.calls[0] as [
      Array<Record<string, unknown>>,
      Record<string, unknown>,
    ];
    expect(options).toEqual(
      expect.objectContaining({ conflictPaths: ["source", "external_id"] }),
    );
    expect(rows[0]).toEqual(
      expect.objectContaining({
        source: "osm",
        external_id: "node/1",
        kind: "restaurant",
        // Revive: a re-import clears any prior tombstone via the upsert.
        deactivated_at: null,
        // Region ownership drives the overlap-safe tombstone scope.
        import_region: "CZ",
        geom: { type: "Point", coordinates: [18.4, 49.5] },
      }),
    );
    expect(rows[0]?.last_imported_at).toBeInstanceOf(Date);
    expect(result).toEqual({
      region: "CZ",
      fetched: 2,
      upserted: 2,
      tombstoned: 0,
      skipReason: null,
      warning: null,
    });
  });

  it("stamps poi_import_regions.imported_at on a successful OSM import", async () => {
    mockExtract(poi({ external_id: "node/1" }));

    await service.importRegion(REGION);

    expect(txQuery).toHaveBeenCalledWith(
      expect.stringContaining(
        'UPDATE "poi_import_regions" SET "imported_at" = now()',
      ),
      ["CZ"],
    );
  });

  it("warns (does not silently drop coverage) when the stamp matches no poi_import_regions row — boundaries not loaded before import (#978)", async () => {
    // Force the coverage-stamp UPDATE to affect 0 rows: the region has no
    // boundary polygon yet (poi:load-boundaries not run before this import).
    txQuery.mockResolvedValue([]);
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: (m: string) => void } })
          .logger,
        "warn",
      )
      .mockImplementation(() => undefined);
    mockExtract(poi({ external_id: "node/1" }));

    const result = await service.importRegion(REGION);

    // Still a genuine, committed import — only coverage went unstamped.
    expect(result.skipped).toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(1);
    // The stamp UPDATE was issued (RETURNING variant)...
    expect(txQuery).toHaveBeenCalledWith(
      expect.stringContaining(
        'UPDATE "poi_import_regions" SET "imported_at" = now()',
      ),
      ["CZ"],
    );
    // ...and its 0-row result is surfaced, pointing at the fix.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("poi:load-boundaries"),
    );
  });

  it("does not stamp poi_import_regions.imported_at on a successful FSQ import (#944: coverage stays OSM-only)", async () => {
    // An FSQ-only region must never read as "covered" — the coverage query
    // this stamp feeds gates the OSM Overpass fallback on `source = 'osm'`
    // rows, so stamping here would wrongly suppress that fallback for a
    // region OSM has never actually imported.
    mockFsqExtract(fsqLine());
    const fsqService = new PoiImportService(
      dataSource,
      config,
      new FsqPoiImportSource(),
    );

    const result = await fsqService.importRegion(REGION);

    // Sanity: this is a genuine import (not a skip) — the FSQ row parsed,
    // fell inside the bbox, and was upserted — so the absence of the stamp
    // below is the source gate, not an incidental skip path.
    expect(result.skipped).toBeUndefined();
    expect(result.skipReason).toBeNull();
    expect(result.warning).toBeNull();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("poi_import_regions"),
      expect.anything(),
    );
  });

  it("does not stamp imported_at when the region is skipped (no extract)", async () => {
    existsSyncMock.mockReturnValueOnce(false);

    await service.importRegion(REGION);

    expect(txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("poi_import_regions"),
      expect.anything(),
    );
  });

  it("does not stamp imported_at when the extract yields zero in-bbox rows (empty-extract skip)", async () => {
    mockExtract(); // empty — the other skip path (valid file, nothing usable)

    const result = await service.importRegion(REGION);

    expect(result.skipped).toBe(true);
    // #847 review: the concrete, operator-actionable reason — not a generic
    // "skipped" string — flows out on the result itself.
    expect(result.skipReason).toBe(
      "extract yielded 0 in-bbox rows (fetched=0)",
    );
    expect(txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("poi_import_regions"),
      expect.anything(),
    );
  });

  it("imports accommodations alongside POIs in the same upsert", async () => {
    mockExtract(
      poi({ external_id: "node/1" }),
      accommodation({ external_id: "way/10", kind: "hotel", stars: 4 }),
    );

    const result = await service.importRegion(REGION);

    const rows = firstUpsertRows();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          external_id: "way/10",
          kind: "hotel",
          stars: 4,
          geom: { type: "Point", coordinates: [18.45, 49.55] },
        }),
      ]),
    );
    expect(result.upserted).toBe(2);
  });

  it("dedupes by external_id (last write wins) so a duplicated id imports once", async () => {
    mockExtract(
      poi({ external_id: "node/1", name: "Old" }),
      poi({ external_id: "node/1", name: "New" }),
    );

    const result = await service.importRegion(REGION);

    const rows = firstUpsertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("New");
    expect(result).toEqual({
      region: "CZ",
      fetched: 2,
      upserted: 1,
      tombstoned: 0,
      skipReason: null,
      warning: null,
    });
  });

  it("drops rows whose point falls outside the region bbox (osmium overhang) from the upsert", async () => {
    mockExtract(
      poi({ external_id: "node/in", lat: 49.5, lng: 18.4 }),
      poi({ external_id: "node/out", lat: 10, lng: 10 }),
    );

    const result = await service.importRegion(REGION);

    const rows = firstUpsertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.external_id).toBe("node/in");
    // `fetched` counts both (the overhang row is read, then filtered); only the
    // in-bbox row is written.
    expect(result).toEqual({
      region: "CZ",
      fetched: 2,
      upserted: 1,
      tombstoned: 0,
      skipReason: null,
      warning: null,
    });
  });

  it("clamps an over-long tag (a semicolon phone list) to the column width", async () => {
    const longPhone = Array(50).fill("+420 555 111 222").join("; "); // > 255
    mockExtract(poi({ external_id: "node/1", phone: longPhone }));

    await service.importRegion(REGION);

    const phone = firstUpsertRows()[0]?.phone as string;
    expect(phone.length).toBe(255);
    expect(longPhone.startsWith(phone)).toBe(true);
  });

  it("tombstones only the in-bbox rows absent from the extract — an id-array UPDATE, never a DELETE", async () => {
    // Two live rows inside the bbox: node/1 is still in the extract, node/gone
    // has dropped out (closed venue).
    loadInBbox([
      { id: "uuid-present", external_id: "node/1", import_region: "CZ" },
      { id: "uuid-gone", external_id: "node/gone", import_region: "CZ" },
    ]);
    mockExtract(poi({ external_id: "node/1" }));

    const result = await service.importRegion(REGION);

    const calls = txQuery.mock.calls as Array<[string, unknown[]]>;

    // The stale-load is scoped to the region's bbox AND to `import_region` — so
    // it can only ever tombstone rows THIS region imported inside its box, never
    // a neighbour's border POI that overlaps the rectangle (the P1 fix).
    const load = calls.find(([sql]) => sql.includes("ST_MakeEnvelope"));
    expect(load).toBeDefined();
    expect(load![0]).toMatch(/import_region = \$5/);
    // Scoped to the importing source ($6) so a run never tombstones another
    // source's rows in the same bbox.
    expect(load![0]).toMatch(/source = \$6/);
    expect(load![1]).toEqual([18, 49.3, 18.9, 49.75, "CZ", "osm"]);

    // Only the absent row's id is tombstoned — a soft UPDATE, never a DELETE.
    const tombstone = calls.find(([sql]) =>
      /UPDATE pois SET deactivated_at = NOW\(\)/.test(sql),
    );
    expect(tombstone).toBeDefined();
    expect(tombstone![1]).toEqual([["uuid-gone"]]);
    expect(tombstone![0]).not.toMatch(/DELETE/i);

    expect(result.tombstoned).toBe(1);
  });

  it("never tombstones a row the bbox-bounded load does not return (out-of-bbox rows are untouched)", async () => {
    // The bounded load only surfaces the in-bbox present row. A neighbour the
    // geom-envelope filter excluded is absent from BOTH the load and the extract,
    // yet must never be tombstoned — the load is the only tombstone candidate set.
    loadInBbox([
      { id: "uuid-present", external_id: "node/1", import_region: "CZ" },
    ]);
    mockExtract(poi({ external_id: "node/1" }));

    const result = await service.importRegion(REGION);

    const tombstone = (txQuery.mock.calls as Array<[string, unknown[]]>).find(
      ([sql]) => /UPDATE pois SET deactivated_at = NOW\(\)/.test(sql),
    );
    expect(tombstone).toBeUndefined();
    expect(result.tombstoned).toBe(0);
  });

  it("claims legacy (null-region) rows only where no other configured region overlaps", async () => {
    // A neighbour whose bbox overlaps CZ's eastern edge (lng >= 18.5).
    const NEIGHBOUR: PoiImportRegion = {
      code: "SK",
      bbox: { minLng: 18.5, minLat: 49.3, maxLng: 19.5, maxLat: 49.75 },
    };
    config = {
      enabled: true,
      extractDir: "/extracts",
      regions: [REGION, NEIGHBOUR],
    };
    service = new PoiImportService(dataSource, config, new StubOsmSource());

    loadInBbox([
      // Legacy (import_region null) rows absent from the extract:
      // exclusive to CZ (lng 18.2, outside SK) → CZ tombstones it.
      {
        id: "uuid-cz",
        external_id: "node/cz",
        import_region: null,
        lng: 18.2,
        lat: 49.5,
      },
      // in the CZ∩SK overlap (lng 18.7) → ambiguous, CZ must NOT tombstone it.
      {
        id: "uuid-overlap",
        external_id: "node/overlap",
        import_region: null,
        lng: 18.7,
        lat: 49.5,
      },
    ]);
    // One live in-bbox row so the empty-extract guard doesn't short-circuit.
    mockExtract(poi({ external_id: "node/keep" }));

    const result = await service.importRegion(REGION);

    const tombstone = (txQuery.mock.calls as Array<[string, unknown[]]>).find(
      ([sql]) => /UPDATE pois SET deactivated_at = NOW\(\)/.test(sql),
    );
    // Only the CZ-exclusive legacy row — the overlap row is left for whichever
    // region's extract actually claims it.
    expect(tombstone![1]).toEqual([["uuid-cz"]]);
    expect(result.tombstoned).toBe(1);
  });

  it("refuses to tombstone when the extract yields zero in-bbox rows (broken/empty extract)", async () => {
    // A valid-but-empty extract (`<osm/>`, a failed tags-filter, or points all
    // outside the bbox) must NOT soft-deactivate the whole region — skip the
    // write entirely so a broken extract can't wipe live data.
    loadInBbox([
      { id: "uuid-a", external_id: "node/1" },
      { id: "uuid-b", external_id: "node/2" },
    ]);
    mockExtract(); // empty

    const result = await service.importRegion(REGION);

    expect(result).toEqual({
      region: "CZ",
      fetched: 0,
      upserted: 0,
      tombstoned: 0,
      skipped: true,
      skipReason: "extract yielded 0 in-bbox rows (fetched=0)",
      warning: null,
    });
    expect(upsert).not.toHaveBeenCalled();
    const tombstone = (txQuery.mock.calls as Array<[string, unknown[]]>).find(
      ([sql]) => /UPDATE pois SET deactivated_at = NOW\(\)/.test(sql),
    );
    expect(tombstone).toBeUndefined();
  });

  it("skips tombstoning when an incomplete extract would wipe more than half the region", async () => {
    // 60 owned rows in the store; the extract carries only node/0, so the stale
    // set would be 59/60 (>50%) — treat the extract as incomplete, don't wipe.
    const existingRows = Array.from({ length: 60 }, (_, i) => ({
      id: `uuid-${i}`,
      external_id: `node/${i}`,
      import_region: "CZ",
    }));
    loadInBbox(existingRows);
    mockExtract(poi({ external_id: "node/0" })); // only 1 of the 60 present

    const result = await service.importRegion(REGION);

    const tombstone = (txQuery.mock.calls as Array<[string, unknown[]]>).find(
      ([sql]) => /UPDATE pois SET deactivated_at = NOW\(\)/.test(sql),
    );
    expect(tombstone).toBeUndefined();
    expect(result.tombstoned).toBe(0);
    // The rows we DID get are still upserted — only the destructive delete is
    // withheld.
    expect(upsert).toHaveBeenCalled();
    // #847 review: the partial-accept advisory flows out on the result so
    // `PoiImportRunRecorder.finish` can persist it — this run is a `success`
    // (never `skipped`), so `warning` is the only signal an operator gets
    // that the extract looks incomplete.
    expect(result.warning).toBe(WIPE_GUARD_WARNING);
    expect(result.skipped).toBeUndefined();
  });

  it("does NOT stamp coverage (imported_at) when the wipe guard trips — an incomplete extract must not mark the whole region covered (#944 review)", async () => {
    // Same incomplete-extract scenario as above (60 owned, extract carries 1):
    // a real upsert happens, but the extract looks incomplete, so coverage must
    // NOT be stamped — otherwise a request in the slices this run never loaded
    // would read as covered and skip the Overpass fallback.
    const existingRows = Array.from({ length: 60 }, (_, i) => ({
      id: `uuid-${i}`,
      external_id: `node/${i}`,
      import_region: "CZ",
    }));
    loadInBbox(existingRows);
    mockExtract(poi({ external_id: "node/0" }));

    const result = await service.importRegion(REGION);

    expect(upsert).toHaveBeenCalled(); // the import DID run (not a skip)
    expect(txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("poi_import_regions"),
      expect.anything(),
    );
    // Paired with the missing coverage stamp: the same trip that withholds
    // the stamp also carries the operator-facing advisory.
    expect(result.warning).toBe(WIPE_GUARD_WARNING);
  });

  it("uses the pre-import region size for the wipe guard (a full-replacement wrong extract is refused)", async () => {
    // 60 existing rows + a wrong extract of 60 DIFFERENT in-bbox ids. The stale
    // set is all 60 existing; the guard denominator must be the pre-import 60
    // (not 120 after the upsert adds the new ones) so 60/60 > 50% fires — which
    // requires the stale-load to run BEFORE the upsert.
    const existingRows = Array.from({ length: 60 }, (_, i) => ({
      id: `uuid-old-${i}`,
      external_id: `node/old-${i}`,
      import_region: "CZ",
    }));
    loadInBbox(existingRows);
    mockExtract(
      ...Array.from({ length: 60 }, (_, i) =>
        poi({ external_id: `node/new-${i}` }),
      ),
    );

    const result = await service.importRegion(REGION);

    // The stale-load (first tx query) must precede the upsert.
    expect(txQuery.mock.invocationCallOrder[0]).toBeLessThan(
      upsert.mock.invocationCallOrder[0] as number,
    );
    const tombstone = (txQuery.mock.calls as Array<[string, unknown[]]>).find(
      ([sql]) => /UPDATE pois SET deactivated_at = NOW\(\)/.test(sql),
    );
    expect(tombstone).toBeUndefined();
    expect(result.tombstoned).toBe(0);
    expect(result.warning).toBe(WIPE_GUARD_WARNING);
  });

  it("skips a region with no extract file yet (no parse, no write) for gradual provisioning", async () => {
    existsSyncMock.mockReturnValueOnce(false);

    const result = await service.importRegion(REGION);

    expect(result).toEqual({
      region: "CZ",
      fetched: 0,
      upserted: 0,
      tombstoned: 0,
      skipped: true,
      skipReason: "no extract file at /extracts/cz.osm",
      warning: null,
    });
    expect(stubParseCalls).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("503s before touching the file when the POI store SELECT 1 probe rejects (runtime drop) — the parser never runs", async () => {
    probe.mockRejectedValueOnce(
      Object.assign(new Error("Connection terminated unexpectedly"), {
        code: "08006",
      }),
    );

    await expect(service.importRegion(REGION)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Fail fast: neither the file check nor the parser runs.
    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(stubParseCalls).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("503s (fail fast) when the POI DataSource is not initialized", async () => {
    (dataSource as unknown as { isInitialized: boolean }).isInitialized = false;

    await expect(service.importRegion(REGION)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(stubParseCalls).toBe(0);
  });

  it("importAll imports every configured region sequentially, one result each", async () => {
    const SK: PoiImportRegion = {
      code: "SK",
      bbox: { minLng: 16.83, minLat: 47.73, maxLng: 22.57, maxLat: 49.61 },
    };
    config.regions = [REGION, SK];
    mockExtract(poi({ external_id: "node/1" }));

    const results = await service.importAll();

    expect(results.map((r) => r.region)).toEqual(["CZ", "SK"]);
    expect(stubParseCalls).toBe(2);
  });
});
