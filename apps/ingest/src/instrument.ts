// Sentry instrumentation. Imported first in main.ts so @sentry/nestjs can hook
// the runtime before the instrumented libraries load. Inert until
// TARMOTO_SENTRY_DSN is set — createSentryOptions() returns null with no DSN
// and Sentry.init is skipped.
import "dotenv/config";
import * as Sentry from "@sentry/nestjs";
import { createSentryOptions } from "./config/sentry.config.js";

const sentryOptions = createSentryOptions();

if (sentryOptions) {
  Sentry.init(sentryOptions);
}
