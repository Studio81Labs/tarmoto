import { Job } from 'bullmq';
import { PoiImportProcessor } from './poi-import.processor.js';
import { JOB_NAMES } from '../jobs.constants.js';
import type {
  PoiImportResult,
  PoiImportService,
} from '../../poi/poi-import.service.js';
import type { PoiImportRegion } from '../../poi/poi-import.config.js';
import type { JobsProducer } from '../jobs.producer.js';

describe('PoiImportProcessor', () => {
  const REGIONS: PoiImportRegion[] = [
    { code: 'CZ', bbox: { minLng: 12, minLat: 48, maxLng: 18, maxLat: 51 } },
    { code: 'SK', bbox: { minLng: 16, minLat: 47, maxLng: 22, maxLat: 49 } },
    { code: 'PL', bbox: { minLng: 14, minLat: 49, maxLng: 24, maxLat: 54 } },
  ];

  /** A fake importer in the registry — one bulk source (osm / fsq / …). */
  function importer(
    over: Partial<PoiImportService> & { source: string },
  ): PoiImportService {
    return {
      enabled: true,
      regions: REGIONS,
      importRegion: jest.fn(),
      ...over,
    } as unknown as PoiImportService;
  }

  function build(importers: PoiImportService[]): {
    processor: PoiImportProcessor;
    enqueuePoiImportRegion: jest.Mock;
  } {
    const enqueuePoiImportRegion = jest.fn().mockResolvedValue(undefined);
    const producer = { enqueuePoiImportRegion } as unknown as JobsProducer;
    return {
      processor: new PoiImportProcessor(importers, producer),
      enqueuePoiImportRegion,
    };
  }

  const jobNamed = (name: string, data: unknown = {}): Job =>
    ({ id: 'job-1', name, data }) as unknown as Job;

  it('dispatch: skips (no fan-out) when no source is enabled', async () => {
    const { processor, enqueuePoiImportRegion } = build([
      importer({ source: 'osm', enabled: false }),
      importer({ source: 'fsq', enabled: false }),
    ]);

    await expect(
      processor.process(jobNamed(JOB_NAMES.POI_IMPORT_DISPATCH)),
    ).resolves.toEqual({ skipped: true });
    expect(enqueuePoiImportRegion).not.toHaveBeenCalled();
  });

  it('dispatch: fans out one job per (source, region) across enabled sources with a global stagger', async () => {
    const { processor, enqueuePoiImportRegion } = build([
      importer({ source: 'osm', enabled: true }),
      importer({ source: 'fsq', enabled: true }),
    ]);

    const result = await processor.process(
      jobNamed(JOB_NAMES.POI_IMPORT_DISPATCH),
    );

    // 3 regions × 2 sources; the stagger index is global across both sources so
    // OSM-CZ and FSQ-CZ don't both fire at delay 0.
    expect(result).toEqual({ regions_enqueued: 6 });
    expect(enqueuePoiImportRegion).toHaveBeenCalledTimes(6);
    // (source, code, staggerIndex, dispatchId)
    expect(enqueuePoiImportRegion).toHaveBeenNthCalledWith(
      1,
      'osm',
      'CZ',
      0,
      'job-1',
    );
    expect(enqueuePoiImportRegion).toHaveBeenNthCalledWith(
      3,
      'osm',
      'PL',
      2,
      'job-1',
    );
    expect(enqueuePoiImportRegion).toHaveBeenNthCalledWith(
      4,
      'fsq',
      'CZ',
      3,
      'job-1',
    );
    expect(enqueuePoiImportRegion).toHaveBeenNthCalledWith(
      6,
      'fsq',
      'PL',
      5,
      'job-1',
    );
  });

  it('dispatch: runs only the enabled source(s), skipping disabled ones', async () => {
    const { processor, enqueuePoiImportRegion } = build([
      importer({ source: 'osm', enabled: false }),
      importer({ source: 'fsq', enabled: true }),
    ]);

    const result = await processor.process(
      jobNamed(JOB_NAMES.POI_IMPORT_DISPATCH),
    );

    expect(result).toEqual({ regions_enqueued: 3 });
    expect(enqueuePoiImportRegion).toHaveBeenCalledTimes(3);
    // Only FSQ jobs — OSM is disabled, so its regions are never enqueued.
    for (const call of enqueuePoiImportRegion.mock.calls) {
      expect(call[0]).toBe('fsq');
    }
  });

  it('dispatch: tolerates the retired `run` job name as a dispatch alias', async () => {
    // A deploy that renamed run→dispatch can leave an old `poi.import.run` job
    // queued; it must fan out, not crash the worker with "unknown job name".
    const { processor, enqueuePoiImportRegion } = build([
      importer({ source: 'osm', enabled: true }),
    ]);

    const result = await processor.process(jobNamed('run'));

    expect(result).toEqual({ regions_enqueued: 3 });
    expect(enqueuePoiImportRegion).toHaveBeenCalledTimes(3);
  });

  it('import-region: routes the job to its source and runs importRegion', async () => {
    const importResult: PoiImportResult = {
      region: 'SK',
      fetched: 10,
      upserted: 9,
      tombstoned: 1,
    };
    const osmImport = jest.fn();
    const fsqImport = jest.fn().mockResolvedValue(importResult);
    const { processor, enqueuePoiImportRegion } = build([
      importer({ source: 'osm', importRegion: osmImport }),
      importer({ source: 'fsq', importRegion: fsqImport }),
    ]);

    const result = await processor.process(
      jobNamed(JOB_NAMES.POI_IMPORT_REGION, { code: 'SK', source: 'fsq' }),
    );

    expect(fsqImport).toHaveBeenCalledWith(REGIONS[1]);
    expect(osmImport).not.toHaveBeenCalled();
    expect(result).toEqual(importResult);
    // A region job never re-dispatches.
    expect(enqueuePoiImportRegion).not.toHaveBeenCalled();
  });

  it('import-region: defaults a missing source to osm (a job enqueued before the source field existed)', async () => {
    const osmImport = jest.fn().mockResolvedValue({
      region: 'SK',
      fetched: 1,
      upserted: 1,
      tombstoned: 0,
    } satisfies PoiImportResult);
    const fsqImport = jest.fn();
    const { processor } = build([
      importer({ source: 'osm', importRegion: osmImport }),
      importer({ source: 'fsq', importRegion: fsqImport }),
    ]);

    await processor.process(
      jobNamed(JOB_NAMES.POI_IMPORT_REGION, { code: 'SK' }),
    );

    expect(osmImport).toHaveBeenCalledWith(REGIONS[1]);
    expect(fsqImport).not.toHaveBeenCalled();
  });

  it('import-region: throws on a source not in the registry', async () => {
    const { processor } = build([importer({ source: 'osm' })]);

    await expect(
      processor.process(
        jobNamed(JOB_NAMES.POI_IMPORT_REGION, { code: 'SK', source: 'xyz' }),
      ),
    ).rejects.toThrow(/unknown source: xyz/);
  });

  it('import-region: throws on a code outside the source coverage list', async () => {
    const importRegion = jest.fn();
    const { processor } = build([importer({ source: 'osm', importRegion })]);

    await expect(
      processor.process(
        jobNamed(JOB_NAMES.POI_IMPORT_REGION, { code: 'ZZ', source: 'osm' }),
      ),
    ).rejects.toThrow(/unknown code: ZZ/);
    expect(importRegion).not.toHaveBeenCalled();
  });

  it('import-region: throws when the job is missing a code', async () => {
    const { processor } = build([importer({ source: 'osm' })]);

    await expect(
      processor.process(jobNamed(JOB_NAMES.POI_IMPORT_REGION, {})),
    ).rejects.toThrow(/missing code/);
  });

  it('throws on an unknown job name so a producer typo surfaces immediately', async () => {
    const { processor } = build([importer({ source: 'osm' })]);

    await expect(processor.process(jobNamed('something-else'))).rejects.toThrow(
      /Unknown poi.import job/,
    );
  });
});
