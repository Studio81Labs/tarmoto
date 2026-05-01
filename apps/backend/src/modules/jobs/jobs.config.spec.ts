import { ConfigService } from '@nestjs/config';
import { buildJobsConfig, DEFAULT_JOB_OPTIONS } from './jobs.config.js';

function fakeConfig(env: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => env[key] as T | undefined,
  } as unknown as ConfigService;
}

describe('buildJobsConfig', () => {
  it('reads TARMOTO_REDIS_HOST/PORT and falls back to localhost:6379', () => {
    const cfg = buildJobsConfig(fakeConfig({}));
    expect(cfg.connection).toMatchObject({ host: 'localhost', port: 6379 });
  });

  it('parses the TARMOTO_REDIS_PORT env var as a number', () => {
    const cfg = buildJobsConfig(
      fakeConfig({ TARMOTO_REDIS_HOST: 'redis', TARMOTO_REDIS_PORT: '6380' }),
    );
    expect(cfg.connection).toMatchObject({ host: 'redis', port: 6380 });
  });

  it('defaults workersEnabled=true when the toggle is unset (single-container dev)', () => {
    const cfg = buildJobsConfig(fakeConfig({}));
    expect(cfg.workersEnabled).toBe(true);
  });

  it('disables workers only on the literal "false" string (case-insensitive)', () => {
    expect(
      buildJobsConfig(fakeConfig({ TARMOTO_QUEUE_WORKER_ENABLED: 'false' }))
        .workersEnabled,
    ).toBe(false);
    expect(
      buildJobsConfig(fakeConfig({ TARMOTO_QUEUE_WORKER_ENABLED: 'FALSE' }))
        .workersEnabled,
    ).toBe(false);
    // A typo must not silently disable processing.
    expect(
      buildJobsConfig(fakeConfig({ TARMOTO_QUEUE_WORKER_ENABLED: 'no' }))
        .workersEnabled,
    ).toBe(true);
    expect(
      buildJobsConfig(fakeConfig({ TARMOTO_QUEUE_WORKER_ENABLED: '0' }))
        .workersEnabled,
    ).toBe(true);
  });

  it('sets BullMQ-required maxRetriesPerRequest=null on the connection', () => {
    const cfg = buildJobsConfig(fakeConfig({}));
    // BullMQ workers will refuse to start if this is anything other
    // than null — guard against a future "helpful" tweak.
    expect(
      (cfg.connection as { maxRetriesPerRequest: number | null })
        .maxRetriesPerRequest,
    ).toBeNull();
  });
});

describe('DEFAULT_JOB_OPTIONS', () => {
  it('caps attempts at 5 with exponential backoff', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(5);
    expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({
      type: 'exponential',
      delay: 30_000,
    });
  });

  it('keeps a bounded retention window for completed and failed jobs', () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({ count: 1000 });
    // `age` (24h) is load-bearing: jobId-based dedup blocks re-enqueue
    // against ANY persisted job (including failed). Without the age cap,
    // a stuck failed job on a low-volume queue could sit in Redis for
    // months — long enough to break GDPR account-deletion finalize.
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toEqual({
      age: 24 * 60 * 60,
      count: 5000,
    });
  });
});
