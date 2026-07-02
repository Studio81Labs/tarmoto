import type { Repository } from 'typeorm';
import type { ConfigType } from '@nestjs/config';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import type { osmImportConfig } from '../osm-import/osm-import.config.js';
import { QualityConflationService } from './quality-conflation.service.js';

type Config = ConfigType<typeof osmImportConfig>;

function makeService(
  rows: unknown[],
  bbox: Config['bbox'] = null,
): { service: QualityConflationService; query: jest.Mock } {
  const query = jest.fn().mockResolvedValue(rows);
  const repo = { query } as unknown as Repository<RoadSegment>;
  const config: Config = { enabled: false, filePath: null, bbox };
  return { service: new QualityConflationService(repo, config), query };
}

/** First `repo.query(sql, params)` call, typed for assertions. */
function firstCall(query: jest.Mock): { sql: string; params: unknown[] } {
  const call = query.mock.calls[0] as [string, unknown[]];
  return { sql: call[0], params: call[1] };
}

describe('QualityConflationService', () => {
  it('maps each way to a smoothness assignment by representative quality', async () => {
    const { service } = makeService([
      { osmWayId: '100', representativeQuality: 4.6, segmentCount: 3 },
      { osmWayId: '200', representativeQuality: 1.2, segmentCount: 5 },
      { osmWayId: '300', representativeQuality: 3.0, segmentCount: 1 },
    ]);

    const out = await service.buildConflation();

    expect(out).toEqual([
      {
        osmWayId: '100',
        smoothness: 'excellent',
        representativeQuality: 4.6,
        segmentCount: 3,
      },
      {
        osmWayId: '200',
        smoothness: 'very_bad',
        representativeQuality: 1.2,
        segmentCount: 5,
      },
      {
        osmWayId: '300',
        smoothness: 'intermediate',
        representativeQuality: 3.0,
        segmentCount: 1,
      },
    ]);
  });

  it('only aggregates live, scored, way-keyed segments', async () => {
    const { service, query } = makeService([]);
    await service.buildConflation();
    const { sql } = firstCall(query);
    expect(sql).toContain('deactivated_at IS NULL');
    expect(sql).toContain('osm_way_id IS NOT NULL');
    expect(sql).toContain('quality_score IS NOT NULL');
    // Length-weighted representative, guarded against divide-by-zero.
    expect(sql).toContain('SUM(quality_score * length_m)');
    expect(sql).toContain('NULLIF(SUM(length_m), 0)');
    expect(sql).toContain('GROUP BY osm_way_id');
  });

  it('does not region-bound when no bbox is configured', async () => {
    const { service, query } = makeService([]);
    await service.buildConflation();
    const { sql, params } = firstCall(query);
    expect(sql).not.toContain('ST_MakeEnvelope');
    expect(params).toEqual([]);
  });

  it('region-bounds to the configured bbox when set', async () => {
    const bbox: Config['bbox'] = [12.09, 48.55, 18.86, 51.06];
    const { service, query } = makeService([], bbox);
    await service.buildConflation();
    const { sql, params } = firstCall(query);
    expect(sql).toContain('geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)');
    expect(sql).toContain(
      'ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))',
    );
    expect(params).toEqual([12.09, 48.55, 18.86, 51.06]);
  });

  it('drops a way whose representative is non-finite (defensive)', async () => {
    const { service } = makeService([
      { osmWayId: '1', representativeQuality: null, segmentCount: 0 },
      { osmWayId: '2', representativeQuality: 3.4, segmentCount: 2 },
    ]);
    const out = await service.buildConflation();
    expect(out).toEqual([
      {
        osmWayId: '2',
        smoothness: 'intermediate',
        representativeQuality: 3.4,
        segmentCount: 2,
      },
    ]);
  });

  it('returns an empty artifact when no way is scored', async () => {
    const { service } = makeService([]);
    expect(await service.buildConflation()).toEqual([]);
  });
});
