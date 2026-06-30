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
  let upsert: jest.Mock;

  beforeEach(async () => {
    upsert = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        OsmImportService,
        {
          provide: getRepositoryToken(RoadSegment),
          useValue: { upsert } as Partial<Repository<RoadSegment>>,
        },
      ],
    }).compile();
    service = moduleRef.get(OsmImportService);
  });

  it('upserts ON CONFLICT (osm_way_id, segment_index)', async () => {
    const result = await service.importFrom([straightWay(1), straightWay(2)]);

    expect(result.upserted).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows, options] = upsert.mock.calls[0] as [RoadSegmentRow[], unknown];
    expect(options).toEqual({
      conflictPaths: ['osm_way_id', 'segment_index'],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      osm_way_id: '1',
      segment_index: 0,
      geom: { type: 'LineString' },
    });
  });

  it('never writes the crowdsourced columns (preserves quality / id on re-import)', async () => {
    await service.importFrom([straightWay(1)]);

    const [rows] = upsert.mock.calls[0] as [RoadSegmentRow[], unknown];
    for (const row of rows) {
      // These columns are absent from the row, so TypeORM's DO UPDATE SET never
      // touches them — a re-import keeps each segment's UUID + crowdsourced data.
      expect(row).not.toHaveProperty('id');
      expect(row).not.toHaveProperty('quality_score');
      expect(row).not.toHaveProperty('confidence');
      expect(row).not.toHaveProperty('reading_count');
    }
  });

  it('skips non-drivable ways (no upsert for them)', async () => {
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
    expect(upsert).not.toHaveBeenCalled();
  });

  it('chunks large imports into multiple bounded upserts', async () => {
    const ways = Array.from({ length: 1100 }, (_, i) => straightWay(i + 1));

    const result = await service.importFrom(ways);

    expect(result.upserted).toBe(1100);
    // 1100 rows / 500-row chunks → 3 statements (500 + 500 + 100).
    expect(upsert).toHaveBeenCalledTimes(3);
    const lengths = upsert.mock.calls.map(
      (call) => (call as [RoadSegmentRow[], unknown])[0].length,
    );
    expect(lengths).toEqual([500, 500, 100]);
  });

  it('consumes an async source (the streaming PBF parser shape)', async () => {
    async function* source(): AsyncGenerator<OsmWay> {
      await Promise.resolve(); // emulate the streaming parser's async boundary
      yield straightWay(1);
      yield straightWay(2);
    }

    const result = await service.importFrom(source());

    expect(result.upserted).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
