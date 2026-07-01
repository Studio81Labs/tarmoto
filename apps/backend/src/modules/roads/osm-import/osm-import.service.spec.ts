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
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '( "osm_way_id", "segment_index" ) DO UPDATE SET',
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
  let osmConfig: { enabled: boolean; filePath: string | null };

  /** Rows passed to `.values()` on the Nth (0-based) insert statement. */
  const valuesOnCall = (n: number): RoadSegmentRow[] =>
    (qb.values.mock.calls[n] as [RoadSegmentRow[]])[0];

  beforeEach(async () => {
    osmConfig = { enabled: false, filePath: null };
    qb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      onConflict: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    createQueryBuilder = jest.fn().mockReturnValue(qb);
    const moduleRef = await Test.createTestingModule({
      providers: [
        OsmImportService,
        {
          provide: getRepositoryToken(RoadSegment),
          useValue: { createQueryBuilder } as Partial<Repository<RoadSegment>>,
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
