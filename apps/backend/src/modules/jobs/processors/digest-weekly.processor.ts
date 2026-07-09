import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import type { UnitSystem } from '@tarmoto/shared';
import { getCompanionUrl } from '../../../common/companion-url.js';
import { EmailService } from '../../email/email.service.js';
import {
  JobsProducer,
  type DigestWeeklyComposeJobData,
} from '../jobs.producer.js';
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
 *   `compose` (per-user): renders and sends the digest email (#866) —
 *      a per-rider summary of the week's completed rides + exploration
 *      progress. Re-checks eligibility (opt-in / verified / not deleted)
 *      since dispatch → compose is async, and skips a rider with no
 *      rides that week rather than sending an empty digest.
 *
 * The dispatcher reads `users.preferences.timezone` (string IANA tz
 * like "Europe/Bratislava"). Users without a timezone fall back to
 * UTC, which gives them a Sunday 08:00 UTC window. Digest opt-in is
 * `notification_preferences.email_digest = 'weekly'` (a lazily-created
 * row → default 'weekly' when absent; 'daily'/'never' opts out),
 * checked at both dispatch and compose.
 */
@Processor(QUEUE_NAMES.DIGEST_WEEKLY)
export class DigestWeeklyProcessor extends WorkerHost {
  private readonly logger = new Logger(DigestWeeklyProcessor.name);

  /** Active-network total is shared by every rider in a run; cache it briefly. */
  private static readonly ACTIVE_SEGMENT_TTL_MS = 10 * 60 * 1000;
  private activeSegmentCache: { total: number; expiresAt: number } | null =
    null;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly producer: JobsProducer,
    private readonly config: ConfigService,
    private readonly emailService: EmailService,
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
    // Digest opt-in lives in the typed `notification_preferences.email_digest`
    // ('weekly'|'daily'|'never'), NOT `users.preferences` — #278 moved it out.
    // The row is created lazily (most riders never touch settings), so a
    // missing row COALESCEs to the entity default 'weekly' → opted in (matches
    // the AC's "roll out on first ship"); an explicit 'daily'/'never' suppresses
    // the weekly send.
    const rows = await this.dataSource.query<{ user_id: string }[]>(
      `
      SELECT u.id::text AS user_id
      FROM users u
      LEFT JOIN notification_preferences np ON np.user_id = u.id
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
        AND COALESCE(np.email_digest, 'weekly') = 'weekly'
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

  private async compose(job: Job): Promise<DigestWeeklyComposeResult> {
    const { user_id } = job.data as DigestWeeklyComposeJobData;

    // Re-check eligibility at compose time: dispatch → compose is async, so the
    // opt-in / verified / deleted state may have changed since the dispatch
    // gate. Digest opt-in is `notification_preferences.email_digest = 'weekly'`
    // (missing row → default 'weekly'), the same gate as dispatch — this is
    // where "unsubscribe respected".
    const [user] = await this.dataSource.query<
      {
        email: string;
        display_name: string;
        preferences: Record<string, unknown> | null;
      }[]
    >(
      `SELECT u.email, u.display_name, u.preferences
       FROM users u
       LEFT JOIN notification_preferences np ON np.user_id = u.id
       WHERE u.id = $1
         AND u.deleted_at IS NULL
         AND u.email_verified_at IS NOT NULL
         AND COALESCE(np.email_digest, 'weekly') = 'weekly'`,
      [user_id],
    );
    if (!user) {
      return { status: 'skipped', reason: 'ineligible' };
    }

    // The digest covers the 7 days ending at dispatch — this compose job's
    // creation time (`job.timestamp`), so it's deterministic regardless of when
    // the worker picks it up.
    const windowEnd = new Date(job.timestamp);
    const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    const summary = await this.gatherRideSummary(
      user_id,
      windowStart,
      windowEnd,
    );
    if (summary.rideCount === 0) {
      // No rides this week — don't pester inactive riders (product decision).
      return { status: 'skipped', reason: 'no-activity' };
    }

    const exploration = await this.gatherExplorationProgress(user_id);
    const units: UnitSystem =
      user.preferences?.units === 'imperial' ? 'imperial' : 'metric';

    const sent = await this.emailService.sendWeeklyDigest(user.email, {
      displayName: user.display_name,
      rideCount: summary.rideCount,
      totalKm: summary.totalKm,
      totalMinutes: summary.totalMinutes,
      bestQuality: summary.bestQuality,
      percentExplored: exploration.percentExplored,
      riddenSegments: exploration.riddenSegments,
      units,
      exploreUrl: `${getCompanionUrl(this.config)}/explore`,
    });
    if (!sent) {
      // EmailService swallows provider errors and returns null. For a delivery
      // job that IS a real failure — throw so BullMQ retries per the queue
      // policy instead of recording a misleading 'sent' (the rider would
      // otherwise silently miss the digest).
      throw new Error(`weekly-digest send failed for user ${user_id}`);
    }

    this.logger.log(
      `[${job.id ?? 'no-id'}] weekly-digest sent to user ${user_id}`,
    );
    return { status: 'sent' };
  }

  /** Aggregate a rider's COMPLETED rides in `[start, end)`. */
  private async gatherRideSummary(
    userId: string,
    start: Date,
    end: Date,
  ): Promise<{
    rideCount: number;
    totalKm: number;
    totalMinutes: number;
    bestQuality: number | null;
  }> {
    const [row] = await this.dataSource.query<
      {
        ride_count: string;
        total_km: string | null;
        total_minutes: string | null;
        best_quality: string | null;
      }[]
    >(
      // Window keyed on `ended_at`: the digest counts rides that *completed*
      // this week, so ride_count, distance, and duration all describe the same
      // set — no ride is summed whole for distance but truncated for time (the
      // inconsistency a `started_at` window + LEAST(ended_at, $3) cap produced).
      // A boundary-spanning ride still running at the Sunday send has
      // ended_at >= $3 and rolls into next week's digest rather than being
      // split across two. `ended_at IS NOT NULL` drops rides saved 'completed'
      // with no end (e.g. some GPX imports); GREATEST(..., 0) floors a corrupt
      // ended_at < started_at at zero.
      `SELECT
         COUNT(*)::text AS ride_count,
         COALESCE(SUM(distance_km), 0) AS total_km,
         COALESCE(SUM(
           GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at)) / 60)
         ), 0) AS total_minutes,
         MAX(avg_road_quality) AS best_quality
       FROM rides
       WHERE user_id = $1
         AND status = 'completed'
         AND ended_at IS NOT NULL
         AND ended_at >= $2
         AND ended_at < $3`,
      [userId, start.toISOString(), end.toISOString()],
    );
    return {
      rideCount: parseInt(row?.ride_count ?? '0', 10),
      totalKm: parseFloat(row?.total_km ?? '0'),
      totalMinutes: parseFloat(row?.total_minutes ?? '0'),
      bestQuality:
        row?.best_quality != null ? parseFloat(row.best_quality) : null,
    };
  }

  /**
   * Lifetime exploration progress — distinct LIVE road segments ridden vs the
   * active network. Mirrors `ExplorationService.getStats`'s numerator/denominator
   * (both filter `deactivated_at IS NULL` so a tombstoned segment (#835) can't
   * push the ratio past 100 %). Kept inline so this background job doesn't pull
   * the exploration read-API module into its graph.
   */
  private async gatherExplorationProgress(
    userId: string,
  ): Promise<{ percentExplored: number; riddenSegments: number }> {
    const [[riddenRow], total] = await Promise.all([
      this.dataSource.query<{ ridden: string }[]>(
        `SELECT COUNT(DISTINCT rs.road_segment_id)::text AS ridden
         FROM ride_segments rs
         JOIN rides r ON r.id = rs.ride_id
         JOIN road_segments seg ON seg.id = rs.road_segment_id
         WHERE r.user_id = $1
           AND r.status = 'completed'
           AND seg.deactivated_at IS NULL`,
        [userId],
      ),
      this.getActiveSegmentTotal(),
    ]);
    const ridden = parseInt(riddenRow?.ridden ?? '0', 10);
    return {
      riddenSegments: ridden,
      percentExplored: total > 0 ? Math.round((ridden / total) * 100) : 0,
    };
  }

  /**
   * The active-network size — denominator of "% explored" — is identical for
   * every rider in a dispatch run and only moves when the OSM graph is
   * re-imported. Counting it per compose job would rescan the whole
   * continent-scale `road_segments` table N times per weekly burst, so memoize
   * it with a short TTL: one count per worker per few minutes instead of one
   * per rider. The denominator changes glacially and `%` is rounded to a whole
   * number, so a few-minutes-stale total is imperceptible.
   */
  private async getActiveSegmentTotal(): Promise<number> {
    const now = Date.now();
    if (this.activeSegmentCache && this.activeSegmentCache.expiresAt > now) {
      return this.activeSegmentCache.total;
    }
    const [row] = await this.dataSource.query<{ total: string }[]>(
      `SELECT COUNT(*)::text AS total
       FROM road_segments
       WHERE deactivated_at IS NULL`,
    );
    const total = parseInt(row?.total ?? '0', 10);
    this.activeSegmentCache = {
      total,
      expiresAt: now + DigestWeeklyProcessor.ACTIVE_SEGMENT_TTL_MS,
    };
    return total;
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
