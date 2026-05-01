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
// `next dev` is used as the web server because it's robust to incremental
// route changes during local development and avoids forcing a `next build`
// before each run. CI accepts the slower first-paint in exchange for the
// same simplicity.
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
      command: `pnpm next dev --port ${PORT}`,
      url: `${BASE_URL}/login`,
      reuseExistingServer: !isCI,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${MOCK_BACKEND_PORT}`,
        AUTH_SECRET: "playwright-test-secret-do-not-use-in-prod",
        AUTH_TRUST_HOST: "true",
        NEXTAUTH_URL: BASE_URL,
      },
    },
  ],
});
