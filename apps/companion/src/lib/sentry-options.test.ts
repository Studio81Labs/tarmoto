import { describe, expect, it } from "vitest";
import { createSentryOptions, sentryIngestOrigin } from "./sentry-options";

describe("createSentryOptions", () => {
  it("stays disabled when no DSN is configured", () => {
    expect(createSentryOptions({ NODE_ENV: "production" })).toBeNull();
  });

  it("builds privacy-safe options from NEXT_PUBLIC_ env vars", () => {
    const options = createSentryOptions({
      NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      NEXT_PUBLIC_SENTRY_ENVIRONMENT: "staging",
      NEXT_PUBLIC_SENTRY_RELEASE: "tarmoto-companion@1.2.3",
      NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: "0.25",
      NODE_ENV: "production",
    });

    expect(options).toMatchObject({
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "staging",
      release: "tarmoto-companion@1.2.3",
      sendDefaultPii: false,
      tracesSampleRate: 0.25,
    });
  });

  it("falls back to the app version for the release and NODE_ENV for environment", () => {
    const options = createSentryOptions({
      NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/2",
      NEXT_PUBLIC_APP_VERSION: "0.0.0",
      NODE_ENV: "production",
    });

    expect(options).toMatchObject({
      dsn: "https://public@example.ingest.sentry.io/2",
      environment: "production",
      release: "0.0.0",
    });
  });

  it("ignores invalid trace sample rates instead of breaking init", () => {
    const options = createSentryOptions({
      NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: "2",
    });

    expect(options?.tracesSampleRate).toBeUndefined();
  });
});

describe("sentryIngestOrigin", () => {
  it("returns null when no DSN is set", () => {
    expect(sentryIngestOrigin(undefined)).toBeNull();
    expect(sentryIngestOrigin("   ")).toBeNull();
  });

  it("returns null for an unparseable DSN", () => {
    expect(sentryIngestOrigin("not-a-url")).toBeNull();
  });

  it("extracts the ingest origin from the DSN", () => {
    expect(sentryIngestOrigin("https://public@o123.ingest.sentry.io/456")).toBe(
      "https://o123.ingest.sentry.io",
    );
  });
});
