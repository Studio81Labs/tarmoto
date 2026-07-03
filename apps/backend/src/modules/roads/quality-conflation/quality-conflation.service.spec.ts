import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repository } from 'typeorm';
import type { ConfigType } from '@nestjs/config';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import type { osmImportConfig } from '../osm-import/osm-import.config.js';
import type { qualityConflationConfig } from './quality-conflation.config.js';
import { QualityConflationService } from './quality-conflation.service.js';

type Config = ConfigType<typeof osmImportConfig>;
type ConflationConfig = ConfigType<typeof qualityConflationConfig>;

const CONFLATION_OFF: ConflationConfig = {
  enabled: false,
  inputFilePath: null,
  outputFilePath: null,
};

function makeService(
  rows: unknown[],
  bbox: Config['bbox'] = null,
  conflation: ConflationConfig = CONFLATION_OFF,
): { service: QualityConflationService; query: jest.Mock } {
  const query = jest.fn().mockResolvedValue(rows);
  const repo = { query } as unknown as Repository<RoadSegment>;
  const config: Config = { enabled: false, filePath: null, bbox };
  return {
    service: new QualityConflationService(repo, config, conflation),
    query,
  };
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

  describe('runConflation', () => {
    it('reflects the enable flag', () => {
      expect(makeService([]).service.enabled).toBe(false);
      const on = makeService([], null, {
        enabled: true,
        inputFilePath: '/in.osm',
        outputFilePath: '/out.osm',
      }).service;
      expect(on.enabled).toBe(true);
    });

    it('throws when the input/output paths are not configured', async () => {
      const { service } = makeService([], null, {
        enabled: true,
        inputFilePath: null,
        outputFilePath: null,
      });
      await expect(service.runConflation()).rejects.toThrow(
        /TARMOTO_QUALITY_CONFLATION_INPUT_FILE/,
      );
    });

    it('injects the built assignments into the derived extract', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'conflation-'));
      const input = join(dir, 'in.osm');
      const output = join(dir, 'out.osm');
      try {
        await writeFile(
          input,
          `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <way id="100"><nd ref="1"/><nd ref="2"/><tag k="highway" v="secondary"/></way>
  <way id="999"><nd ref="3"/><nd ref="4"/><tag k="highway" v="track"/></way>
</osm>`,
        );
        const { service } = makeService(
          [{ osmWayId: '100', representativeQuality: 4.6, segmentCount: 2 }],
          null,
          { enabled: true, inputFilePath: input, outputFilePath: output },
        );

        const result = await service.runConflation();
        expect(result).toEqual({ waysTagged: 1, assignments: 1 });

        const written = await readFile(output, 'utf8');
        // Way 100 (scored) gets the tag; way 999 (unscored) does not.
        expect(written).toContain('<way id="100">');
        expect(written).toContain('<tag k="smoothness" v="excellent"/>');
        const way999 = written.slice(written.indexOf('<way id="999"'));
        expect(way999).not.toContain('smoothness');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('preserves the previous extract when the run fails (atomic write)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'conflation-'));
      const missingInput = join(dir, 'does-not-exist.osm');
      const output = join(dir, 'out.osm');
      try {
        await writeFile(output, 'PREVIOUS GOOD EXTRACT');
        const { service } = makeService(
          [{ osmWayId: '100', representativeQuality: 4.6, segmentCount: 2 }],
          null,
          {
            enabled: true,
            inputFilePath: missingInput,
            outputFilePath: output,
          },
        );

        await expect(service.runConflation()).rejects.toBeDefined();
        // The last good extract is untouched and no temp file is left behind.
        expect(await readFile(output, 'utf8')).toBe('PREVIOUS GOOD EXTRACT');
        await expect(readFile(`${output}.tmp`, 'utf8')).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
