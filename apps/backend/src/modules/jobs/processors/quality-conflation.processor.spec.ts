import { Job } from 'bullmq';
import { QualityConflationProcessor } from './quality-conflation.processor.js';
import type { QualityConflationService } from '../../roads/quality-conflation/quality-conflation.service.js';
import type { GraphHopperReimportService } from '../../roads/quality-conflation/graphhopper-reimport.service.js';

describe('QualityConflationProcessor', () => {
  function build(
    conflation: Partial<QualityConflationService>,
    reimport: Partial<GraphHopperReimportService> = {
      trigger: jest.fn().mockResolvedValue({ triggered: false }),
    },
  ): {
    processor: QualityConflationProcessor;
    trigger: jest.Mock;
  } {
    const trigger = reimport.trigger as jest.Mock;
    return {
      processor: new QualityConflationProcessor(
        conflation as QualityConflationService,
        reimport as GraphHopperReimportService,
      ),
      trigger,
    };
  }

  const job = { id: 'job-1' } as Job;

  it('skips (no file read/write, no re-import) when conflation is disabled', async () => {
    const runConflation = jest.fn();
    const trigger = jest.fn();
    const { processor } = build({ enabled: false, runConflation }, { trigger });

    await expect(processor.process(job)).resolves.toEqual({ skipped: true });
    expect(runConflation).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it('runs the conflation, triggers the re-import, and returns the result', async () => {
    const runConflation = jest
      .fn()
      .mockResolvedValue({ waysTagged: 7, assignments: 9 });
    const trigger = jest.fn().mockResolvedValue({ triggered: true });
    const { processor } = build({ enabled: true, runConflation }, { trigger });

    await expect(processor.process(job)).resolves.toEqual({
      waysTagged: 7,
      assignments: 9,
      reimportTriggered: true,
    });
    expect(runConflation).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('reports reimportTriggered=false when the webhook is unconfigured', async () => {
    const runConflation = jest
      .fn()
      .mockResolvedValue({ waysTagged: 1, assignments: 1 });
    const trigger = jest.fn().mockResolvedValue({ triggered: false });
    const { processor } = build({ enabled: true, runConflation }, { trigger });

    await expect(processor.process(job)).resolves.toEqual({
      waysTagged: 1,
      assignments: 1,
      reimportTriggered: false,
    });
  });

  it('lets a conflation error propagate before any re-import trigger', async () => {
    const runConflation = jest
      .fn()
      .mockRejectedValue(new Error('write failed'));
    const trigger = jest.fn();
    const { processor } = build({ enabled: true, runConflation }, { trigger });

    await expect(processor.process(job)).rejects.toThrow('write failed');
    expect(trigger).not.toHaveBeenCalled();
  });

  it('lets a re-import webhook failure propagate so the job retries', async () => {
    const runConflation = jest
      .fn()
      .mockResolvedValue({ waysTagged: 3, assignments: 3 });
    const trigger = jest
      .fn()
      .mockRejectedValue(new Error('webhook returned 503'));
    const { processor } = build({ enabled: true, runConflation }, { trigger });

    await expect(processor.process(job)).rejects.toThrow(
      'webhook returned 503',
    );
  });
});
