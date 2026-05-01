import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import {
  LOCATION_RETENTION_VALUES,
  locationRetentionToDays,
} from '@tarmoto/shared';
import { QUEUE_NAMES } from '../jobs.constants.js';

interface UserIdRow {
  user_id: string;
}

interface NullableUserIdRow {
  user_id: string | null;
}

export interface LocationRetentionSweepResult {
  /** Total raw GPS / sensor rows deleted across all users this tick. */
  surface_readings_deleted: number;
  /** Total ride-route geometries cleared. */
  ride_geoms_cleared: number;
  /** Number of users whose data was touched. */
  users_swept: number;
}

/**
 * Daily recurring job. Enforces every user's `location_retention`
 * preference (#279) by removing the per-user raw GPS / sensor rows
 * older than their chosen window. Aggregated road-quality data is
 * untouched — the privacy page is explicit that anonymised
 * contributions stick around forever.
 *
 * Concretely, for each retention bucket (`3months`, `6months`,
 * `1year`, `2years`):
 *
 *   1. Delete `surface_readings` rows belonging to the bucket's users
 *      with `recorded_at` older than the cutoff. The aggregate
 *      `road_segments.quality_score` was already folded in by the
 *      recency-weighted aggregation job, so the delete doesn't drop
 *      any signal we still need.
 *   2. Null out `rides.route_geom` for rides that started before the
 *      cutoff. We keep the ride row itself (distance, duration, stats)
 *      so the rider's history graph and totals stay intact — only the
 *      raw GPS trace is purged.
 *
 * Users who chose `forever` are skipped entirely — no retention
 * pressure means no work to do. Users with no privacy_preferences row
 * fall under the default (`1year`).
 *
 * Cadence is daily (04:00 UTC) so that a rider lowering their window
 * sees their data shrink within 24 hours, not at the next monthly
 * job cycle. The sweep is idempotent — re-running deletes zero rows.
 */
@Processor(QUEUE_NAMES.LOCATION_RETENTION_SWEEP)
export class LocationRetentionSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(LocationRetentionSweepProcessor.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job): Promise<LocationRetentionSweepResult> {
    let totalReadings = 0;
    let totalRides = 0;
    const users = new Set<string>();

    // Iterate through every retention bucket the user could have
    // selected. `forever` is intentionally absent — those users never
    // get swept.
    for (const retention of LOCATION_RETENTION_VALUES) {
      const days = locationRetentionToDays(retention);
      if (days === null) continue;

      const result = await this.sweepBucket(retention, days);
      totalReadings += result.surface_readings_deleted;
      totalRides += result.ride_geoms_cleared;
      for (const id of result.user_ids) users.add(id);
    }

    // Also sweep users who never opened the privacy page — they fall
    // under the default retention. Processed last so any explicit
    // `1year` row above doesn't double-charge them.
    const defaultDays = locationRetentionToDays('1year');
    if (defaultDays !== null) {
      const result = await this.sweepDefaultUsers(defaultDays);
      totalReadings += result.surface_readings_deleted;
      totalRides += result.ride_geoms_cleared;
      for (const id of result.user_ids) users.add(id);
    }

    if (totalReadings > 0 || totalRides > 0) {
      this.logger.log(
        `[${job.id ?? 'no-id'}] retention sweep: deleted ${totalReadings} ` +
          `surface_reading row(s), cleared ${totalRides} ride geom(s) across ` +
          `${users.size} user(s)`,
      );
    }

    return {
      surface_readings_deleted: totalReadings,
      ride_geoms_cleared: totalRides,
      users_swept: users.size,
    };
  }

  private async sweepBucket(
    retention: string,
    days: number,
  ): Promise<{
    surface_readings_deleted: number;
    ride_geoms_cleared: number;
    user_ids: string[];
  }> {
    const userRows: UserIdRow[] = await this.dataSource.query(
      `SELECT user_id FROM privacy_preferences WHERE location_retention = $1`,
      [retention],
    );

    if (userRows.length === 0) {
      return {
        surface_readings_deleted: 0,
        ride_geoms_cleared: 0,
        user_ids: [],
      };
    }

    const userIds = userRows.map((r) => r.user_id);
    return this.purgeForUsers(userIds, days);
  }

  private async sweepDefaultUsers(days: number): Promise<{
    surface_readings_deleted: number;
    ride_geoms_cleared: number;
    user_ids: string[];
  }> {
    // Users who haven't saved preferences yet inherit the default
    // (`1year`). We can't enumerate them all (could be millions), so
    // instead we run the purge with a `LEFT JOIN privacy_preferences`
    // filter — affecting only rows that don't have an explicit row.
    const cutoff = this.cutoffDate(days);

    const surfaceResult: NullableUserIdRow[] = await this.dataSource.query(
      `DELETE FROM surface_readings sr
       USING users u
       LEFT JOIN privacy_preferences pp ON pp.user_id = u.id
       WHERE sr.user_id = u.id
         AND pp.user_id IS NULL
         AND sr.recorded_at < $1
       RETURNING sr.user_id`,
      [cutoff],
    );

    const rideResult: UserIdRow[] = await this.dataSource.query(
      `UPDATE rides r
       SET route_geom = NULL
       FROM users u
       LEFT JOIN privacy_preferences pp ON pp.user_id = u.id
       WHERE r.user_id = u.id
         AND pp.user_id IS NULL
         AND r.route_geom IS NOT NULL
         AND r.started_at < $1
       RETURNING r.user_id`,
      [cutoff],
    );

    const userIds = new Set<string>();
    for (const r of surfaceResult) {
      if (r.user_id) userIds.add(r.user_id);
    }
    for (const r of rideResult) userIds.add(r.user_id);

    return {
      surface_readings_deleted: surfaceResult.length,
      ride_geoms_cleared: rideResult.length,
      user_ids: Array.from(userIds),
    };
  }

  private async purgeForUsers(
    userIds: string[],
    days: number,
  ): Promise<{
    surface_readings_deleted: number;
    ride_geoms_cleared: number;
    user_ids: string[];
  }> {
    const cutoff = this.cutoffDate(days);

    const surfaceResult: NullableUserIdRow[] = await this.dataSource.query(
      `DELETE FROM surface_readings
       WHERE user_id = ANY($1::uuid[])
         AND recorded_at < $2
       RETURNING user_id`,
      [userIds, cutoff],
    );

    const rideResult: UserIdRow[] = await this.dataSource.query(
      `UPDATE rides
       SET route_geom = NULL
       WHERE user_id = ANY($1::uuid[])
         AND route_geom IS NOT NULL
         AND started_at < $2
       RETURNING user_id`,
      [userIds, cutoff],
    );

    const touched = new Set<string>();
    for (const r of surfaceResult) {
      if (r.user_id) touched.add(r.user_id);
    }
    for (const r of rideResult) touched.add(r.user_id);

    return {
      surface_readings_deleted: surfaceResult.length,
      ride_geoms_cleared: rideResult.length,
      user_ids: Array.from(touched),
    };
  }

  private cutoffDate(days: number): Date {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    return cutoff;
  }
}
