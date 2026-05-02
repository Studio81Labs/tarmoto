import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { DataSource, MoreThanOrEqual, Repository } from 'typeorm';
import type {
  WeatherAlertKind,
  WeatherResponseDto,
} from '../../weather/dto/weather.dto.js';
import {
  WeatherService,
  WIND_ALERT_THRESHOLD_KMH,
} from '../../weather/weather.service.js';
import { PushService } from '../../push/push.service.js';
import { WeatherAlertDispatch } from '../../../entities/weather-alert-dispatch.entity.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

/**
 * Live-position threshold. A group-ride member whose last broadcast
 * is older than this is considered offline for sweep purposes — we
 * don't want to fire a storm alert at someone whose phone died an
 * hour ago.
 */
const LIVE_POSITION_WINDOW_MIN = 15;

/**
 * Per-(user, kind) cooldown. A storm cell typically lingers for an
 * hour or more, so without this the same rider would be paged on
 * every 15-minute sweep tick. One push per kind per cooldown window
 * is the right balance: enough to prevent spam, short enough that a
 * second wave of weather (e.g. wind picking up after a storm) still
 * surfaces.
 */
const COOLDOWN_WINDOW_MIN = 60;

/**
 * Spatial bucket size (degrees) for memoising weather lookups within
 * a single sweep tick. Riders rounded to the same 2-decimal cell
 * (~1.1 km at the equator, smaller toward the poles) share one
 * upstream weather call. Concretely cuts the OpenWeatherMap call
 * count when several friends ride together in a group session, which
 * is the common case for the live-location feature this sweep keys
 * off.
 */
const WEATHER_MEMO_PRECISION = 2;

interface ActiveRiderRow {
  user_id: string;
  last_lat: number;
  last_lng: number;
}

interface SevereAlert {
  kind: WeatherAlertKind;
  title: string;
  body: string;
}

export interface WeatherAlertSweepResult {
  /** Distinct riders considered (active group ride + recent position). */
  riders_checked: number;
  /** Riders whose current weather crossed a severe threshold. */
  severe_detected: number;
  /** Pushes successfully delivered to a provider. */
  dispatched: number;
  /** Riders skipped because a recent dispatch is still inside the cooldown. */
  cooldown_skipped: number;
}

/**
 * #333 — recurring sweep that pages active riders sitting inside a
 * severe-weather cell.
 *
 * The pipeline is intentionally narrow:
 *   1. Find every distinct rider whose group-ride session is still
 *      active and whose `last_position_at` falls inside the live
 *      window. Group-ride members are the only data source we have
 *      for "rider X is currently at lat/lng" — solo rides upload
 *      sensor batches but don't broadcast a live position.
 *   2. Memoise weather lookups by a coarse spatial bucket so co-located
 *      riders don't each cost a provider call.
 *   3. For each severe condition (storm, ice, or wind > 60 km/h),
 *      check the per-(user, kind) cooldown ledger. Skip if a row
 *      newer than the cooldown window exists.
 *   4. Dispatch via `PushService.sendToUser`, which gates by category
 *      preference + quiet hours (`weather_alert` is non-critical, so
 *      quiet hours apply). Record the dispatch only when the provider
 *      actually accepted at least one token — quiet-hour suppression
 *      shouldn't poison the cooldown.
 *
 * The job is best-effort: a provider failure for one rider logs a
 * warning and does not abort the sweep.
 */
@Processor(QUEUE_NAMES.WEATHER_ALERT_SWEEP)
export class WeatherAlertSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(WeatherAlertSweepProcessor.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly weather: WeatherService,
    private readonly push: PushService,
    @InjectRepository(WeatherAlertDispatch)
    private readonly dispatchRepo: Repository<WeatherAlertDispatch>,
  ) {
    super();
  }

  async process(job: Job): Promise<WeatherAlertSweepResult> {
    const riders = await this.findActiveRiders();
    if (riders.length === 0) {
      return zeroResult();
    }

    const weatherCache = new Map<string, WeatherResponseDto | null>();
    const cooldownCutoff = new Date(
      Date.now() - COOLDOWN_WINDOW_MIN * 60 * 1000,
    );

    let severeDetected = 0;
    let dispatched = 0;
    let cooldownSkipped = 0;

    for (const rider of riders) {
      const weather = await this.lookupWeather(rider, weatherCache);
      if (!weather) continue;

      const alert = severeAlertFor(weather);
      if (!alert) continue;
      severeDetected++;

      const inCooldown = await this.recentDispatchExists(
        rider.user_id,
        alert.kind,
        cooldownCutoff,
      );
      if (inCooldown) {
        cooldownSkipped++;
        continue;
      }

      const result = await this.safeSend(rider, alert);
      if (!result) continue;

      // Quiet hours / preference-off should NOT consume the cooldown
      // — once the rider's quiet window ends, the next sweep should
      // still page them if conditions remain severe. Only an actual
      // provider acceptance (or a failed delivery attempt to a real
      // token) counts as "we tried, give it a rest".
      if (result.delivered > 0) {
        dispatched++;
        await this.recordDispatch(rider.user_id, alert.kind);
      }
    }

    if (severeDetected > 0) {
      this.logger.log(
        `[${job.id ?? 'no-id'}] sweep: riders=${riders.length} ` +
          `severe=${severeDetected} dispatched=${dispatched} ` +
          `cooldown_skipped=${cooldownSkipped}`,
      );
    }

    return {
      riders_checked: riders.length,
      severe_detected: severeDetected,
      dispatched,
      cooldown_skipped: cooldownSkipped,
    };
  }

  private async findActiveRiders(): Promise<ActiveRiderRow[]> {
    // DISTINCT on user_id — a rider could (in principle) be in more
    // than one active session. The sweep should still send at most
    // one push per kind per rider per cooldown window regardless.
    const rows: ActiveRiderRow[] = await this.dataSource.query(
      `SELECT DISTINCT ON (m.user_id)
         m.user_id,
         m.last_lat,
         m.last_lng
       FROM group_ride_members m
       JOIN group_rides g ON g.id = m.group_ride_id
       WHERE g.ended_at IS NULL
         AND m.last_lat IS NOT NULL
         AND m.last_lng IS NOT NULL
         AND m.last_position_at >= NOW() - ($1::int * INTERVAL '1 minute')
       ORDER BY m.user_id, m.last_position_at DESC`,
      [LIVE_POSITION_WINDOW_MIN],
    );
    return rows;
  }

  private async lookupWeather(
    rider: ActiveRiderRow,
    cache: Map<string, WeatherResponseDto | null>,
  ): Promise<WeatherResponseDto | null> {
    const key = `${rider.last_lat.toFixed(WEATHER_MEMO_PRECISION)},${rider.last_lng.toFixed(WEATHER_MEMO_PRECISION)}`;
    if (cache.has(key)) {
      return cache.get(key) ?? null;
    }
    try {
      const weather = await this.weather.getCurrentWeather(
        rider.last_lat,
        rider.last_lng,
      );
      cache.set(key, weather);
      return weather;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `weather lookup failed for user=${rider.user_id} ` +
          `lat=${rider.last_lat} lng=${rider.last_lng}: ${reason}`,
      );
      cache.set(key, null);
      return null;
    }
  }

  private async recentDispatchExists(
    userId: string,
    kind: WeatherAlertKind,
    cutoff: Date,
  ): Promise<boolean> {
    const recent = await this.dispatchRepo.findOne({
      where: {
        user_id: userId,
        kind,
        dispatched_at: MoreThanOrEqual(cutoff),
      },
      select: ['id'],
    });
    return recent !== null;
  }

  private async safeSend(
    rider: ActiveRiderRow,
    alert: SevereAlert,
  ): Promise<{ delivered: number } | null> {
    try {
      const result = await this.push.sendToUser(rider.user_id, {
        category: 'weather_alert',
        title: alert.title,
        body: alert.body,
        data: {
          type: 'weather_alert',
          kind: alert.kind,
          lat: rider.last_lat.toFixed(5),
          lng: rider.last_lng.toFixed(5),
        },
      });
      return { delivered: result.delivered };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `push dispatch failed for user=${rider.user_id} kind=${alert.kind}: ${reason}`,
      );
      return null;
    }
  }

  private async recordDispatch(
    userId: string,
    kind: WeatherAlertKind,
  ): Promise<void> {
    try {
      await this.dispatchRepo.insert({
        user_id: userId,
        kind,
      });
    } catch (err) {
      // Cooldown is a best-effort guard, not a correctness invariant
      // — a missed insert just means the next sweep may re-page the
      // rider. Log and move on rather than failing the whole job.
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `failed to record weather dispatch for user=${userId} kind=${kind}: ${reason}`,
      );
    }
  }
}

export function severeAlertFor(
  weather: WeatherResponseDto,
): SevereAlert | null {
  // Order matters: ice and storm are critical and should win over a
  // simultaneous wind warning so the rider sees the most actionable
  // copy. Wet roads are intentionally excluded — they are info-level
  // in the existing weather banner and not push-worthy.
  if (weather.condition === 'ice' || weather.road_condition === 'icy') {
    return {
      kind: 'ice',
      title: 'Icy roads ahead',
      body: 'Ice detected at your location. Slow down and consider pulling over.',
    };
  }
  if (weather.condition === 'storm') {
    return {
      kind: 'storm',
      title: 'Severe storm ahead',
      body: 'Storm conditions at your location. Consider rerouting or pulling over.',
    };
  }
  if (weather.wind_kmh > WIND_ALERT_THRESHOLD_KMH) {
    return {
      kind: 'wind',
      title: 'High wind warning',
      body: `${Math.round(weather.wind_kmh)} km/h winds at your location.`,
    };
  }
  return null;
}

function zeroResult(): WeatherAlertSweepResult {
  return {
    riders_checked: 0,
    severe_detected: 0,
    dispatched: 0,
    cooldown_skipped: 0,
  };
}
