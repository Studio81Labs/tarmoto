import { Job } from 'bullmq';
import { OsmImportProcessor } from './osm-import.processor.js';
import type { OsmImportService } from '../../roads/osm-import/osm-import.service.js';
import type { JobsProducer } from '../jobs.producer.js';

describe('OsmImportProcessor', () => {
  function build(osmImport: Partial<OsmImportService>): {
    processor: OsmImportProcessor;
    enqueueQualityConflation: jest.Mock;
  } {
    const enqueueQualityConflation = jest.fn().mockResolvedValue(undefined);
    const producer = { enqueueQualityConflation } as unknown as JobsProducer;
    return {
      processor: new OsmImportProcessor(
        osmImport as OsmImportService,
        producer,
      ),
      enqueueQualityConflation,
    };
  }

  const job = { id: 'job-1' } as Job;

  it('skips (no file read, no conflation) when the import is disabled', async () => {
    const importFromConfiguredFile = jest.fn();
    const { processor, enqueueQualityConflation } = build({
      enabled: false,
      importFromConfiguredFile,
    });

    await expect(processor.process(job)).resolves.toEqual({ skipped: true });
    expect(importFromConfiguredFile).not.toHaveBeenCalled();
    expect(enqueueQualityConflation).not.toHaveBeenCalled();
  });

  it('runs the import, chains the conflation, and returns its result', async () => {
    const importFromConfiguredFile = jest
      .fn()
      .mockResolvedValue({ upserted: 42 });
    const { processor, enqueueQualityConflation } = build({
      enabled: true,
      importFromConfiguredFile,
    });

    await expect(processor.process(job)).resolves.toEqual({ upserted: 42 });
    expect(importFromConfiguredFile).toHaveBeenCalledTimes(1);
    expect(enqueueQualityConflation).toHaveBeenCalledTimes(1);
  });

  it('does not chain the conflation when the import fails', async () => {
    const importFromConfiguredFile = jest
      .fn()
      .mockRejectedValue(new Error('read failed'));
    const { processor, enqueueQualityConflation } = build({
      enabled: true,
      importFromConfiguredFile,
    });

    await expect(processor.process(job)).rejects.toThrow('read failed');
    expect(enqueueQualityConflation).not.toHaveBeenCalled();
  });
});
