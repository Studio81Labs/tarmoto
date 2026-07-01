import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import {
  OsmImportService,
  ROAD_SEGMENT_ON_CONFLICT,
} from './osm-import.service.js';
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

  it('refreshes surface_type only while the segment has no readings', () => {
    // Rider-classified surfaces (reading_count > 0) stay authoritative (ADR-0005).
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '"surface_type" = CASE WHEN "road_segments"."reading_count" = 0 ' +
        'THEN EXCLUDED."surface_type" ELSE "road_segments"."surface_type" END',
    );
  });

  it('never writes the crowdsourced / identity columns', () => {
    for (const col of [
      'quality_score',
      'confidence',
      'reading_count',
      '"id"',
    ]) {
      expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain(`SET ${col}`);
      expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain(`, ${col} =`);
    }
    // reading_count appears only inside the guard, never as an assignment target.
    expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain(
      '"reading_count" = EXCLUDED',
    );
  });

  it('skips no-op rows via an IS DISTINCT FROM guard', () => {
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '"road_segments"."geom" IS DISTINCT FROM EXCLUDED."geom"',
    );
    // Surface-only change on an unread segment still triggers an update…
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '("road_segments"."reading_count" = 0 AND ' +
        '"road_segments"."surface_type" IS DISTINCT FROM EXCLUDED."surface_type")',
    );
    // …but a read segment whose only OSM change is surface is NOT rewritten
    // (that branch is gated by reading_count = 0), so the guard has a WHERE.
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain('WHERE');
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

  /** Rows passed to `.values()` on the Nth (0-based) insert statement. */
  const valuesOnCall = (n: number): RoadSegmentRow[] =>
    (qb.values.mock.calls[n] as [RoadSegmentRow[]])[0];

  beforeEach(async () => {
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
});
