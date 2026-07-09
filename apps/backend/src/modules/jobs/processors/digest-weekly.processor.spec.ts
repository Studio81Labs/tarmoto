import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import { DigestWeeklyProcessor } from './digest-weekly.processor.js';
import { JOB_NAMES } from '../jobs.constants.js';
import type { EmailService } from '../../email/email.service.js';
import type { JobsProducer } from '../jobs.producer.js';

function makeProcessor(query: jest.Mock) {
  const sendWeeklyDigest = jest
    .fn()
    .mockResolvedValue({ providerMessageId: 'm1', providerName: 'mock' });
  const processor = new DigestWeeklyProcessor(
    { query } as unknown as DataSource,
    {} as unknown as JobsProducer,
    { get: () => 'https://app.tarmoto.app' } as unknown as ConfigService,
    { sendWeeklyDigest } as unknown as EmailService,
  );
  return { processor, sendWeeklyDigest };
}

const WINDOW_END = Date.UTC(2026, 6, 5, 8);
const WINDOW_START = WINDOW_END - 7 * 24 * 60 * 60 * 1000;

function composeJob(user_id = 'u1'): Job {
  return {
    name: JOB_NAMES.DIGEST_WEEKLY_COMPOSE,
    id: 'j1',
    timestamp: WINDOW_END,
    data: {
      user_id,
      for_local_window: '2026-W27',
      // Window bounds are computed at dispatch (DST-correct) and carried here;
      // compose reads them straight off the payload. A plain UTC week for tests.
      window_start: new Date(WINDOW_START).toISOString(),
      window_end: new Date(WINDOW_END).toISOString(),
    },
  } as unknown as Job;
}

const ELIGIBLE_USER = {
  email: 'rider@tarmoto.app',
  display_name: 'Ada',
  preferences: { units: 'imperial' },
};

describe('DigestWeeklyProcessor.compose (#866)', () => {
  it('skips an ineligible / opted-out rider without sending', async () => {
    // Eligibility query (opt-in / verified / not deleted) returns no row.
    const query = jest.fn().mockResolvedValueOnce([]);
    const { processor, sendWeeklyDigest } = makeProcessor(query);

    const result = await processor.process(composeJob());

    expect(result).toEqual({ status: 'skipped', reason: 'ineligible' });
    expect(sendWeeklyDigest).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1); // no ride query for an ineligible rider
  });

  it('skips a rider with no rides that week (no empty digest)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([ELIGIBLE_USER])
      .mockResolvedValueOnce([
        {
          ride_count: '0',
          total_km: '0',
          total_minutes: '0',
          best_quality: null,
        },
      ]);
    const { processor, sendWeeklyDigest } = makeProcessor(query);

    const result = await processor.process(composeJob());

    expect(result).toEqual({ status: 'skipped', reason: 'no-activity' });
    expect(sendWeeklyDigest).not.toHaveBeenCalled();
    // No exploration/email work once the week is empty.
    expect(query).toHaveBeenCalledTimes(2); // eligibility + ride aggregate only
  });

  it('renders + sends the digest from real ride + exploration data', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([ELIGIBLE_USER]) // eligibility
      .mockResolvedValueOnce([
        {
          ride_count: '3',
          total_km: '128.4',
          total_minutes: '195',
          best_quality: '4.3',
        },
      ]) // ride aggregate
      .mockResolvedValueOnce([{ ridden: '540' }]) // exploration: ridden
      .mockResolvedValueOnce([{ total: '1000' }]); // exploration: total
    const { processor, sendWeeklyDigest } = makeProcessor(query);

    const result = await processor.process(composeJob('u1'));

    expect(result).toEqual({ status: 'sent' });
    expect(sendWeeklyDigest).toHaveBeenCalledWith(
      'rider@tarmoto.app',
      expect.objectContaining({
        displayName: 'Ada',
        rideCount: 3,
        totalKm: 128.4,
        totalMinutes: 195,
        bestQuality: 4.3,
        percentExplored: 54, // 540 / 1000
        riddenSegments: 540,
        units: 'imperial',
        exploreUrl: 'https://app.tarmoto.app/explore',
      }),
    );
  });

  it('scopes the ride query to the 7 days ending at the dispatch time', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ ...ELIGIBLE_USER, preferences: {} }])
      .mockResolvedValueOnce([
        {
          ride_count: '0',
          total_km: '0',
          total_minutes: '0',
          best_quality: null,
        },
      ]);
    const { processor } = makeProcessor(query);

    await processor.process(composeJob());

    // 2nd call = the ride aggregate; args = [sql, [userId, windowStart, windowEnd]].
    const rideCall = query.mock.calls[1] as [string, [string, string, string]];
    const [rideSql, params] = rideCall;
    const end = new Date(params[2]).getTime();
    const start = new Date(params[1]).getTime();
    expect(end).toBe(Date.UTC(2026, 6, 5, 8)); // the job timestamp
    expect(end - start).toBe(7 * 24 * 60 * 60 * 1000); // exactly one week
    // Unfinished rides (null ended_at) are excluded from the aggregate.
    expect(rideSql).toContain('ended_at IS NOT NULL');
    // The window is keyed on ended_at (rides *completed* in the window), so
    // count/distance/duration all cover the same set — no ride is summed whole
    // for distance but truncated for time. The old LEAST(ended_at, $3) cap that
    // produced that split is gone.
    expect(rideSql).toContain('ended_at >= $2');
    expect(rideSql).toContain('ended_at < $3');
    expect(rideSql).not.toContain('LEAST(ended_at');
  });

  it('throws on a failed send so BullMQ retries instead of recording "sent"', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([ELIGIBLE_USER])
      .mockResolvedValueOnce([
        {
          ride_count: '2',
          total_km: '30',
          total_minutes: '60',
          best_quality: '4',
        },
      ])
      .mockResolvedValueOnce([{ ridden: '10' }])
      .mockResolvedValueOnce([{ total: '100' }]);
    const { processor, sendWeeklyDigest } = makeProcessor(query);
    // EmailService returns null when the provider throws (best-effort swallow).
    sendWeeklyDigest.mockResolvedValueOnce(null);

    await expect(processor.process(composeJob())).rejects.toThrow(
      /send failed/,
    );
  });

  it('gates opt-in on notification_preferences.email_digest, not the legacy flag', async () => {
    // #278 moved the digest setting out of users.preferences into the typed
    // notification_preferences table — a stale `weekly_digest` check would
    // default to true and email everyone regardless of their choice.
    const query = jest.fn().mockResolvedValueOnce([]);
    const { processor } = makeProcessor(query);

    await processor.process(composeJob());

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('notification_preferences');
    expect(sql).toContain('email_digest');
    expect(sql).not.toContain('weekly_digest');
  });

  it('tolerates a legacy compose payload (no window bounds) by deriving the week from the job timestamp', async () => {
    // A compose job enqueued by the pre-window producer (rolling deploy / Redis
    // replay) carries only user_id + for_local_window. Compose must fall back to
    // the job-timestamp week instead of crashing on new Date(undefined): a crash
    // fails the job, and the stable jobId would then block the fresh real-email
    // job for the same window until Redis evicts the failure.
    const query = jest
      .fn()
      .mockResolvedValueOnce([ELIGIBLE_USER]) // eligibility
      .mockResolvedValueOnce([
        {
          ride_count: '2',
          total_km: '40',
          total_minutes: '75',
          best_quality: '4',
        },
      ]) // ride aggregate
      .mockResolvedValueOnce([{ ridden: '10' }]) // exploration ridden
      .mockResolvedValueOnce([{ total: '100' }]); // exploration total
    const { processor, sendWeeklyDigest } = makeProcessor(query);

    const legacyJob = {
      name: JOB_NAMES.DIGEST_WEEKLY_COMPOSE,
      id: 'legacy1',
      timestamp: WINDOW_END,
      data: { user_id: 'u1', for_local_window: '2026-W27' }, // no window_* keys
    } as unknown as Job;

    const result = await processor.process(legacyJob);

    expect(result).toEqual({ status: 'sent' });
    expect(sendWeeklyDigest).toHaveBeenCalledTimes(1);
    // Ride window derived from the job timestamp: [timestamp - 7d, timestamp).
    const [, params] = query.mock.calls[1] as [
      string,
      [string, string, string],
    ];
    expect(new Date(params[2]).getTime()).toBe(WINDOW_END);
    expect(new Date(params[2]).getTime() - new Date(params[1]).getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it('memoizes the active-network total across compose jobs (no per-rider rescan)', async () => {
    // The "% explored" denominator (active road_segments) is identical for every
    // rider in a weekly burst; recounting the continent-scale table per compose
    // job is wasted DB work. A second compose on the same worker must reuse it.
    const rideAgg = {
      ride_count: '1',
      total_km: '10',
      total_minutes: '30',
      best_quality: '4',
    };
    const query = jest
      .fn()
      // compose #1: eligibility, ride aggregate, exploration ridden, total.
      .mockResolvedValueOnce([ELIGIBLE_USER])
      .mockResolvedValueOnce([rideAgg])
      .mockResolvedValueOnce([{ ridden: '5' }])
      .mockResolvedValueOnce([{ total: '100' }])
      // compose #2: eligibility, ride aggregate, ridden — NO total (cache hit).
      .mockResolvedValueOnce([ELIGIBLE_USER])
      .mockResolvedValueOnce([rideAgg])
      .mockResolvedValueOnce([{ ridden: '9' }]);
    const { processor } = makeProcessor(query);

    expect(await processor.process(composeJob('u1'))).toEqual({
      status: 'sent',
    });
    expect(await processor.process(composeJob('u2'))).toEqual({
      status: 'sent',
    });

    // 4 queries for the first compose, only 3 for the second: the active-segment
    // COUNT(*) is served from the in-process cache the second time.
    expect(query).toHaveBeenCalledTimes(7);
    const totalCounts = query.mock.calls.filter(([sql]) =>
      /FROM road_segments\s+WHERE deactivated_at IS NULL/.test(sql as string),
    );
    expect(totalCounts).toHaveLength(1);
  });
});
