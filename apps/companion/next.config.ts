import path from "node:path";
import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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

// Wires Cloudflare bindings into `next dev` so getCloudflareContext() works
// locally. No-op outside `next dev`.
initOpenNextCloudflareForDev();

export default nextConfig;
