import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4310);
const MOCK_BACKEND_PORT = Number(
  process.env.PLAYWRIGHT_MOCK_BACKEND_PORT ?? 4311,
);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

const isCI = !!process.env.CI;

// E2E tests run the companion against an in-process mock backend (see
// e2e/mock-backend/server.ts). Tests stay fast and deterministic — no
// postgres, no redis, no full backend boot. The backend's own e2e suite
// covers contract-level integration separately.
//
// Web server: locally `next dev` is used so route changes are picked up
// without a rebuild. On CI we build once and serve with `next start`
// instead — `next dev` compiles each route on first request (Turbopack
// JIT), and across 71 tests visiting many routes those cold compiles
// stacked up past the 20-minute job timeout. A production build pays the
// compile cost once, up front, so every navigation is served instantly.
export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: isCI
    ? [["github"], ["html", { open: "never", outputFolder: "e2e/.report" }]]
    : [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]],
  outputDir: "./e2e/.results",

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },

  globalSetup: "./e2e/setup/global-setup.ts",
  globalTeardown: "./e2e/setup/global-teardown.ts",

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: [
    {
      command: `node --import tsx ./e2e/mock-backend/start.ts`,
      port: MOCK_BACKEND_PORT,
      reuseExistingServer: !isCI,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 30_000,
      env: {
        MOCK_BACKEND_PORT: String(MOCK_BACKEND_PORT),
      },
    },
    {
      // CI: build once, then serve the production output (fast, no per-route
      // JIT compile). Local: `next dev` for instant route edits.
      // `NEXT_PUBLIC_API_URL` is inlined at build time, so it must be set for
      // the `next build` half of the CI command — not just `next start`.
      command: isCI
        ? `pnpm next build && pnpm next start --port ${PORT}`
        : `pnpm next dev --port ${PORT}`,
      url: `${BASE_URL}/login`,
      reuseExistingServer: !isCI,
      stdout: "ignore",
      stderr: "pipe",
      // CI bundles the build (~1–3 min) into this window; dev only waits for
      // first paint.
      timeout: isCI ? 300_000 : 180_000,
      env: {
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${MOCK_BACKEND_PORT}`,
        // Re-enable the page-level e2e hooks that are otherwise stripped from
        // production builds (see `__tarmotoSelectExploreSegment`). Inlined at
        // build time, so it must be present for the `next build` step.
        NEXT_PUBLIC_E2E: "1",
        AUTH_SECRET: "playwright-test-secret-do-not-use-in-prod",
        AUTH_TRUST_HOST: "true",
        NEXTAUTH_URL: BASE_URL,
      },
    },
  ],
});
