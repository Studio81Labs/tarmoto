import * as Sentry from "@sentry/nextjs";

// Next.js loads this once per server runtime at startup. Pull in the matching
// Sentry init for the active runtime; both are no-ops without a DSN.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");

    // Auth.js derives every absolute auth URL (OAuth redirects, server-side
    // redirect targets) from AUTH_URL; this next-auth line ignores
    // x-forwarded-host, so without AUTH_URL the derived base is the
    // container's own listen address (https://0.0.0.0:3000) — verified on
    // the first Coolify staging deploy. Warn at boot, in the same log an
    // operator reads when auth misbehaves.
    if (process.env.NODE_ENV === "production" && !process.env.AUTH_URL) {
      console.warn(
        "[auth] AUTH_URL is not set — server-derived auth URLs will use the container's listen address. Set AUTH_URL to the public companion origin (runtime env).",
      );
    }
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Forwards App Router server errors (RSC, route handlers, server actions) to
// Sentry. No-op when Sentry is not initialized.
export const onRequestError = Sentry.captureRequestError;
