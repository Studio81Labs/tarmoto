import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import {
  POI_IMPORT_JOB,
  POI_IMPORT_QUEUE,
  POI_IMPORT_WEEKLY_CRON,
} from "@tarmoto/ingest";

/**
 * Registers the `poi.import` weekly-dispatch BullMQ repeatable on application
 * bootstrap — extracted from the backend's `jobs.scheduler.ts` (T5), which
 * registered it alongside nine unrelated queues. apps/ingest owns only this
 * one queue, so its scheduler is this standalone provider rather than the
 * backend's big multi-queue `JobsScheduler`.
 *
 * Mirrors the backend's reconciliation strategy: `upsertJobScheduler` creates
 * or updates the repeatable atomically (BullMQ v5+), and any repeatable job
 * whose name was retired (`poi.import`'s pre-#850 `run` job, renamed to
 * `dispatch`) is removed so it stops firing forever under a name no processor
 * still recognizes as anything other than a tolerated legacy alias.
 *
 * Only registered (see `jobs.module.ts`) when `TARMOTO_QUEUE_WORKER_ENABLED
 * !== 'false'` — the CLI import scripts run with the worker disabled and
 * never construct this provider.
 */
@Injectable()
export class PoiImportScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PoiImportScheduler.name);

  constructor(
    @InjectQueue(POI_IMPORT_QUEUE)
    private readonly poiImport: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      // Don't bail boot if the schedule fails to register — the operator
      // gets a clear log pointing at the broken queue instead of a crashed
      // process (mirrors the backend's `JobsScheduler`).
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to register recurring schedule for ${this.poiImport.name}: ${msg}`,
      );
    }

    await this.removeRetiredSchedulers();
  }

  private async reconcile(): Promise<void> {
    await this.poiImport.upsertJobScheduler(
      this.schedulerKey(POI_IMPORT_JOB.DISPATCH),
      { pattern: POI_IMPORT_WEEKLY_CRON },
      {
        name: POI_IMPORT_JOB.DISPATCH,
        opts: {
          // No jobId — repeat key is enough to dedupe.
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 1000 },
          attempts: 3,
          backoff: { type: "exponential", delay: 60_000 },
        },
      },
    );
    this.logger.log(
      `Registered recurring job ${this.poiImport.name}.${POI_IMPORT_JOB.DISPATCH} ` +
        `(${POI_IMPORT_WEEKLY_CRON}) — weekly POI import dispatcher → per-region jobs (#850)`,
    );
  }

  /**
   * Remove the repeatable whose job was renamed. BullMQ keys a scheduler by
   * `${queue}.${name}`, so a rename registers a NEW key and leaves the old one
   * firing forever — its job then reaches a processor that no longer knows the
   * name. #850 renamed the POI import's weekly `run` job to `dispatch`; drop
   * the orphaned `poi.import.run` so it stops firing (the processor tolerates
   * a still-queued `run` as a `dispatch` alias in the meantime).
   */
  private async removeRetiredSchedulers(): Promise<void> {
    const schedulerId = `${this.poiImport.name}.run`;
    try {
      const removed = await this.poiImport.removeJobScheduler(schedulerId);
      if (removed) {
        this.logger.log(`Removed retired scheduler ${schedulerId}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to remove retired scheduler ${schedulerId}: ${msg}`,
      );
    }
  }

  private schedulerKey(name: string): string {
    // Stable key per (queue, job name) so reboots reconcile the same
    // schedule rather than accumulating one entry per boot.
    return `${this.poiImport.name}.${name}`;
  }
}
