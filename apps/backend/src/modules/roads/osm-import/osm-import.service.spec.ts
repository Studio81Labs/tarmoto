import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import {
  OsmImportService,
  ROAD_SEGMENT_ON_CONFLICT,
} from './osm-import.service.js';
import { osmImportConfig } from './osm-import.config.js';
import type { OsmWay, RoadSegmentRow } from './segment-rows.js';

/** A single ~100 m drivable way (two nodes → one segment). */
function straightWay(id: number): OsmWay {
  return {
    id,
    tags: { highway: 'residential' },
    // ~0.0009° lat ≈ 100 m → one ~100 m segment.
    coords: [
      { lat: 0, lng: 0 },
      { lat: 0.0009, lng: 0 },
    ],
  };
}

describe('ROAD_SEGMENT_ON_CONFLICT clause', () => {
  it('targets the (osm_way_id, segment_index) identity', () => {
    // Partial-index arbiter: the conflict target carries the live-row predicate.
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '( "osm_way_id", "segment_index" ) WHERE "deactivated_at" IS NULL DO UPDATE SET',
    );
  });

  it('refreshes the OSM-owned columns from EXCLUDED', () => {
    for (const col of [
      'geom',
      'length_m',
      'curviness_score',
      'road_name',
      'road_number',
    ]) {
      expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
        `"${col}" = EXCLUDED."${col}"`,
      );
    }
  });

  it('refreshes surface_type only while OSM still owns it (durable flag)', () => {
    // Gated on the durable surface_from_reading flag (#796), NOT the raw
    // surface_readings (which the retention sweep deletes) — so a rider-classified
    // surface is preserved even after the sweep, while an unclassified seed
    // refreshes on the OSM cycle.
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '"surface_type" = CASE WHEN NOT "road_segments"."surface_from_reading" ' +
        'THEN EXCLUDED."surface_type" ELSE "road_segments"."surface_type" END',
    );
    // Ownership is never inferred from raw readings.
    expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain('surface_readings');
    expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain('reading_count');
  });

  it('nulls the geometry-derived elevation columns when geometry changes', () => {
    for (const col of ['elevation_min', 'elevation_max', 'elevation_profile']) {
      expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
        `"${col}" = CASE WHEN NOT ST_OrderingEquals("road_segments"."geom", ` +
          `EXCLUDED."geom") THEN NULL ELSE "road_segments"."${col}" END`,
      );
    }
  });

  it('detects geometry changes at the vertex level (not bbox)', () => {
    // ST_OrderingEquals compares the exact coordinate sequence, so a same-bbox
    // reshape is still caught — the `=` / IS DISTINCT FROM operator would not.
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      'NOT ST_OrderingEquals("road_segments"."geom", EXCLUDED."geom")',
    );
    expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain(
      '"road_segments"."geom" IS DISTINCT FROM',
    );
  });

  it('never writes the crowdsourced / identity / provenance columns', () => {
    // surface_from_reading is aggregation-owned; the importer only reads it.
    for (const col of [
      'quality_score',
      'confidence',
      'reading_count',
      'id',
      'surface_from_reading',
    ]) {
      expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain(`"${col}" = EXCLUDED`);
      expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain(
        `"${col}" = "road_segments"`,
      );
    }
  });

  it('skips no-op rows via a change guard (WHERE over geom + OSM + surface)', () => {
    // The guard leads with the vertex-level geometry check…
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      'WHERE NOT ST_OrderingEquals("road_segments"."geom", EXCLUDED."geom")',
    );
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '"road_segments"."road_name" IS DISTINCT FROM EXCLUDED."road_name"',
    );
    // …and updates an unclassified segment whose only change is the surface seed.
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '(NOT "road_segments"."surface_from_reading" AND ' +
        '"road_segments"."surface_type" IS DISTINCT FROM EXCLUDED."surface_type")',
    );
  });
});

describe('OsmImportService', () => {
  let service: OsmImportService;
  let qb: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    onConflict: jest.Mock;
    execute: jest.Mock;
  };
  let createQueryBuilder: jest.Mock;
  let loadExisting: jest.Mock;
  let managerQuery: jest.Mock;
  let osmConfig: {
    enabled: boolean;
    filePath: string | null;
    bbox: [number, number, number, number] | null;
  };

  /** Rows passed to `.values()` on the Nth (0-based) insert statement. */
  const valuesOnCall = (n: number): RoadSegmentRow[] =>
    (qb.values.mock.calls[n] as [RoadSegmentRow[]])[0];

  beforeEach(async () => {
    osmConfig = { enabled: false, filePath: null, bbox: null };
    qb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      onConflict: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    createQueryBuilder = jest.fn().mockReturnValue(qb);
    // `loadExistingInBbox` — no existing rows by default, so every incoming
    // segment is a fresh insert (no carry-over / stale). The transaction runs the
    // callback against a manager whose insert builder is the shared `qb`.
    loadExisting = jest.fn().mockResolvedValue([]);
    managerQuery = jest.fn().mockResolvedValue(undefined);
    const manager = { createQueryBuilder, query: managerQuery };
    const repo = {
      query: loadExisting,
      manager: {
        transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
          cb(manager),
        ),
      },
    } as unknown as Repository<RoadSegment>;
    const moduleRef = await Test.createTestingModule({
      providers: [
        OsmImportService,
        {
          provide: getRepositoryToken(RoadSegment),
          useValue: repo,
        },
        {
          provide: osmImportConfig.KEY,
          useValue: osmConfig,
        },
      ],
    }).compile();
    service = moduleRef.get(OsmImportService);
  });

  it('upserts with the road-segment conflict clause', async () => {
    const result = await service.importFrom([straightWay(1), straightWay(2)]);

    expect(result.upserted).toBe(2);
    expect(qb.execute).toHaveBeenCalledTimes(1);
    expect(qb.onConflict).toHaveBeenCalledWith(ROAD_SEGMENT_ON_CONFLICT);
    const rows = valuesOnCall(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      osm_way_id: '1',
      segment_index: 0,
      geom: { type: 'LineString' },
    });
  });

  it('never carries the crowdsourced columns in the inserted rows', async () => {
    await service.importFrom([straightWay(1)]);

    for (const row of valuesOnCall(0)) {
      // Absent from the row → defaulted on insert, untouched on update.
      expect(row).not.toHaveProperty('id');
      expect(row).not.toHaveProperty('quality_score');
      expect(row).not.toHaveProperty('confidence');
      expect(row).not.toHaveProperty('reading_count');
    }
    // …but the OSM surface seed IS present (inserted for new segments).
    expect(valuesOnCall(0)[0]).toHaveProperty('surface_type');
  });

  it('skips non-drivable ways (no statement for them)', async () => {
    const footpath: OsmWay = {
      id: 9,
      tags: { highway: 'footway' },
      coords: [
        { lat: 0, lng: 0 },
        { lat: 0.0009, lng: 0 },
      ],
    };
    const result = await service.importFrom([footpath]);

    expect(result.upserted).toBe(0);
    expect(qb.execute).not.toHaveBeenCalled();
  });

  it('chunks large imports into multiple bounded statements', async () => {
    const ways = Array.from({ length: 1100 }, (_, i) => straightWay(i + 1));

    const result = await service.importFrom(ways);

    expect(result.upserted).toBe(1100);
    // 1100 rows / 500-row chunks → 3 statements (500 + 500 + 100).
    expect(qb.execute).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((n) => valuesOnCall(n).length)).toEqual([
      500, 500, 100,
    ]);
  });

  it('consumes an async source (the streaming PBF parser shape)', async () => {
    async function* source(): AsyncGenerator<OsmWay> {
      await Promise.resolve(); // emulate the streaming parser's async boundary
      yield straightWay(1);
      yield straightWay(2);
    }

    const result = await service.importFrom(source());

    expect(result.upserted).toBe(2);
    expect(qb.execute).toHaveBeenCalledTimes(1);
  });

  describe('split/merge reconciliation (#835)', () => {
    /** An existing row shaped like `loadExistingInBbox`'s raw query result. */
    function existingRow(
      id: string,
      osmWayId: string,
      segmentIndex: number,
      coords: Array<[number, number]>, // [lng, lat]
    ) {
      return {
        id,
        osm_way_id: osmWayId,
        segment_index: segmentIndex,
        geom: { type: 'LineString', coordinates: coords },
      };
    }

    it('carries an existing id onto a re-keyed incoming segment (same geometry)', async () => {
      // The way's id changed (1 → 2) but the geometry is identical, so the old
      // row's id + history must follow it rather than being inserted fresh.
      loadExisting.mockResolvedValueOnce([
        existingRow('old-uuid', '1', 0, [
          [0, 0],
          [0, 0.0009],
        ]),
      ]);

      const result = await service.importFrom([straightWay(2)]);

      expect(result).toMatchObject({
        upserted: 0,
        carriedOver: 1,
        deactivated: 0,
      });
      // Carry-over is an id-preserving UPDATE (that also revives + re-keys) — find
      // it among the transaction's statements (a free-key null precedes it).
      const calls = managerQuery.mock.calls as Array<[string, unknown[]]>;
      const carry = calls.find(([sql]) =>
        sql.includes('deactivated_at = NULL'),
      );
      expect(carry).toBeDefined();
      expect(carry![0]).toContain('UPDATE road_segments SET');
      expect(carry![1][0]).toBe('2'); // new osm_way_id
      expect(carry![1][8]).toBe('old-uuid'); // WHERE id
      // The target's old key is freed first so the re-key can't hit the index.
      const freeKey = calls.find(([sql]) =>
        sql.includes('osm_way_id = NULL, segment_index = NULL'),
      );
      expect(freeKey).toBeDefined();
      expect(freeKey![1]).toEqual([['old-uuid']]);
      // Nothing inserted for the carried segment.
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('does NOT upsert onto a reused (osm_way_id, segment_index) that is a different road', async () => {
      // A split kept way 100 on the DOWNSTREAM piece: old 100/0 = upstream, new
      // 100/0 = downstream. A straight key-match upsert would move the upstream
      // row's history onto the downstream geometry. With a region, the key match is
      // routed to geometry reassignment instead: the downstream row carries the
      // key, the upstream row is tombstoned.
      osmConfig.bbox = [-1, -1, 20, 20];
      loadExisting.mockResolvedValueOnce([
        existingRow('upstream', '100', 0, [
          [0, 0],
          [0, 0.0009],
        ]),
        existingRow('downstream', '100', 1, [
          [0, 0.0009],
          [0, 0.0018],
        ]),
      ]);
      // Incoming way 100 is now the downstream ~100 m (its segment 0 == downstream).
      const incomingDownstream: OsmWay = {
        id: 100,
        tags: { highway: 'residential' },
        coords: [
          { lat: 0.0009, lng: 0 },
          { lat: 0.0018, lng: 0 },
        ],
      };

      const result = await service.importFrom([incomingDownstream]);

      expect(result).toMatchObject({ carriedOver: 1, deactivated: 1 });
      const calls = managerQuery.mock.calls as Array<[string, unknown[]]>;
      // The DOWNSTREAM row carries the reused key (100, 0) — not the upstream row.
      const carry = calls.find(([sql]) =>
        sql.includes('deactivated_at = NULL'),
      );
      expect(carry![1][1]).toBe(0); // segment_index
      expect(carry![1][8]).toBe('downstream'); // WHERE id
      // The old upstream row (which shared the key) is tombstoned, not overwritten.
      const deactivate = calls.find(([sql]) =>
        sql.includes('deactivated_at = NOW()'),
      );
      expect(deactivate![1]).toEqual([['upstream']]);
    });

    it('checks reused keys even without a region (vacates, does not overwrite)', async () => {
      // No region: the geometry check still runs, so a reused key (old 100/0 =
      // upstream, incoming 100/0 = downstream) is NOT straight-upserted onto the
      // upstream row. Downstream carries the key; the upstream keeps living but its
      // now-reused identity is nulled (we don't tombstone by absence without a
      // region).
      osmConfig.bbox = null;
      loadExisting.mockResolvedValueOnce([
        existingRow('upstream', '100', 0, [
          [0, 0],
          [0, 0.0009],
        ]),
        existingRow('downstream', '100', 1, [
          [0, 0.0009],
          [0, 0.0018],
        ]),
      ]);
      const incomingDownstream: OsmWay = {
        id: 100,
        tags: { highway: 'residential' },
        coords: [
          { lat: 0.0009, lng: 0 },
          { lat: 0.0018, lng: 0 },
        ],
      };

      const result = await service.importFrom([incomingDownstream]);

      expect(result).toMatchObject({ carriedOver: 1, deactivated: 0 });
      const calls = managerQuery.mock.calls as Array<[string, unknown[]]>;
      // Downstream carries the reused key; upstream is not overwritten.
      const carry = calls.find(([sql]) =>
        sql.includes('deactivated_at = NULL'),
      );
      expect(carry![1][8]).toBe('downstream');
      // Nothing tombstoned; the upstream's reused identity is freed instead.
      expect(
        calls.some(([sql]) => sql.includes('deactivated_at = NOW()')),
      ).toBe(false);
      const free = calls.find(([sql]) =>
        sql.includes('osm_way_id = NULL, segment_index = NULL'),
      );
      expect(free![1][0]).toEqual(
        expect.arrayContaining(['upstream', 'downstream']),
      );
    });

    it('vacates an out-of-bbox live owner of a claimed key before upserting', async () => {
      // The global ON CONFLICT arbiter can match a live row OUTSIDE this tile that
      // owns the incoming key (a segment split across the boundary). It isn't in the
      // bbox load, so the upsert would overwrite it in place. It must be vacated.
      osmConfig.bbox = [-1, -1, 1, 1];
      // call 1: loadExistingInBbox → none in-bbox; call 2: loadOutOfBboxKeyOwners
      // → an out-of-tile live row owns the incoming key.
      loadExisting
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'out-of-tile' }]);

      const result = await service.importFrom([straightWay(1)]);

      expect(result).toMatchObject({ upserted: 1, carriedOver: 0 });
      const free = (managerQuery.mock.calls as Array<[string, unknown[]]>).find(
        ([sql]) => sql.includes('osm_way_id = NULL, segment_index = NULL'),
      );
      expect(free).toBeDefined();
      expect(free![1]).toEqual([['out-of-tile']]);
      // The incoming inserts fresh (its own key is now free).
      expect(qb.execute).toHaveBeenCalledTimes(1);
    });

    it('tombstones every existing row when a configured region imports empty', async () => {
      // A configured region with zero drivable rows is authoritative: the region
      // was cleared, so its existing rows must be deactivated (not left live).
      osmConfig.bbox = [-1, -1, 20, 20];
      loadExisting.mockResolvedValueOnce([
        existingRow('cleared', '7', 0, [
          [0, 0],
          [0, 0.0009],
        ]),
      ]);

      const result = await service.importFrom([]);

      expect(result.deactivated).toBe(1);
      const deactivate = (
        managerQuery.mock.calls as Array<[string, unknown[]]>
      ).find(([sql]) => sql.includes('deactivated_at = NOW()'));
      expect(deactivate![1]).toEqual([['cleared']]);
    });

    it('tombstones an existing row nothing matches — only with an explicit region', async () => {
      // Stale detection is region-authoritative: set a bbox so an unmatched row is
      // tombstoned. Existing row lives far from the incoming way → no match.
      osmConfig.bbox = [-1, -1, 20, 20];
      loadExisting.mockResolvedValueOnce([
        existingRow('gone-uuid', '5', 0, [
          [10, 10],
          [10, 10.0009],
        ]),
      ]);

      const result = await service.importFrom([straightWay(2)]);

      expect(result).toMatchObject({
        upserted: 1, // the incoming way inserted fresh
        carriedOver: 0,
        deactivated: 1,
      });
      // A deactivate UPDATE bounded to the stale id — never a DELETE.
      const calls = managerQuery.mock.calls as Array<[string, unknown[]]>;
      const deactivate = calls.find(([sql]) =>
        sql.includes('deactivated_at = NOW()'),
      );
      expect(deactivate).toBeDefined();
      expect(deactivate![1]).toEqual([['gone-uuid']]);
      expect(deactivate![0]).not.toMatch(/DELETE/i);
    });

    it('drops incoming rows outside the configured region (complete-way overhang)', async () => {
      // osmium extract -b keeps whole crossing ways, so rows can land outside the
      // region; the importer must constrain to the bbox or a neighbouring tile
      // would later tombstone their old rows. straightWay sits at (0,0); the region
      // is far away, so the row is filtered out and nothing is written.
      osmConfig.bbox = [100, 100, 101, 101];

      const result = await service.importFrom([straightWay(1)]);

      expect(result).toMatchObject({
        upserted: 0,
        carriedOver: 0,
        deactivated: 0,
      });
      expect(qb.execute).not.toHaveBeenCalled();
      expect(managerQuery).not.toHaveBeenCalled();
    });

    it('does NOT tombstone when no region is configured (data bbox is not authoritative)', async () => {
      // Without an explicit region a data-derived bbox can't distinguish "removed"
      // from "outside this extract", so an unmatched row is left active.
      osmConfig.bbox = null;
      loadExisting.mockResolvedValueOnce([
        existingRow('outside-uuid', '5', 0, [
          [10, 10],
          [10, 10.0009],
        ]),
      ]);

      const result = await service.importFrom([straightWay(2)]);

      expect(result.deactivated).toBe(0);
      const deactivate = (
        managerQuery.mock.calls as Array<[string, unknown[]]>
      ).find(([sql]) => sql.includes('deactivated_at = NOW()'));
      expect(deactivate).toBeUndefined();
    });
  });

  describe('importFromConfiguredFile', () => {
    it('reflects the enabled flag', () => {
      expect(service.enabled).toBe(false);
      osmConfig.enabled = true;
      expect(service.enabled).toBe(true);
    });

    it('throws when enabled without a configured file path', async () => {
      osmConfig.filePath = null;
      await expect(service.importFromConfiguredFile()).rejects.toThrow(
        /TARMOTO_OSM_IMPORT_FILE/,
      );
    });

    it('reads + imports a configured .osm file end-to-end', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'osm-import-'));
      const file = join(dir, 'region.osm');
      await writeFile(
        file,
        `<osm>
           <node id="1" lat="0" lon="0"/>
           <node id="2" lat="0.0009" lon="0"/>
           <way id="100"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
         </osm>`,
      );
      osmConfig.filePath = file;

      const result = await service.importFromConfiguredFile();

      expect(result.upserted).toBe(1); // the way → one ~100 m segment
      expect(qb.onConflict).toHaveBeenCalledWith(ROAD_SEGMENT_ON_CONFLICT);
      await rm(dir, { recursive: true, force: true });
    });
  });
});
