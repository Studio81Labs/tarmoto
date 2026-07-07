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

  function build(poiImport: Partial<PoiImportService>): {
    processor: PoiImportProcessor;
    enqueuePoiImportRegion: jest.Mock;
  } {
    const enqueuePoiImportRegion = jest.fn().mockResolvedValue(undefined);
    const producer = { enqueuePoiImportRegion } as unknown as JobsProducer;
    return {
      processor: new PoiImportProcessor(
        poiImport as PoiImportService,
        producer,
      ),
      enqueuePoiImportRegion,
    };
  }

  const jobNamed = (name: string, data: unknown = {}): Job =>
    ({ id: 'job-1', name, data }) as unknown as Job;

  it('dispatch: skips (no fan-out) when the import is disabled', async () => {
    const { processor, enqueuePoiImportRegion } = build({
      enabled: false,
      regions: REGIONS,
    });

    await expect(
      processor.process(jobNamed(JOB_NAMES.POI_IMPORT_DISPATCH)),
    ).resolves.toEqual({ skipped: true });
    expect(enqueuePoiImportRegion).not.toHaveBeenCalled();
  });

  it('dispatch: fans out one staggered region job per configured region (index → stagger)', async () => {
    const { processor, enqueuePoiImportRegion } = build({
      enabled: true,
      regions: REGIONS,
    });

    const result = await processor.process(
      jobNamed(JOB_NAMES.POI_IMPORT_DISPATCH),
    );

    expect(result).toEqual({ regions_enqueued: 3 });
    expect(enqueuePoiImportRegion).toHaveBeenCalledTimes(3);
    // Each region is passed with its 0-based fan-out index — the producer turns
    // that into the stagger delay, so a big run spreads across hours.
    expect(enqueuePoiImportRegion).toHaveBeenNthCalledWith(1, 'CZ', 0);
    expect(enqueuePoiImportRegion).toHaveBeenNthCalledWith(2, 'SK', 1);
    expect(enqueuePoiImportRegion).toHaveBeenNthCalledWith(3, 'PL', 2);
  });

  it('import-region: resolves the region by code and runs importRegion', async () => {
    const importResult: PoiImportResult = {
      region: 'SK',
      fetched: 10,
      upserted: 9,
      tombstoned: 1,
    };
    const importRegion = jest.fn().mockResolvedValue(importResult);
    const { processor, enqueuePoiImportRegion } = build({
      enabled: true,
      regions: REGIONS,
      importRegion,
    });

    const result = await processor.process(
      jobNamed(JOB_NAMES.POI_IMPORT_REGION, { code: 'SK' }),
    );

    expect(importRegion).toHaveBeenCalledWith(REGIONS[1]);
    expect(result).toEqual(importResult);
    // A region job never re-dispatches.
    expect(enqueuePoiImportRegion).not.toHaveBeenCalled();
  });

  it('import-region: throws on a code outside the configured coverage list', async () => {
    const importRegion = jest.fn();
    const { processor } = build({
      enabled: true,
      regions: REGIONS,
      importRegion,
    });

    await expect(
      processor.process(jobNamed(JOB_NAMES.POI_IMPORT_REGION, { code: 'ZZ' })),
    ).rejects.toThrow(/unknown code: ZZ/);
    expect(importRegion).not.toHaveBeenCalled();
  });

  it('import-region: throws when the job is missing a code', async () => {
    const { processor } = build({ enabled: true, regions: REGIONS });

    await expect(
      processor.process(jobNamed(JOB_NAMES.POI_IMPORT_REGION, {})),
    ).rejects.toThrow(/missing code/);
  });

  it('throws on an unknown job name so a producer typo surfaces immediately', async () => {
    const { processor } = build({ enabled: true, regions: REGIONS });

    await expect(processor.process(jobNamed('something-else'))).rejects.toThrow(
      /Unknown poi.import job/,
    );
  });
});
