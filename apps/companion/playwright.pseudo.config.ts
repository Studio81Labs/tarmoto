import { defineConfig, devices } from "@playwright/test";

// Pseudo-translation smoke suite (#1047) — e2e/pseudo/pseudo-i18n.spec.ts.
//
// Why a separate config instead of a project in playwright.config.ts:
// - The pseudo catalog swap (src/i18n/pseudo.ts) is gated behind
//   NODE_ENV !== "production", which `next build` inlines to false — so this
//   suite must run against `next dev`, on CI too, while the main suite runs
//   a production build there. `webServer` is config-scoped, not
//   project-scoped, so a different server means a different config.
// - The pseudo-wrapped copy would break every main-suite locator that
//   anchors on cataloged English text; isolating the run keeps the two
//   worlds from ever sharing a server.
//
// Dev-mode JIT compiles are fine here: the suite visits a handful of routes
// once (the main suite moved to a production build because 71 tests × cold
// per-route compiles blew the CI timeout — that math does not apply to this
// curated set).

// The shared global-setup and fixtures read this to reach the mock backend.
// Distinct ports from playwright.config.ts (4310/4311) so a pseudo run can
// never `reuseExistingServer` a non-pseudo server, or vice versa.
process.env.PLAYWRIGHT_MOCK_BACKEND_PORT ??= "4316";

const PORT = Number(process.env.PLAYWRIGHT_PSEUDO_PORT ?? 4315);
const MOCK_BACKEND_PORT = Number(process.env.PLAYWRIGHT_MOCK_BACKEND_PORT);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e/pseudo",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  // Generous budgets: `next dev` pays a cold Turbopack compile on the first
  // hit of each route (the planner is the heavyweight), which the main
  // config's production-build numbers never see.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: isCI
    ? [
        ["github"],
        ["html", { open: "never", outputFolder: "e2e/.report-pseudo" }],
      ]
    : [
        ["list"],
        ["html", { open: "never", outputFolder: "e2e/.report-pseudo" }],
      ],
  outputDir: "./e2e/.results-pseudo",

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
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
      // Always `next dev` — see the header comment. TARMOTO_I18N_PSEUDO is
      // read at compile time (next.config.ts bridges it into the client
      // bundle), so it must be present on the dev server's environment.
      command: `pnpm next dev --port ${PORT}`,
      url: `${BASE_URL}/login`,
      reuseExistingServer: !isCI,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${MOCK_BACKEND_PORT}`,
        TARMOTO_I18N_PSEUDO: "1",
        AUTH_SECRET: "playwright-test-secret-do-not-use-in-prod",
        AUTH_TRUST_HOST: "true",
        NEXTAUTH_URL: BASE_URL,
      },
    },
  ],
});
