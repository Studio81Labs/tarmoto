import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import { OsmImportService } from './osm-import.service.js';
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

describe('OsmImportService', () => {
  let service: OsmImportService;
  let qb: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orUpdate: jest.Mock;
    execute: jest.Mock;
  };
  let createQueryBuilder: jest.Mock;

  /** Rows passed to `.values()` on the Nth (0-based) insert statement. */
  const valuesOnCall = (n: number): RoadSegmentRow[] =>
    (qb.values.mock.calls[n] as [RoadSegmentRow[]])[0];

  /** The args of the first `.orUpdate()` call. */
  const firstOrUpdate = (): [string[], string[], { [k: string]: boolean }] =>
    qb.orUpdate.mock.calls[0] as [string[], string[], { [k: string]: boolean }];

  beforeEach(async () => {
    qb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
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

  it('upserts ON CONFLICT (osm_way_id, segment_index)', async () => {
    const result = await service.importFrom([straightWay(1), straightWay(2)]);

    expect(result.upserted).toBe(2);
    expect(qb.execute).toHaveBeenCalledTimes(1);
    expect(firstOrUpdate()[1]).toEqual(['osm_way_id', 'segment_index']);
    const rows = valuesOnCall(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      osm_way_id: '1',
      segment_index: 0,
      geom: { type: 'LineString' },
    });
  });

  it('does not overwrite rider-derived surface_type on conflict', async () => {
    await service.importFrom([straightWay(1)]);

    // The DO UPDATE SET list must omit surface_type (crowd-classified once
    // sensor readings land) while still INSERTing the OSM seed for new rows.
    const overwrite = firstOrUpdate()[0];
    expect(overwrite).not.toContain('surface_type');
    expect(overwrite).not.toContain('quality_score');
    expect(overwrite).not.toContain('confidence');
    expect(overwrite).not.toContain('reading_count');
    expect(overwrite).toEqual(
      expect.arrayContaining(['geom', 'road_name', 'road_number']),
    );
    // …but the seed is still present in the inserted row.
    expect(valuesOnCall(0)[0]).toHaveProperty('surface_type');
  });

  it('skips no-op conflict updates (IS DISTINCT FROM predicate)', async () => {
    await service.importFrom([straightWay(1)]);

    // Avoids rewriting unchanged segments on a periodic re-import (WAL churn).
    expect(firstOrUpdate()[2]).toMatchObject({
      skipUpdateIfNoValuesChanged: true,
    });
  });

  it('never writes the crowdsourced columns (preserves quality / id on re-import)', async () => {
    await service.importFrom([straightWay(1)]);

    for (const row of valuesOnCall(0)) {
      // Absent from the row, so they are neither inserted nor in the SET list —
      // a re-import keeps each segment's UUID + crowdsourced data.
      expect(row).not.toHaveProperty('id');
      expect(row).not.toHaveProperty('quality_score');
      expect(row).not.toHaveProperty('confidence');
      expect(row).not.toHaveProperty('reading_count');
    }
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
