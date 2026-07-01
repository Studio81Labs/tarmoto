import { Job } from 'bullmq';
import { OsmImportProcessor } from './osm-import.processor.js';
import type { OsmImportService } from '../../roads/osm-import/osm-import.service.js';

describe('OsmImportProcessor', () => {
  function build(osmImport: Partial<OsmImportService>): OsmImportProcessor {
    return new OsmImportProcessor(osmImport as OsmImportService);
  }

  const job = { id: 'job-1' } as Job;

  it('skips (no file read) when the import is disabled', async () => {
    const importFromConfiguredFile = jest.fn();
    const processor = build({ enabled: false, importFromConfiguredFile });

    await expect(processor.process(job)).resolves.toEqual({ skipped: true });
    expect(importFromConfiguredFile).not.toHaveBeenCalled();
  });

  it('runs the import and returns its result when enabled', async () => {
    const importFromConfiguredFile = jest
      .fn()
      .mockResolvedValue({ upserted: 42 });
    const processor = build({ enabled: true, importFromConfiguredFile });

    await expect(processor.process(job)).resolves.toEqual({ upserted: 42 });
    expect(importFromConfiguredFile).toHaveBeenCalledTimes(1);
  });

  it('lets an import error propagate so BullMQ retries', async () => {
    const importFromConfiguredFile = jest
      .fn()
      .mockRejectedValue(new Error('read failed'));
    const processor = build({ enabled: true, importFromConfiguredFile });

    await expect(processor.process(job)).rejects.toThrow('read failed');
  });
});
