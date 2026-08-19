import * as Sentry from "@sentry/nextjs";

// Next.js loads this once per server runtime at startup. Pull in the matching
// Sentry init for the active runtime; both are no-ops without a DSN.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Forwards App Router server errors (RSC, route handlers, server actions) to
// Sentry. No-op when Sentry is not initialized.
export const onRequestError = Sentry.captureRequestError;
