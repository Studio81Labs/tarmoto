import { Job } from 'bullmq';
import { QualityConflationProcessor } from './quality-conflation.processor.js';
import type { QualityConflationService } from '../../roads/quality-conflation/quality-conflation.service.js';

describe('QualityConflationProcessor', () => {
  function build(
    conflation: Partial<QualityConflationService>,
  ): QualityConflationProcessor {
    return new QualityConflationProcessor(
      conflation as QualityConflationService,
    );
  }

  const job = { id: 'job-1' } as Job;

  it('skips (no file read/write) when conflation is disabled', async () => {
    const runConflation = jest.fn();
    const processor = build({ enabled: false, runConflation });

    await expect(processor.process(job)).resolves.toEqual({ skipped: true });
    expect(runConflation).not.toHaveBeenCalled();
  });

  it('runs the conflation and returns its result when enabled', async () => {
    const runConflation = jest
      .fn()
      .mockResolvedValue({ waysTagged: 7, assignments: 9 });
    const processor = build({ enabled: true, runConflation });

    await expect(processor.process(job)).resolves.toEqual({
      waysTagged: 7,
      assignments: 9,
    });
    expect(runConflation).toHaveBeenCalledTimes(1);
  });

  it('lets a conflation error propagate so BullMQ retries', async () => {
    const runConflation = jest
      .fn()
      .mockRejectedValue(new Error('write failed'));
    const processor = build({ enabled: true, runConflation });

    await expect(processor.process(job)).rejects.toThrow('write failed');
  });
});
