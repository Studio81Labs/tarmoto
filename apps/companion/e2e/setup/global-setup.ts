import { request } from "@playwright/test";

const MOCK_BACKEND_PORT = Number(
  process.env.PLAYWRIGHT_MOCK_BACKEND_PORT ?? 4311,
);

// Wait for the mock backend to be reachable before any test starts. The
// `webServer` definition in playwright.config.ts already waits on the
// port, but we additionally hit a known endpoint to confirm the express
// app is wired up — a port that's listening but returns 502 would only
// surface as confusing test errors.
export default async function globalSetup() {
  const ctx = await request.newContext();
  const start = Date.now();
  const deadline = start + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await ctx.get(
        `http://127.0.0.1:${MOCK_BACKEND_PORT}/__test__/health`,
      );
      if (res.ok()) {
        await ctx.post(`http://127.0.0.1:${MOCK_BACKEND_PORT}/__test__/reset`);
        await ctx.dispose();
        return;
      }
      lastError = `status ${res.status()}`;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await ctx.dispose();
  throw new Error(`mock-backend never came up: ${String(lastError)}`);
}
