import * as Sentry from "@sentry/nextjs";
import { bakedSentryEnv, createSentryOptions } from "@/lib/sentry-options";

// Edge runtime Sentry init (middleware and any edge route handlers). Uses the
// same build-baked NEXT_PUBLIC_* values as the browser. No-op without a DSN.
const options = createSentryOptions(bakedSentryEnv());

if (options) {
  Sentry.init(options);
}
