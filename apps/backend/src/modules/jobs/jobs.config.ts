import { ConfigService } from '@nestjs/config';
import type { ConnectionOptions, JobsOptions, WorkerOptions } from 'bullmq';

export interface JobsConfig {
  /**
   * Redis connection options shared by every queue and worker. Reuses
   * the same `TARMOTO_REDIS_*` env vars that the websocket adapter
   * reads, so a single Redis instance backs both subsystems.
   */
  connection: ConnectionOptions;

  /**
   * When true, this process attaches workers to every registered
   * queue. When false, the process can still produce jobs (enqueue)
   * but will not consume any — useful for splitting API and worker
   * containers in prod.
   *
   * Defaults to true so single-container dev deployments don't need
   * any extra env wiring.
   */
  workersEnabled: boolean;
}

export function buildJobsConfig(config: ConfigService): JobsConfig {
  const host = config.get<string>('TARMOTO_REDIS_HOST') ?? 'localhost';
  const port = Number.parseInt(
    config.get<string>('TARMOTO_REDIS_PORT') ?? '6379',
    10,
  );

  // Default workers ON. Set TARMOTO_QUEUE_WORKER_ENABLED=false on the
  // API container when running a separate worker process. Anything
  // other than the literal string "false" (case-insensitive) is
  // treated as enabled so a typo doesn't silently disable processing.
  const raw = config
    .get<string>('TARMOTO_QUEUE_WORKER_ENABLED')
    ?.trim()
    .toLowerCase();
  const workersEnabled = raw !== 'false';

  return {
    connection: {
      host,
      port,
      // BullMQ requires this to be null on the connection to keep
      // pulling jobs from the queue (it polls via blocking commands).
      maxRetriesPerRequest: null,
    },
    workersEnabled,
  };
}

/**
 * Default retry/backoff policy applied to every job enqueued through
 * the shared producer + the cross-module `@InjectQueue` call sites.
 * Individual call sites can override by passing options to `add()`.
 *
 * - `attempts: 5`: ~31 minutes of cumulative backoff before the job is
 *   marked failed and surfaced via the health endpoint.
 * - `backoff.type: 'exponential'`: 30s → 60s → 2m → 4m → 8m.
 * - `removeOnComplete: { count: 1000 }`: keep recent successes for ops
 *   visibility without ballooning Redis memory.
 * - `removeOnFail: { age: 24h, count: 5000 }`: keep failures for at
 *   most 24 hours OR 5000 jobs (whichever is smaller). The age cap is
 *   load-bearing for queues that use a stable per-entity `jobId` for
 *   idempotency: BullMQ's `add()` dedupes against ANY existing job
 *   with the same id (waiting/active/delayed/completed/failed). A
 *   stuck failed job on a low-volume queue (e.g. account-deletion-
 *   finalize) would otherwise sit in Redis until 5000 newer failures
 *   evicted it — months — silently no-op'ing every subsequent
 *   re-enqueue from the daily sweep. The 24h TTL is comfortably past
 *   any single-job retry chain (which exhausts at ~31 min) so it
 *   never preempts a still-retrying job, but small enough that the
 *   next daily sweep gets a fresh enqueue path. Most relevant for
 *   `account-deletion-finalize` (GDPR deadline) and `data-export`
 *   (a single failed export shouldn't strand the user's request).
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 30_000,
  },
  removeOnComplete: { count: 1000 },
  removeOnFail: { age: 24 * 60 * 60, count: 5000 },
};

/**
 * Default worker concurrency. Per-queue overrides can be set in the
 * processor's `@Processor` decorator (e.g. data-export streams large
 * archives and benefits from a low ceiling).
 */
export const DEFAULT_WORKER_OPTIONS: Partial<WorkerOptions> = {
  concurrency: 4,
  // Always keep at least one stalled-job recovery cycle running.
  // BullMQ defaults are fine for our scale; left here as the seam
  // for future tuning.
};
