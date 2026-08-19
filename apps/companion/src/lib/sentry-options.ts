// Sentry init options for the companion, shaped after tabletap's PWA
// (apps/pwa/lib/sentry-options.ts). Lives outside the init entry points so
// the option-building rules — DSN gating, fallback order, PII stance — are
// unit-testable without importing the SDK.

type Env = Record<string, string | undefined>;

// The subset of Sentry init options we set. Assignable to both the browser
// (`BrowserOptions`) and Node/edge (`NodeOptions`) init signatures, so the
// same builder feeds the client, server, and edge entry points.
export interface TarmotoSentryOptions {
  dsn: string;
  environment: string | undefined;
  release: string | undefined;
  sendDefaultPii: boolean;
  tracesSampleRate?: number;
}

// Build Sentry init options from the environment, or return null when no DSN
// is configured so the SDK stays fully disabled (the default locally and in
// CI). The client DSN must be the NEXT_PUBLIC_ one — it is inlined into the
// browser bundle at build time; the server/edge runtimes also see it via
// process.env, with SENTRY_DSN as a server-only fallback.
//
// NOTE: callers running in the browser must pass an env object whose values
// are read as literal `process.env.NEXT_PUBLIC_*` member expressions so Next
// can statically inline them — see instrumentation-client.ts.
export function createSentryOptions(
  env: Env = process.env,
): TarmotoSentryOptions | null {
  const dsn = firstPresent(env.NEXT_PUBLIC_SENTRY_DSN, env.SENTRY_DSN);
  if (!dsn) return null;

  const tracesSampleRate = parseSampleRate(
    firstPresent(
      env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
      env.SENTRY_TRACES_SAMPLE_RATE,
    ),
  );

  return {
    dsn,
    environment: firstPresent(
      env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
      env.SENTRY_ENVIRONMENT,
      env.NODE_ENV,
    ),
    // Fall back to the build identifier already baked into the bundle so
    // releases still line up with the deployed version when the release
    // env var is absent.
    release: firstPresent(
      env.NEXT_PUBLIC_SENTRY_RELEASE,
      env.SENTRY_RELEASE,
      env.NEXT_PUBLIC_APP_VERSION,
    ),
    // Rides, trips, and locations are personal data — never let the SDK
    // attach request bodies, cookies, or IPs by default. Errors carry
    // stack + tags only.
    sendDefaultPii: false,
    ...(tracesSampleRate !== undefined && { tracesSampleRate }),
  };
}

// Snapshot of the NEXT_PUBLIC_* Sentry env, read as literal
// `process.env.NEXT_PUBLIC_*` member expressions so Next inlines the
// build-time values into every bundle (browser, server, and edge). Runtime
// container env does NOT reach these — the companion bakes its config at
// build time, like NEXT_PUBLIC_API_URL. Used by all three Sentry init entry
// points so they share one source of truth.
export function bakedSentryEnv(): Env {
  return {
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE:
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
    NEXT_PUBLIC_SENTRY_RELEASE: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
    NODE_ENV: process.env.NODE_ENV,
  };
}

// Origin the browser SDK POSTs events to (the DSN host), or null when Sentry
// is disabled. security-headers.ts adds this to the CSP connect-src so the
// transport is not blocked. Reads NEXT_PUBLIC_SENTRY_DSN directly so Next
// inlines it into the (edge) middleware bundle.
export function sentryIngestOrigin(
  dsn: string | undefined = process.env.NEXT_PUBLIC_SENTRY_DSN,
): string | null {
  const trimmed = dsn?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
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
