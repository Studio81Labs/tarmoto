import { Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import { JobsProducer } from '../jobs.producer.js';
import { JOB_NAMES, QUEUE_NAMES } from '../jobs.constants.js';

export interface DigestWeeklyDispatchResult {
  users_enqueued: number;
}

export interface DigestWeeklyComposeResult {
  status: 'sent' | 'skipped';
  reason?: string;
}

const DIGEST_LOCAL_HOUR = 8;
const DIGEST_LOCAL_DOW = 0; // Sunday in IANA POSIX (0=Sun, 1=Mon, ...).

/**
 * Two-stage weekly digest pipeline.
 *
 *   `dispatch` (hourly): for each opted-in user whose timezone makes
 *      "right now" Sunday 08:00 local, enqueue a `compose` child job.
 *      The hourly cadence with a per-hour granularity means every
 *      timezone gets one trigger window per week — Pacific/Apia
 *      (UTC+13) and Pacific/Samoa (UTC-11) both get covered without
 *      special cases.
 *
 *   `compose` (per-user): renders and sends the digest email. Today
 *      this is a stub that logs only — US-63 lands the actual
 *      composer + template. The job exists so the wiring, retries,
 *      and idempotency are already in place when the template
 *      arrives.
 *
 * The dispatcher reads `users.preferences.timezone` (string IANA tz
 * like "Europe/Bratislava"). Users without a timezone fall back to
 * UTC, which gives them a Sunday 08:00 UTC window. Real opt-out
 * handling comes with US-63's preferences UI; until then anyone
 * with `preferences.weekly_digest = true` opts in.
 */
@Processor(QUEUE_NAMES.DIGEST_WEEKLY)
export class DigestWeeklyProcessor extends WorkerHost {
  private readonly logger = new Logger(DigestWeeklyProcessor.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly producer: JobsProducer,
  ) {
    super();
  }

  async process(
    job: Job,
  ): Promise<DigestWeeklyDispatchResult | DigestWeeklyComposeResult> {
    if (job.name === JOB_NAMES.DIGEST_WEEKLY_DISPATCH) {
      return this.dispatch(job);
    }
    if (job.name === JOB_NAMES.DIGEST_WEEKLY_COMPOSE) {
      return this.compose(job);
    }
    throw new Error(`Unknown digest.weekly job name: ${job.name}`);
  }

  private async dispatch(job: Job): Promise<DigestWeeklyDispatchResult> {
    const now = new Date();
    // SQL handles the per-row timezone math because Postgres can do it
    // and pulling every user into Node to call `Intl.DateTimeFormat`
    // would scale poorly.
    //
    // CRITICAL: `AT TIME ZONE '<bad-zone>'` raises a Postgres error that
    // aborts the WHOLE query. A single user with `preferences.timezone =
    // "Foo/Bar"` would prevent the digest from going out for *anyone*.
    // Resolve each user's tz through a LATERAL join against
    // `pg_timezone_names` (Postgres's authoritative IANA table). An
    // unknown name returns no row → COALESCE picks 'UTC' → AT TIME ZONE
    // sees only known-valid input. The lateral subquery is evaluated
    // once per row but `pg_timezone_names` is a small (~600 entry)
    // in-memory catalog, so the cost is negligible compared to the
    // outer scan.
    //
    // The opt-in predicate is intentionally permissive (default ON when
    // missing) to match the AC, which expects the digest to roll out
    // on first ship; explicit opt-out via `weekly_digest=false`
    // suppresses the send.
    const rows = await this.dataSource.query<{ user_id: string }[]>(
      `
      SELECT u.id::text AS user_id
      FROM users u
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          (
            SELECT ptn.name
            FROM pg_timezone_names ptn
            WHERE ptn.name = NULLIF(u.preferences->>'timezone', '')
            LIMIT 1
          ),
          'UTC'
        ) AS tz
      ) tz_resolution
      WHERE u.deleted_at IS NULL
        AND u.email_verified_at IS NOT NULL
        AND COALESCE((u.preferences->>'weekly_digest')::boolean, true) = true
        AND EXTRACT(
          DOW FROM ($1::timestamptz AT TIME ZONE tz_resolution.tz)
        )::int = $2
        AND EXTRACT(
          HOUR FROM ($1::timestamptz AT TIME ZONE tz_resolution.tz)
        )::int = $3
      `,
      [now.toISOString(), DIGEST_LOCAL_DOW, DIGEST_LOCAL_HOUR],
    );

    const forLocalWindow = this.localWindowKey(now);
    let enqueued = 0;
    for (const { user_id } of rows) {
      await this.producer.enqueueDigestWeeklyCompose({
        user_id,
        for_local_window: forLocalWindow,
      });
      enqueued += 1;
    }
    if (enqueued > 0) {
      this.logger.log(
        `[${job.id ?? 'no-id'}] enqueued ${enqueued} weekly-digest compose job(s)`,
      );
    }
    return { users_enqueued: enqueued };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- stub
  private async compose(job: Job): Promise<DigestWeeklyComposeResult> {
    // Stub: real composer arrives in US-63 (the email digest issue).
    // Until then the job stays wired so retries, idempotency, and the
    // health endpoint surface real data instead of phantom queues.
    // The signature must remain async because `WorkerHost.process`
    // is typed as returning a Promise.
    this.logger.log(
      `[${job.id ?? 'no-id'}] weekly-digest compose stub — pending US-63 implementation`,
    );
    return { status: 'skipped', reason: 'pending US-63 composer' };
  }

  /**
   * Bucket key used for the compose job's idempotency: the year-week
   * of the dispatch, in UTC, so two dispatches in the same hour of
   * the same Sunday collapse into one job.
   */
  private localWindowKey(now: Date): string {
    const yyyy = now.getUTCFullYear();
    const startOfYear = Date.UTC(yyyy, 0, 1);
    const dayMs = 24 * 60 * 60 * 1000;
    const dayOfYear = Math.floor((now.getTime() - startOfYear) / dayMs);
    const week = Math.ceil((dayOfYear + 1) / 7);
    return `${yyyy}-W${week.toString().padStart(2, '0')}`;
  }
}
