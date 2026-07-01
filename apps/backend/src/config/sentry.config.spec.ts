import { createSentryOptions } from './sentry.config.js';

describe('createSentryOptions', () => {
  it('returns null when no DSN is configured (Sentry stays off)', () => {
    expect(createSentryOptions({})).toBeNull();
    expect(
      createSentryOptions({ TARMOTO_SENTRY_ENVIRONMENT: 'staging' }),
    ).toBeNull();
  });

  it('enables Sentry when a DSN is present', () => {
    const opts = createSentryOptions({
      TARMOTO_SENTRY_DSN: 'https://x@o1.ingest.sentry.io/1',
    });
    expect(opts).not.toBeNull();
    expect(opts?.dsn).toBe('https://x@o1.ingest.sentry.io/1');
    expect(opts?.sendDefaultPii).toBe(false);
  });

  it('falls back SENTRY_DSN and derives release/environment from tarmoto vars', () => {
    const opts = createSentryOptions({
      SENTRY_DSN: 'https://y@o2.ingest.sentry.io/2',
      TARMOTO_APP_VERSION: '1.2.3',
      TARMOTO_DEPLOY_ENV: 'production',
    });
    expect(opts?.dsn).toBe('https://y@o2.ingest.sentry.io/2');
    expect(opts?.release).toBe('1.2.3');
    expect(opts?.environment).toBe('production');
  });

  it('prefers explicit release + environment over fallbacks', () => {
    const opts = createSentryOptions({
      TARMOTO_SENTRY_DSN: 'https://x@o1.ingest.sentry.io/1',
      TARMOTO_SENTRY_RELEASE: 'rel-9',
      TARMOTO_APP_VERSION: '1.2.3',
      TARMOTO_SENTRY_ENVIRONMENT: 'staging',
      TARMOTO_DEPLOY_ENV: 'production',
    });
    expect(opts?.release).toBe('rel-9');
    expect(opts?.environment).toBe('staging');
  });

  it('only sets tracesSampleRate for a valid 0..1 value', () => {
    const dsn = 'https://x@o1.ingest.sentry.io/1';
    expect(
      createSentryOptions({
        TARMOTO_SENTRY_DSN: dsn,
        TARMOTO_SENTRY_TRACES_SAMPLE_RATE: '0.25',
      })?.tracesSampleRate,
    ).toBe(0.25);
    expect(
      createSentryOptions({
        TARMOTO_SENTRY_DSN: dsn,
        TARMOTO_SENTRY_TRACES_SAMPLE_RATE: '2',
      }),
    ).not.toHaveProperty('tracesSampleRate');
    expect(
      createSentryOptions({
        TARMOTO_SENTRY_DSN: dsn,
        TARMOTO_SENTRY_TRACES_SAMPLE_RATE: 'nope',
      }),
    ).not.toHaveProperty('tracesSampleRate');
  });
});
