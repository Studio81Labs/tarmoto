import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repository } from 'typeorm';
import type { ConfigType } from '@nestjs/config';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import type { qualityConflationConfig } from './quality-conflation.config.js';
import { QualityConflationService } from './quality-conflation.service.js';

type ConflationConfig = ConfigType<typeof qualityConflationConfig>;

const CONFLATION_OFF: ConflationConfig = {
  enabled: false,
  inputFilePath: null,
  outputFilePath: null,
};

function makeService(
  rows: unknown[],
  conflation: ConflationConfig = CONFLATION_OFF,
): { service: QualityConflationService; query: jest.Mock } {
  const query = jest.fn().mockResolvedValue(rows);
  const repo = { query } as unknown as Repository<RoadSegment>;
  return {
    service: new QualityConflationService(repo, conflation),
    query,
  };
}

/** First `repo.query(sql, params)` call, typed for assertions. */
function firstCall(query: jest.Mock): { sql: string; params: unknown[] } {
  const call = query.mock.calls[0] as [string, unknown[] | undefined];
  return { sql: call[0], params: call[1] ?? [] };
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

  it('always conflates the whole live network (no region bound)', async () => {
    // The import now spans multiple independently-refreshed regions (the folder
    // model, Sub-project B), so a single import bbox can no longer describe the
    // covered area — conflation reads every live, scored way, unconditionally.
    const { service, query } = makeService([]);
    await service.buildConflation();
    const { sql, params } = firstCall(query);
    expect(sql).not.toContain('ST_MakeEnvelope');
    expect(params).toEqual([]);
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
      const on = makeService([], {
        enabled: true,
        inputFilePath: '/in.osm',
        outputFilePath: '/out.osm',
      }).service;
      expect(on.enabled).toBe(true);
    });

    it('throws when the input/output paths are not configured', async () => {
      const { service } = makeService([], {
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
          {
            enabled: true,
            inputFilePath: missingInput,
            outputFilePath: output,
          },
        );

        await expect(service.runConflation()).rejects.toBeDefined();
        // The last good extract is untouched and no (unique) temp file is left
        // behind — the failed run cleans up only its own `.<uuid>.tmp`.
        expect(await readFile(output, 'utf8')).toBe('PREVIOUS GOOD EXTRACT');
        expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual(
          [],
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('is concurrency-safe: two overlapping runs yield a complete extract, no temp orphans', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'conflation-'));
      const input = join(dir, 'in.osm');
      const output = join(dir, 'out.osm');
      try {
        await writeFile(
          input,
          `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <way id="100"><nd ref="1"/><nd ref="2"/><tag k="highway" v="secondary"/></way>
</osm>`,
        );
        const { service } = makeService(
          [{ osmWayId: '100', representativeQuality: 4.6, segmentCount: 2 }],
          { enabled: true, inputFilePath: input, outputFilePath: output },
        );

        // The queued worker + the manual CLI (or two manual runs) can call
        // runConflation() at once. Unique temp + atomic rename means neither
        // clobbers the other's in-flight file and the output is never partial;
        // conflation is idempotent, so both produce the same complete extract.
        const [a, b] = await Promise.all([
          service.runConflation(),
          service.runConflation(),
        ]);
        expect(a).toEqual({ waysTagged: 1, assignments: 1 });
        expect(b).toEqual({ waysTagged: 1, assignments: 1 });

        const written = await readFile(output, 'utf8');
        expect(written).toContain('<tag k="smoothness" v="excellent"/>');
        expect(written.trim().endsWith('</osm>')).toBe(true); // complete, not truncated
        expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual(
          [],
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
