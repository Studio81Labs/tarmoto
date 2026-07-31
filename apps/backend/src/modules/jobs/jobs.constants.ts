/**
 * Canonical queue names for the BullMQ-based background job system.
 *
 * These string values become Redis key prefixes (`bull:<name>:*`), so
 * renaming a queue is a breaking change to any in-flight or scheduled
 * jobs that exist in the live Redis instance — coordinate with ops if
 * a rename is unavoidable.
 *
 * Each queue is documented with its cadence (recurring vs one-shot),
 * who enqueues it, and what the processor does.
 */
export const QUEUE_NAMES = {
  /**
   * Recurring (hourly). Sweeps `hazard_reports` whose `expires_at` has
   * passed and flips `is_active = false` so dashboards, vector tiles,
   * and the websocket layer don't have to filter expired rows at read
   * time.
   */
  HAZARDS_CLEANUP: 'hazards.cleanup',

  /**
   * Recurring (nightly). Scans users with recent activity and enqueues
   * one `recheck-user` child job per user so the worker concurrency
   * limit prevents a thundering-herd on the DB.
   */
  BADGES_RECHECK: 'badges.recheck',

  /**
   * Recurring (hourly dispatcher). Each tick the dispatcher computes
   * which users are at "Sunday morning local time" and enqueues a
   * `compose` child job per user.
   */
  DIGEST_WEEKLY: 'digest.weekly',

  /**
   * One-shot. Replaces the previous `setImmediate`-based deferred
   * processing in `DataExportController`. Producer: HTTP POST
   * /account/data-export. Consumer: assembles the GDPR ZIP bundle.
   */
  DATA_EXPORT: 'data-export',

  /**
   * Recurring (daily). Finds users whose `deletion_scheduled_at` has
   * passed and enqueues `account-deletion-finalize` jobs for each one.
   */
  ACCOUNT_DELETION_SWEEP: 'account-deletion-sweep',

  /**
   * One-shot. Hard-deletes a single user (Stripe cancellation, DB
   * cascade, audit log, confirmation email). Enqueued by the daily
   * sweep and idempotent on the user id so duplicate sweeps don't
   * re-purge the same row.
   */
  ACCOUNT_DELETION_FINALIZE: 'account-deletion-finalize',

  /**
   * Recurring (weekly). Re-runs the DBSCAN clustering that builds
   * `fun_zones` from `road_segments` (depends on US-6).
   */
  FUNZONE_RECOMPUTE: 'funzone-recompute',

  /**
   * Recurring (daily). Sweeps raw GPS / sensor data older than each
   * user's `location_retention` preference (#279). Drops rows from
   * `surface_readings`, `ride_segments`, and `ride_stats`-linked
   * geometry while leaving aggregated road-quality data untouched.
   * Users who set `forever` are skipped. Idempotent — running twice
   * the same day deletes zero rows the second time.
   */
  LOCATION_RETENTION_SWEEP: 'location-retention-sweep',

  /**
   * Recurring (every 15 minutes). Iterates riders whose group-ride
   * session is still active and whose `last_position_at` is recent,
   * looks up current weather at their last broadcast position via
   * `WeatherService`, and dispatches a `weather_alert` push when
   * severe conditions (storm, ice, or wind > 60 km/h) are detected.
   * Per-(user, kind) cooldown via `weather_alert_dispatches` keeps
   * the same rider from being paged repeatedly inside one storm
   * cell. Push-pref + quiet-hours gating happens inside `PushService`.
   */
  WEATHER_ALERT_SWEEP: 'weather-alert-sweep',

  /**
   * Recurring (hourly). Walks unreconciled `model_eval_samples`
   * whose road segment now has the spec-§8.3 confirmation level
   * (≥70 confidence, ≥5 readings) and folds the recency-weighted
   * aggregate quality score into each row. Issue #496 — gives the
   * dangerous-misclass / adjacent-accuracy / MAE gauges a rolling
   * 24h denominator without forcing the metrics endpoint to do the
   * join itself.
   */
  MODEL_EVAL_RECONCILE: 'model-eval-reconcile',

  /**
   * Recurring (weekly). Recomputes the cross-device and cross-bike
   * agreement scores from the last 7 days of reconciled samples and
   * caches them on the `ModelEvalService` snapshot for the metrics
   * endpoint. Spec §7.2 thresholds (>0.80 cross-device, >0.75
   * cross-bike).
   */
  MODEL_EVAL_AGREEMENT: 'model-eval-agreement',

  /**
   * Recurring (~every 3 min). Pulls the Czech NAP (NDIC) DATEX II
   * snapshot, parses it, and reconciles closures into `road_closures`
   * with `source = 'official'` (#743). Dormant until
   * `TARMOTO_NAP_POLL_ENABLED=true` and NAP credentials are configured.
   */
  NAP_CLOSURE_POLL: 'nap.closure-poll',

  /**
   * Recurring (weekly). Imports the configured OSM `.osm` extract into
   * `road_segments` (#781). Dormant until `TARMOTO_OSM_ROAD_IMPORT_ENABLED=true`.
   * Runs before the POI import and the fun-zone recompute so the road graph is
   * fresh for both.
   */
  ROAD_IMPORT: 'road.import',

  /**
   * Recurring (hourly). Drains `store_billing_reconciliations` rows left
   * `open` when a store-billing side-effect couldn't be applied inline.
   * In P0 it acts only on Stripe-actionable `deletion_cancel_failed`
   * rows: it re-checks that the rider's deletion is still pending and
   * retries the `cancel_at_period_end` toggle, resolving the row on
   * success and leaving it open (attempts++) on a transient failure.
   * Restoration-safe: a row whose rider was restored during the grace
   * window is resolved WITHOUT touching Stripe. Also runs a small
   * retention prune of completed `processed_store_notifications` rows.
   * Apple/Google reasons are deferred to P1/P2.
   */
  STORE_RECONCILIATION_RETRY: 'store-reconciliation-retry',

  /**
   * Success-continuation of `road.import` (not independently scheduled).
   * Conflates `road_segments` quality into a derived `.osm` extract by injecting
   * an OSM `smoothness` tag per way (#779, ADR-0005) so GraphHopper can weight
   * quality-aware routes. Enqueued by the OSM import processor only after a
   * successful import so it can't race a running/failed one; dormant (the
   * processor no-ops) until `TARMOTO_QUALITY_CONFLATION_ENABLED=true`.
   */
  QUALITY_CONFLATION: 'quality.conflation',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUE_NAMES);

/**
 * Stable job names within each queue. BullMQ uses these for filtering
 * in the dashboard and for routing to processor methods, so they are
 * referenced by the processor decorator and by the producers.
 */
export const JOB_NAMES = {
  HAZARDS_CLEANUP_RUN: 'run',
  BADGES_RECHECK_DISPATCH: 'dispatch',
  BADGES_RECHECK_USER: 'recheck-user',
  DIGEST_WEEKLY_DISPATCH: 'dispatch',
  DIGEST_WEEKLY_COMPOSE: 'compose',
  DATA_EXPORT_PROCESS: 'process',
  ACCOUNT_DELETION_SWEEP_RUN: 'run',
  ACCOUNT_DELETION_FINALIZE_USER: 'finalize-user',
  FUNZONE_RECOMPUTE_RUN: 'run',
  LOCATION_RETENTION_SWEEP_RUN: 'run',
  WEATHER_ALERT_SWEEP_RUN: 'run',
  MODEL_EVAL_RECONCILE_RUN: 'run',
  MODEL_EVAL_AGREEMENT_RUN: 'run',
  NAP_CLOSURE_POLL_RUN: 'run',
  ROAD_IMPORT_RUN: 'run',
  QUALITY_CONFLATION_RUN: 'run',
  STORE_RECONCILIATION_RETRY_RUN: 'run',
} as const;

/**
 * Cron patterns for recurring queues. Times are evaluated in the
 * worker process's TZ; production sets `TZ=UTC` so these are UTC.
 */
export const RECURRING_PATTERNS = {
  /** Top of every hour. */
  HOURLY: '0 * * * *',
  /** Every 3 minutes (NAP closure poll). */
  EVERY_3_MINUTES: '*/3 * * * *',
  /** Every 15 minutes (severe-weather sweep). */
  EVERY_15_MINUTES: '*/15 * * * *',
  /** Daily at 03:30. */
  DAILY_0330: '30 3 * * *',
  /** Daily at 04:00 (retention sweep). */
  DAILY_0400: '0 4 * * *',
  /** Daily at 02:30 (badge nightly). */
  DAILY_0230: '30 2 * * *',
  /** Weekly Monday at 04:00 — fun-zone recompute. */
  WEEKLY_MON_0400: '0 4 * * 1',
  /** Weekly Monday at 05:00 — model-eval cross-device/bike agreement. */
  WEEKLY_MON_0500: '0 5 * * 1',
  /** Weekly Sunday at 01:00 — OSM road-graph import (before POI + fun-zones). */
  WEEKLY_SUN_0100: '0 1 * * 0',
} as const;
