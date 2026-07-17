import type { NodeOptions } from "@sentry/nestjs";

type Env = Record<string, string | undefined>;

/**
 * Build the Sentry init options, or `null` when Sentry is not configured.
 *
 * Sentry is OFF until `TARMOTO_SENTRY_DSN` is set: with no DSN this returns
 * `null` and `instrument.ts` skips `Sentry.init`, so the ingest service runs
 * exactly as before. Once the DSN is provided (e.g. in Coolify) it activates
 * with no further code change. The release defaults to the version the
 * deploy stamps into `TARMOTO_SENTRY_RELEASE` / `TARMOTO_APP_VERSION`
 * (see .github/workflows/ingest-deploy.yml).
 */
export function createSentryOptions(
  env: Env = process.env,
): NodeOptions | null {
  const dsn = firstPresent(env.TARMOTO_SENTRY_DSN, env.SENTRY_DSN);
  if (!dsn) return null;

  const tracesSampleRate = parseSampleRate(
    firstPresent(
      env.TARMOTO_SENTRY_TRACES_SAMPLE_RATE,
      env.SENTRY_TRACES_SAMPLE_RATE,
    ),
  );

  return {
    dsn,
    environment: firstPresent(
      env.TARMOTO_SENTRY_ENVIRONMENT,
      env.SENTRY_ENVIRONMENT,
      env.TARMOTO_DEPLOY_ENV,
      env.NODE_ENV,
    ),
    release: firstPresent(
      env.TARMOTO_SENTRY_RELEASE,
      env.SENTRY_RELEASE,
      env.TARMOTO_APP_VERSION,
    ),
    sendDefaultPii: false,
    ...(tracesSampleRate !== undefined && { tracesSampleRate }),
  };
}

function firstPresent(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseSampleRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return undefined;
  }
  return parsed;
}
