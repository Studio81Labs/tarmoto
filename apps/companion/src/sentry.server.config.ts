import * as Sentry from "@sentry/nextjs";
import { bakedSentryEnv, createSentryOptions } from "@/lib/sentry-options";

// Node runtime Sentry init (App Router server components, route handlers,
// server actions). Uses the same build-baked NEXT_PUBLIC_* values as the
// browser (the standalone runtime stage carries no NEXT_PUBLIC_* OS env, so
// these must be inlined at build). No-op without a DSN.
const options = createSentryOptions(bakedSentryEnv());

if (options) {
  Sentry.init(options);
}
