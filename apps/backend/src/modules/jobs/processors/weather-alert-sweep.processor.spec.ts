/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { WeatherService } from '../../weather/weather.service.js';
import { PushService } from '../../push/push.service.js';
import { WeatherAlertDispatch } from '../../../entities/weather-alert-dispatch.entity.js';
import {
  WeatherAlertSweepProcessor,
  severeAlertFor,
} from './weather-alert-sweep.processor.js';
import { JOB_NAMES } from '../jobs.constants.js';

function fakeJob<T = unknown>(
  name: string,
  data: T,
): { id: string; name: string; data: T } {
  return { id: 'job-test', name, data };
}

function clearWeather(overrides: Record<string, unknown> = {}): {
  temperature_c: number;
  condition: 'clear' | 'storm' | 'ice' | 'rain';
  wind_kmh: number;
  precipitation_chance: number;
  road_condition: 'dry' | 'wet' | 'icy' | 'unknown';
  description: string;
} {
  return {
    temperature_c: 18,
    condition: 'clear',
    wind_kmh: 10,
    precipitation_chance: 0,
    road_condition: 'dry',
    description: '18°C · Dry roads · Wind 10 km/h',
    ...overrides,
  };
}

describe('severeAlertFor', () => {
  it('returns null for benign conditions (clear sky, light wind, dry roads)', () => {
    expect(severeAlertFor(clearWeather())).toBeNull();
  });

  it('returns null for wet roads — info-level only, not push-worthy', () => {
    // Wet roads matter for the in-app banner but are not severe
    // enough to interrupt a rider with a push notification.
    expect(severeAlertFor(clearWeather({ road_condition: 'wet' }))).toBeNull();
  });

  it('returns null when wind is high but below the 60 km/h threshold (boundary)', () => {
    expect(severeAlertFor(clearWeather({ wind_kmh: 60 }))).toBeNull();
  });

  it('returns a wind alert when wind crosses the 60 km/h threshold', () => {
    const alert = severeAlertFor(clearWeather({ wind_kmh: 72 }));
    expect(alert).not.toBeNull();
    expect(alert?.kind).toBe('wind');
    expect(alert?.body).toMatch(/72 km\/h/);
  });

  it('returns a storm alert for stormy weather', () => {
    const alert = severeAlertFor(clearWeather({ condition: 'storm' }));
    expect(alert?.kind).toBe('storm');
  });

  it('returns an ice alert when condition is ice', () => {
    const alert = severeAlertFor(
      clearWeather({ condition: 'ice', road_condition: 'icy' }),
    );
    expect(alert?.kind).toBe('ice');
  });

  it('returns an ice alert when road_condition is icy even if condition itself is not ice', () => {
    const alert = severeAlertFor(
      clearWeather({ condition: 'rain', road_condition: 'icy' }),
    );
    expect(alert?.kind).toBe('ice');
  });

  it('prioritises ice over a simultaneous high-wind alert (more actionable copy first)', () => {
    const alert = severeAlertFor(
      clearWeather({ road_condition: 'icy', wind_kmh: 80 }),
    );
    expect(alert?.kind).toBe('ice');
  });

  it('prioritises storm over a simultaneous high-wind alert', () => {
    const alert = severeAlertFor(
      clearWeather({ condition: 'storm', wind_kmh: 80 }),
    );
    expect(alert?.kind).toBe('storm');
  });
});

describe('WeatherAlertSweepProcessor', () => {
  let dataSource: { query: jest.Mock };
  let weather: { getCurrentWeather: jest.Mock };
  let push: { sendToUser: jest.Mock };
  let dispatchRepo: { findOne: jest.Mock; insert: jest.Mock };
  let processor: WeatherAlertSweepProcessor;

  beforeEach(async () => {
    dataSource = { query: jest.fn() };
    weather = { getCurrentWeather: jest.fn() };
    push = { sendToUser: jest.fn() };
    dispatchRepo = { findOne: jest.fn(), insert: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WeatherAlertSweepProcessor,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: WeatherService, useValue: weather },
        { provide: PushService, useValue: push },
        {
          provide: getRepositoryToken(WeatherAlertDispatch),
          useValue: dispatchRepo,
        },
      ],
    }).compile();
    processor = moduleRef.get(WeatherAlertSweepProcessor);
  });

  function runJob(): Promise<unknown> {
    return processor.process(
      fakeJob(JOB_NAMES.WEATHER_ALERT_SWEEP_RUN, {}) as never,
    );
  }

  it('returns zeros when no active riders exist (skips weather + push entirely)', async () => {
    dataSource.query.mockResolvedValue([]);
    const result = await runJob();
    expect(weather.getCurrentWeather).not.toHaveBeenCalled();
    expect(push.sendToUser).not.toHaveBeenCalled();
    expect(result).toEqual({
      riders_checked: 0,
      severe_detected: 0,
      dispatched: 0,
      cooldown_skipped: 0,
    });
  });

  it('queries only group-ride members with recent live position (live window threshold)', async () => {
    dataSource.query.mockResolvedValue([]);
    await runJob();
    const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
    // The SQL must filter out ended sessions, riders without a live
    // position, and stale broadcasts. Asserting the predicates rather
    // than the exact SQL so cosmetic refactors don't break the test.
    expect(sql).toMatch(/group_rides/);
    expect(sql).toMatch(/ended_at IS NULL/);
    expect(sql).toMatch(/last_lat IS NOT NULL/);
    expect(sql).toMatch(/last_lng IS NOT NULL/);
    expect(sql).toMatch(/last_position_at >= NOW\(\)/);
    expect(params).toContain(15);
  });

  it('skips riders whose current weather is benign — no push, no cooldown insert', async () => {
    dataSource.query.mockResolvedValue([
      { user_id: 'u1', last_lat: 49.1, last_lng: 16.75 },
    ]);
    weather.getCurrentWeather.mockResolvedValue(clearWeather());

    const result = await runJob();

    expect(push.sendToUser).not.toHaveBeenCalled();
    expect(dispatchRepo.insert).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      riders_checked: 1,
      severe_detected: 0,
      dispatched: 0,
    });
  });

  it('dispatches a weather_alert push for a rider sitting in a storm', async () => {
    dataSource.query.mockResolvedValue([
      { user_id: 'u1', last_lat: 49.1, last_lng: 16.75 },
    ]);
    weather.getCurrentWeather.mockResolvedValue(
      clearWeather({ condition: 'storm' }),
    );
    dispatchRepo.findOne.mockResolvedValue(null);
    push.sendToUser.mockResolvedValue({
      delivered: 2,
      pruned: 0,
      suppressed: false,
    });
    dispatchRepo.insert.mockResolvedValue({});

    const result = await runJob();

    expect(push.sendToUser).toHaveBeenCalledTimes(1);
    const [userId, payload] = push.sendToUser.mock.calls[0] as [
      string,
      {
        category: string;
        title: string;
        body: string;
        data: Record<string, string>;
      },
    ];
    expect(userId).toBe('u1');
    expect(payload.category).toBe('weather_alert');
    expect(payload.title.toLowerCase()).toContain('storm');
    expect(payload.data).toMatchObject({
      type: 'weather_alert',
      kind: 'storm',
    });
    expect(dispatchRepo.insert).toHaveBeenCalledWith({
      user_id: 'u1',
      kind: 'storm',
    });
    expect(result).toMatchObject({
      riders_checked: 1,
      severe_detected: 1,
      dispatched: 1,
      cooldown_skipped: 0,
    });
  });

  it('honours the cooldown — skips riders with a recent dispatch row, never calls push', async () => {
    dataSource.query.mockResolvedValue([
      { user_id: 'u1', last_lat: 49.1, last_lng: 16.75 },
    ]);
    weather.getCurrentWeather.mockResolvedValue(
      clearWeather({ condition: 'storm' }),
    );
    // Existing recent dispatch for this (user, kind) — sweep must
    // not page the rider again until the cooldown window elapses.
    dispatchRepo.findOne.mockResolvedValue({ id: 'd1' });

    const result = await runJob();

    expect(push.sendToUser).not.toHaveBeenCalled();
    expect(dispatchRepo.insert).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      severe_detected: 1,
      dispatched: 0,
      cooldown_skipped: 1,
    });
  });

  it('does not record a dispatch when push is suppressed by prefs/quiet-hours (delivered=0)', async () => {
    // Quiet hours and preference-off both manifest as delivered=0 in
    // the PushService result. Recording a dispatch here would block
    // the next post-quiet-hours sweep from paging the rider, which
    // is exactly the wrong behaviour.
    dataSource.query.mockResolvedValue([
      { user_id: 'u1', last_lat: 49.1, last_lng: 16.75 },
    ]);
    weather.getCurrentWeather.mockResolvedValue(
      clearWeather({ condition: 'storm' }),
    );
    dispatchRepo.findOne.mockResolvedValue(null);
    push.sendToUser.mockResolvedValue({
      delivered: 0,
      pruned: 0,
      suppressed: true,
      suppressedReason: 'quiet-hours',
    });

    const result = await runJob();

    expect(push.sendToUser).toHaveBeenCalledTimes(1);
    expect(dispatchRepo.insert).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      severe_detected: 1,
      dispatched: 0,
    });
  });

  it('memoises weather lookups for co-located riders (same ~1km cell → one upstream call)', async () => {
    // Three riders within the same 0.01° bucket — typical of a group
    // ride keeping formation. Without the memo we would burn 3 OWM
    // calls per sweep tick; the test pins the optimisation in place.
    dataSource.query.mockResolvedValue([
      // All three coords round to the same (49.12, 16.75) bucket at
      // 2-decimal precision (the memoisation key in the processor).
      { user_id: 'u1', last_lat: 49.121, last_lng: 16.751 },
      { user_id: 'u2', last_lat: 49.124, last_lng: 16.752 },
      { user_id: 'u3', last_lat: 49.119, last_lng: 16.748 },
    ]);
    weather.getCurrentWeather.mockResolvedValue(clearWeather());

    await runJob();

    expect(weather.getCurrentWeather).toHaveBeenCalledTimes(1);
  });

  it('continues the sweep when the weather provider throws for one rider', async () => {
    dataSource.query.mockResolvedValue([
      { user_id: 'u1', last_lat: 49.1, last_lng: 16.75 },
      { user_id: 'u2', last_lat: 50.5, last_lng: 14.0 },
    ]);
    weather.getCurrentWeather
      .mockRejectedValueOnce(new Error('OWM 503'))
      .mockResolvedValueOnce(clearWeather({ condition: 'storm' }));
    dispatchRepo.findOne.mockResolvedValue(null);
    push.sendToUser.mockResolvedValue({
      delivered: 1,
      pruned: 0,
      suppressed: false,
    });

    const result = await runJob();

    expect(push.sendToUser).toHaveBeenCalledTimes(1);
    expect(push.sendToUser).toHaveBeenCalledWith('u2', expect.any(Object));
    expect(result).toMatchObject({
      riders_checked: 2,
      severe_detected: 1,
      dispatched: 1,
    });
  });

  it('continues the sweep when push throws for one rider', async () => {
    dataSource.query.mockResolvedValue([
      { user_id: 'u1', last_lat: 49.1, last_lng: 16.75 },
      { user_id: 'u2', last_lat: 50.5, last_lng: 14.0 },
    ]);
    weather.getCurrentWeather.mockResolvedValue(
      clearWeather({ condition: 'storm' }),
    );
    dispatchRepo.findOne.mockResolvedValue(null);
    push.sendToUser
      .mockRejectedValueOnce(new Error('FCM down'))
      .mockResolvedValueOnce({ delivered: 1, pruned: 0, suppressed: false });

    const result = await runJob();

    expect(push.sendToUser).toHaveBeenCalledTimes(2);
    // Only the successful dispatch should record a cooldown row.
    expect(dispatchRepo.insert).toHaveBeenCalledTimes(1);
    expect(dispatchRepo.insert).toHaveBeenCalledWith({
      user_id: 'u2',
      kind: 'storm',
    });
    expect(result).toMatchObject({
      severe_detected: 2,
      dispatched: 1,
    });
  });

  it('uses a 60-minute cooldown window when checking the dispatch ledger', async () => {
    dataSource.query.mockResolvedValue([
      { user_id: 'u1', last_lat: 49.1, last_lng: 16.75 },
    ]);
    weather.getCurrentWeather.mockResolvedValue(
      clearWeather({ condition: 'storm' }),
    );
    dispatchRepo.findOne.mockResolvedValue(null);
    push.sendToUser.mockResolvedValue({
      delivered: 1,
      pruned: 0,
      suppressed: false,
    });

    const before = Date.now();
    await runJob();
    const after = Date.now();

    // The cutoff passed to findOne is `now - COOLDOWN_WINDOW_MIN * 60_000`.
    // Assert the cutoff falls inside [before-60min, after-60min] so a
    // regression that switches to a different window (or accidentally
    // adds time instead of subtracting) trips the assertion.
    expect(dispatchRepo.findOne).toHaveBeenCalledTimes(1);
    const findOneArgs = dispatchRepo.findOne.mock.calls[0][0] as {
      where: { dispatched_at: { value: Date } };
    };
    const cutoff = findOneArgs.where.dispatched_at.value;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 60 * 60 * 1000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 60 * 60 * 1000);
  });
});
