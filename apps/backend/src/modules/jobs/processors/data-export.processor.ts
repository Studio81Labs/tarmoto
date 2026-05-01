import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DataExportProcessor as DataExportRunner } from '../../account/data-export/data-export.processor.js';
import { QUEUE_NAMES } from '../jobs.constants.js';
import type { DataExportJobData } from '../jobs.producer.js';

export interface DataExportJobResult {
  request_id: string;
}

/**
 * Wraps the existing in-process `DataExportProcessor` (the one that
 * assembles the GDPR ZIP) so it executes as a queued worker job
 * instead of a `setImmediate()` fire-and-forget. This is the change
 * the issue calls out as "async work doesn't run inline on request
 * threads": the controller now enqueues and returns 202 immediately,
 * and the worker drains the queue independently of any HTTP request.
 *
 * Idempotency is enforced upstream by `DataExportController`'s direct
 * queue.add call (jobId = `data-export:<request_id>`), which uses the
 * shared `DEFAULT_JOB_OPTIONS` retry/backoff policy. The runner itself
 * also checks
 * `markProcessing` to detect the row racing past the `queued` state,
 * so a duplicate worker pick-up is a no-op rather than a duplicate
 * upload.
 */
@Processor(QUEUE_NAMES.DATA_EXPORT, {
  // Data-export streams a ZIP through `archiver` — keep the ceiling
  // low so we don't hammer the file system or the storage adapter.
  concurrency: 2,
})
export class DataExportQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(DataExportQueueProcessor.name);

  constructor(private readonly runner: DataExportRunner) {
    super();
  }

  async process(job: Job<DataExportJobData>): Promise<DataExportJobResult> {
    const { request_id, user_id } = job.data;
    if (!request_id || !user_id) {
      throw new Error(
        `data-export job missing request_id/user_id (got ${JSON.stringify(job.data)})`,
      );
    }
    await this.runner.process(request_id, user_id);
    this.logger.log(
      `[${job.id ?? 'no-id'}] processed data-export ${request_id} for user ${user_id}`,
    );
    return { request_id };
  }
}
