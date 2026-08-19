import * as Sentry from "@sentry/nextjs";
import { bakedSentryEnv, createSentryOptions } from "@/lib/sentry-options";

// Browser-side Sentry init from the build-baked NEXT_PUBLIC_* values
// (bakedSentryEnv reads them as literals so Next inlines them). No-op when no
// DSN was baked in.
const options = createSentryOptions(bakedSentryEnv());

if (options) {
  Sentry.init(options);
}

// Lets Sentry tie client-side navigations into traces (App Router).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
