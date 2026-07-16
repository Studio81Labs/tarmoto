import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { JobsOptions, Queue } from "bullmq";
import { POI_IMPORT_JOB, POI_IMPORT_QUEUE } from "@tarmoto/ingest";

/**
 * Delay between consecutive per-region POI import jobs (#850), moved verbatim
 * from the backend's `jobs.producer.ts`. A continent-scale run fans out ~17
 * country imports; spacing them 10 minutes apart keeps a single heavy country
 * from starving the worker pool and spreads the DB write load across a few
 * hours instead of one thundering batch. The Nth region's job is delayed
 * `N * POI_IMPORT_STAGGER_MS`.
 */
export const POI_IMPORT_STAGGER_MS = 10 * 60_000;

/**
 * Retry/backoff policy for `poi.import` jobs — the one slice of the backend's
 * shared `DEFAULT_JOB_OPTIONS` (`jobs.config.ts`) this producer needs.
 * apps/ingest owns exactly one queue, so the full multi-queue config object
 * isn't reproduced here; `enqueuePoiImportRegion` overrides `attempts` per
 * call, exactly like the backend producer did.
 */
const POI_IMPORT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { age: 24 * 60 * 60, count: 5000 },
};

/**
 * The `poi.import` producer for apps/ingest — moved from the backend's
 * `JobsProducer.enqueuePoiImportRegion` (#850). Split into its own small,
 * queue-scoped class (rather than reusing the backend's `JobsProducer`,
 * which isn't available here) because apps/ingest owns only this one queue;
 * the backend's producer handles nine others unrelated to POI import.
 *
 * Lives in its own file (not `jobs.module.ts`, which provides it) so
 * `PoiImportProcessor` — which needs this class as a constructor dependency
 * — and `PoiJobsModule` — which registers it as a provider — can both import
 * it without an import cycle between the module and the processor.
 */
@Injectable()
export class PoiImportProducer {
  constructor(
    @InjectQueue(POI_IMPORT_QUEUE)
    private readonly poiImport: Queue,
  ) {}

  /**
   * Enqueue a single region's offline POI import (#850) as a staggered child of
   * the weekly dispatcher. `staggerIndex` is the region's position in the fan-out
   * (0-based); the job is delayed `staggerIndex * POI_IMPORT_STAGGER_MS` so a
   * continent-scale run spreads across hours rather than firing every country at
   * once.
   *
   * The jobId `import-region:<dispatchId>:<source>:<code>` is scoped to the
   * dispatch OCCURRENCE (`dispatchId` = the weekly dispatcher job's id — stable
   * across its retries, fresh each week) AND the source, so a dispatch that
   * retries after enqueuing some regions re-enqueues them idempotently (BullMQ
   * ignores a duplicate jobId) instead of doubling the heavy imports, while the
   * same country from two sources (OSM + FSQ) stays two distinct jobs. Next
   * week's dispatch — a new occurrence — still enqueues a fresh run.
   * `attempts: 3` (a heavy region import is retried a few times, then waits for
   * next week).
   */
  async enqueuePoiImportRegion(
    source: string,
    code: string,
    staggerIndex: number,
    dispatchId: string,
  ): Promise<void> {
    await this.poiImport.add(
      POI_IMPORT_JOB.REGION,
      { source, code },
      {
        ...POI_IMPORT_JOB_OPTIONS,
        // BullMQ reserves `:` as its Redis-key delimiter and scheduler `job.id`s
        // contain colons (`repeat:<hash>:<ts>`), so strip them from the jobId.
        jobId:
          `${POI_IMPORT_JOB.REGION}:${dispatchId}:${source}:${code}`.replace(
            /:/g,
            "_",
          ),
        attempts: 3,
        delay: staggerIndex * POI_IMPORT_STAGGER_MS,
      },
    );
  }
}
