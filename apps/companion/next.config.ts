import path from "node:path";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Dev-gated pseudo-translation flag (#1047): the catalog swap in
  // src/i18n/locales reads this on the server AND in client components, but
  // Next only exposes NEXT_PUBLIC_* to client bundles on its own. Bridging
  // the TARMOTO-prefixed flag here inlines one consistent value into both
  // bundles at compile time, so server-rendered HTML and client hydration
  // agree on the (pseudo-)catalog. Inert in production builds: the swap sits
  // behind NODE_ENV !== "production", which `next build` inlines to false.
  env: {
    TARMOTO_I18N_PSEUDO: process.env.TARMOTO_I18N_PSEUDO ?? "",
  },
  // Quarantine pseudo-mode dev output away from `.next`. The pseudo e2e
  // suite SIGKILLs its dev server after every run, and a mid-write kill has
  // been observed leaving a corrupt `.next/dev/types/validator.ts` behind —
  // which `tsc --noEmit` reads (tsconfig includes `.next/dev/types`), so the
  // next `pnpm typecheck` fails on an artifact no source change explains.
  // `.next-pseudo` is a dot-directory outside every tsconfig include glob,
  // and the isolation also keeps pseudo runs from clobbering a build or a
  // running `next dev`'s state in `.next`. Same gate as the catalog swap.
  ...(process.env.NODE_ENV !== "production" &&
  process.env.TARMOTO_I18N_PSEUDO === "1"
    ? { distDir: ".next-pseudo" }
    : {}),
  // Self-contained server bundle for the Coolify container — the runtime
  // image copies .next/standalone + .next/static + public and runs
  // `node apps/companion/server.js` (see apps/companion/Dockerfile).
  output: "standalone",
  // The monorepo root, so standalone tracing walks the pnpm workspace
  // correctly instead of stopping at the app directory.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  // Load-bearing workaround, inherited from tabletap's PWA on the same Next
  // line: without it the standalone container dies on boot with
  // `Cannot find module .../@swc/helpers/esm/_interop_require_default.js` —
  // the tracer misses the ESM half of @swc/helpers under pnpm. The relative
  // `../../` form is required; a root-relative pattern silently includes
  // nothing.
  outputFileTracingIncludes: {
    "/**": [
      "../../node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/esm/**",
    ],
  },
  // /discover was retired; its Fun Zones capability lives in the Road
  // Explorer now. Permanent redirect so indexed links keep working.
  async redirects() {
    return [
      {
        source: "/discover",
        destination: "/explore",
        permanent: true,
      },
      // The embed widgets were retired with the dark theme; any iframe
      // still out in the wild degrades into the full public page.
      {
        source: "/embed/rides/:token",
        destination: "/rides/shared/:token",
        permanent: true,
      },
      {
        source: "/embed/roads/:path*",
        destination: "/roads/best/:path*",
        permanent: true,
      },
    ];
  },
  // Static security headers on every response, asset requests included —
  // the per-request nonce CSP lives in src/middleware.ts (it cannot be
  // static). HSTS is safe unconditionally: staging and production are
  // HTTPS-only, and localhost is exempt from HSTS by spec.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
  transpilePackages: ["@tarmoto/shared", "@tarmoto/openapi-client"],
  // Allow loopback hosts for local development and Playwright E2E. Next 16
  // tightens cross-origin asset requests in dev mode and blocks anything
  // not on this list, which breaks tests served via 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Pin Turbopack's project root to the workspace root. Without this Next
  // walks up looking for the closest lockfile and can land on the wrong
  // directory in the pnpm monorepo, which produced the
  // "We couldn't find the next/package.json" failure under the old
  // next-on-pages build.
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
};

// withSentryConfig wraps the build for source-map handling and release
// tagging. It is inert at runtime when Sentry is disabled; source-map upload
// only runs when SENTRY_AUTH_TOKEN (+ org/project) are present at build time,
// so local/CI builds without them just skip upload. Keep it the outermost
// wrapper so it sees the fully-composed config.
export default withSentryConfig(nextConfig, {
  ...(process.env.SENTRY_ORG && { org: process.env.SENTRY_ORG }),
  ...(process.env.SENTRY_PROJECT && { project: process.env.SENTRY_PROJECT }),
  // Upload source maps under the SAME release the SDK tags events with
  // (NEXT_PUBLIC_SENTRY_RELEASE, baked at build). If these differ, Sentry
  // can't match maps to events and stack traces stay minified.
  ...(process.env.NEXT_PUBLIC_SENTRY_RELEASE && {
    release: { name: process.env.NEXT_PUBLIC_SENTRY_RELEASE },
  }),
  // Log the source-map upload whenever a token is present (i.e. real Coolify
  // builds) so the build output shows what was uploaded / why it was skipped;
  // stay quiet on local builds with no token. Tree-shake Sentry's debug
  // logging out of the production bundle.
  silent: !process.env.SENTRY_AUTH_TOKEN,
  webpack: { treeshake: { removeDebugLogging: true } },
});
