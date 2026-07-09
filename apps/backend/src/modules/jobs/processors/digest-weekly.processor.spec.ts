import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import { DigestWeeklyProcessor } from './digest-weekly.processor.js';
import { JOB_NAMES } from '../jobs.constants.js';
import type { EmailService } from '../../email/email.service.js';
import type { JobsProducer } from '../jobs.producer.js';

function makeProcessor(query: jest.Mock) {
  const sendWeeklyDigest = jest.fn().mockResolvedValue(null);
  const processor = new DigestWeeklyProcessor(
    { query } as unknown as DataSource,
    {} as unknown as JobsProducer,
    { get: () => 'https://app.tarmoto.app' } as unknown as ConfigService,
    { sendWeeklyDigest } as unknown as EmailService,
  );
  return { processor, sendWeeklyDigest };
}

function composeJob(user_id = 'u1'): Job {
  return {
    name: JOB_NAMES.DIGEST_WEEKLY_COMPOSE,
    id: 'j1',
    timestamp: Date.UTC(2026, 6, 5, 8),
    data: { user_id, for_local_window: '2026-W27' },
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
    const rideCall = query.mock.calls[1] as [unknown, [string, string, string]];
    const params = rideCall[1];
    const end = new Date(params[2]).getTime();
    const start = new Date(params[1]).getTime();
    expect(end).toBe(Date.UTC(2026, 6, 5, 8)); // the job timestamp
    expect(end - start).toBe(7 * 24 * 60 * 60 * 1000); // exactly one week
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
});
