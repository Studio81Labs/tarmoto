import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import type { SupportedLocale, UnitSystem } from '@tarmoto/shared';
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
 * Catch-up horizon (hours) for a backed-up dispatcher. BullMQ's JobScheduler
 * produces the next hourly job only when the previous one starts, and computes
 * that next slot from `max(prevSlot, now)` — so after a multi-hour outage it
 * runs the single pending slot and then jumps to the next FUTURE slot, skipping
 * the UTC hours between.
 *
 * Coverage comes from EVERY run, not just the pending one: a run at slot T
 * matches riders whose LOCAL time is in `[08:00, 08:00 + DIGEST_CATCHUP_HOURS)`
 * and pins the window to their local 08:00 — i.e. it replays every zone whose
 * local 08:00 fell in `[T - (DIGEST_CATCHUP_HOURS - 1)h, T]`. That is the same
 * set iterating those skipped UTC slots at T would produce, in one query. So
 * after a 07:00–10:00 UTC outage the pending 07:00 run covers the zones east of
 * it, and the next scheduled run (~11:00, created when the pending job starts,
 * so ≤1h later) covers UTC / UTC-1 / UTC-2 at local 11:00 / 10:00 / 09:00 —
 * together they replay the whole gap, up to DIGEST_CATCHUP_HOURS. A longer
 * outage lets the earliest zones roll to next week: bounded on purpose so a
 * backlog never fans out stale digests. The pinned 08:00 boundary keeps the
 * per-(user, week) jobId identical, so overlap with on-time runs dedups to a
 * no-op.
 *
 * Residual: if the worker recovers, runs the pending slot, then dies again
 * before the next scheduled slot, the still-west zones wait for the following
 * run. Acceptable for a weekly mail; forward slot-iteration would close it at
 * the cost of a wall-clock bound + one query per caught-up hour.
 */
const DIGEST_CATCHUP_HOURS = 6;

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
 * The dispatcher reads each rider's timezone from
 * `notification_preferences.quiet_hours_timezone` (string IANA tz like
 * "Europe/Bratislava"). That is the only persisted, user-writable timezone —
 * `users.preferences` has no timezone key and the profile DTO's whitelist
 * (`forbidNonWhitelisted`) would reject one, so reading it there pins every
 * rider to UTC. Riders with no notification-prefs row (lazily created) or an
 * empty value fall back to UTC → a Sunday 08:00 UTC window. Digest opt-in is
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
    // Anchor everything (the DOW/HOUR filter, the window bounds, the idempotency
    // key) to the SCHEDULED slot, not the processing-time clock — see
    // `scheduledFireTime`. A retried/backlogged dispatch otherwise builds the
    // window from whenever the worker happened to run. (The catch-up range below
    // then handles the slots BullMQ skips entirely across a longer outage.)
    const now = this.scheduledFireTime(job);
    // SQL handles the per-row timezone math because Postgres can do it
    // and pulling every user into Node to call `Intl.DateTimeFormat`
    // would scale poorly.
    //
    // CRITICAL: `AT TIME ZONE '<bad-zone>'` raises a Postgres error that
    // aborts the WHOLE query. A single user with `quiet_hours_timezone =
    // "Foo/Bar"` would prevent the digest from going out for *anyone*.
    // Resolve each user's tz (from the LEFT-JOINed notification_preferences)
    // through a LATERAL join against `pg_timezone_names` (Postgres's
    // authoritative IANA table). An unknown/absent name returns no row →
    // COALESCE picks 'UTC' → AT TIME ZONE sees only known-valid input. The
    // lateral subquery is evaluated once per row but `pg_timezone_names` is a
    // small (~600 entry) in-memory catalog, so the cost is negligible compared
    // to the outer scan.
    //
    // Digest opt-in lives in the typed `notification_preferences.email_digest`
    // ('weekly'|'daily'|'never'), NOT `users.preferences` — #278 moved it out.
    // The row is created lazily (most riders never touch settings), so a
    // missing row COALESCEs to the entity default 'weekly' → opted in (matches
    // the AC's "roll out on first ship"); an explicit 'daily'/'never' suppresses
    // the weekly send.
    // The digest window is computed HERE, in each rider's resolved timezone, and
    // carried to compose — not re-derived there from a fixed 7×24h delta. The
    // boundary is the rider's local Sunday 08:00: `date_trunc('day', local_now)
    // + <hour>`, which is exact because the WHERE only matches Sunday hours in
    // the catch-up range (so "today's 08:00" is always the intended send). It
    // stays pinned to 08:00 whichever catch-up hour matched, so the window (and
    // the derived jobId) is identical on the on-time and caught-up runs.
    // window_start subtracts `interval '7 days'` in LOCAL time, so a DST
    // transition shifts the absolute span to 167/169h instead of a flat 168h and
    // consecutive weeks share the exact same boundary (no spring-forward overlap
    // or fall-back gap).
    //
    // The HOUR filter is a RANGE `[08:00, 08:00 + DIGEST_CATCHUP_HOURS)`, not a
    // single hour, so one post-outage run catches every rider whose local 08:00
    // was skipped (see DIGEST_CATCHUP_HOURS).
    const rows = await this.dataSource.query<
      {
        user_id: string;
        window_start: string | Date;
        window_end: string | Date;
      }[]
    >(
      `
      SELECT
        u.id::text AS user_id,
        s.send_at AS window_end,
        ((w.local_send - interval '7 days') AT TIME ZONE tz_resolution.tz)
          AS window_start
      FROM users u
      LEFT JOIN notification_preferences np ON np.user_id = u.id
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          (
            SELECT ptn.name
            FROM pg_timezone_names ptn
            WHERE ptn.name = NULLIF(np.quiet_hours_timezone, '')
            LIMIT 1
          ),
          'UTC'
        ) AS tz
      ) tz_resolution
      CROSS JOIN LATERAL (
        SELECT $1::timestamptz AT TIME ZONE tz_resolution.tz AS local_now
      ) ln
      CROSS JOIN LATERAL (
        SELECT date_trunc('day', ln.local_now)
             + make_interval(hours => $3::int) AS local_send
      ) w
      CROSS JOIN LATERAL (
        SELECT w.local_send AT TIME ZONE tz_resolution.tz AS send_at
      ) s
      WHERE u.deleted_at IS NULL
        -- Verification is checked AS OF the pinned send time (s.send_at = the
        -- rider's local 08:00), not "now": the catch-up range must not mail a
        -- rider who verified their email AFTER 08:00 a window that already
        -- closed. That is backed by a real timestamp (email_verified_at).
        --
        -- The opt-in is deliberately NOT gated the same way. There is no history
        -- of email_digest changes, and notification_preferences.updated_at is not
        -- a proxy for one — the row is bumped by unrelated edits (a marketing /
        -- category toggle, or the mobile / companion timezone sync), so gating on
        -- it would silently drop default-weekly riders who were eligible at 08:00
        -- but whose row was merely touched afterwards. The only thing dropping
        -- the gate lets through is a rider who switches TO weekly mid-window
        -- getting that week's (correct) digest — benign, and no-activity riders
        -- are skipped anyway.
        AND u.email_verified_at <= s.send_at
        AND COALESCE(np.email_digest, 'weekly') = 'weekly'
        AND EXTRACT(DOW FROM ln.local_now)::int = $2
        AND EXTRACT(HOUR FROM ln.local_now)::int BETWEEN $3 AND $4
      `,
      [
        now.toISOString(),
        DIGEST_LOCAL_DOW,
        DIGEST_LOCAL_HOUR,
        DIGEST_LOCAL_HOUR + DIGEST_CATCHUP_HOURS - 1,
      ],
    );

    let enqueued = 0;
    for (const row of rows) {
      // pg returns timestamptz as a JS Date; the unit suite mocks ISO strings.
      // `new Date()` normalises both to a canonical instant.
      const windowEnd = new Date(row.window_end);
      await this.producer.enqueueDigestWeeklyCompose({
        user_id: row.user_id,
        // Idempotency key = the UTC week of the PINNED send boundary (window_end
        // = the rider's local Sunday 08:00). Deriving it from window_end (not the
        // dispatcher slot) keeps it constant across every catch-up run, so the
        // replays collapse onto one compose job (a UTC-12 rider's local 08:00 vs
        // 12:00 sit in different slot-weeks, which is why the slot can't key it).
        // Keeping the 'YYYY-Www' format — rather than a raw epoch — means a job
        // enqueued by the PREVIOUS producer during a rolling deploy shares the
        // key in the common case, so old + new jobs still dedupe.
        for_local_window: this.localWindowKey(windowEnd),
        window_start: new Date(row.window_start).toISOString(),
        window_end: windowEnd.toISOString(),
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
    const { user_id, window_start, window_end } =
      job.data as DigestWeeklyComposeJobData;

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
        language: SupportedLocale;
      }[]
    >(
      `SELECT u.email, u.display_name, u.preferences, u.language
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

    // Window bounds are carried from dispatch (computed in the rider's timezone,
    // DST-correct — see `enqueueDigestWeeklyCompose` / the dispatch query), so
    // compose is normally a pure consumer. Fall back to the old fixed-week
    // derivation from the job timestamp for a LEGACY payload — a compose job
    // enqueued by the pre-window producer, still in Redis across a rolling
    // deploy / replay. Without this, `new Date(undefined)` → Invalid Date and
    // the ride query's `toISOString()` throws, failing the job; and because the
    // jobId is stable per (user, week), that failed legacy job would block the
    // fresh real-email job for the same window until Redis evicts it.
    const windowEnd = window_end
      ? new Date(window_end)
      : new Date(job.timestamp);
    const windowStart = window_start
      ? new Date(window_start)
      : new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

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

    const sent = await this.emailService.sendWeeklyDigest(
      user.email,
      {
        displayName: user.display_name,
        rideCount: summary.rideCount,
        totalKm: summary.totalKm,
        totalMinutes: summary.totalMinutes,
        bestQuality: summary.bestQuality,
        percentExplored: exploration.percentExplored,
        riddenSegments: exploration.riddenSegments,
        units,
        exploreUrl: `${getCompanionUrl(this.config)}/explore`,
      },
      user.language,
    );
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
   * The scheduled fire time of this repeatable dispatch — NOT the processing
   * clock. BullMQ's JobScheduler stamps `job.timestamp` with the job's creation
   * time (≈ one interval before the slot) and instead encodes the actual
   * scheduled slot millis as the trailing segment of the jobId
   * ("repeat:<schedulerKey>:<millis>"). Anchoring to that slot means a retried
   * or backlogged dispatch (worker down across 08:00, resumes at 09:00+) still
   * targets the hour it was meant to fire — otherwise `EXTRACT(HOUR) = 8`
   * matches no one and that week's digest is silently skipped. Falls back to the
   * wall clock for a job with no scheduler id (a manual trigger / unit test).
   */
  private scheduledFireTime(job: Job): Date {
    const id = job.id ?? '';
    if (id.startsWith('repeat:')) {
      const slotMillis = Number(id.slice(id.lastIndexOf(':') + 1));
      if (Number.isFinite(slotMillis) && slotMillis > 0) {
        return new Date(slotMillis);
      }
    }
    return new Date();
  }

  /**
   * Idempotency bucket for the compose jobId: the UTC year-week of the PINNED
   * send boundary (`windowEnd` = the rider's local Sunday 08:00). Keyed off
   * window_end, not the dispatcher slot, so it's constant across every catch-up
   * run for a rider's weekly digest — replays dedupe onto one job. The
   * 'YYYY-Www' format is deliberate: it matches the key the previous producer
   * used, so old + new jobs still collapse during a rolling deploy.
   */
  private localWindowKey(windowEnd: Date): string {
    const yyyy = windowEnd.getUTCFullYear();
    const startOfYear = Date.UTC(yyyy, 0, 1);
    const dayMs = 24 * 60 * 60 * 1000;
    const dayOfYear = Math.floor((windowEnd.getTime() - startOfYear) / dayMs);
    const week = Math.ceil((dayOfYear + 1) / 7);
    return `${yyyy}-W${week.toString().padStart(2, '0')}`;
  }
}
