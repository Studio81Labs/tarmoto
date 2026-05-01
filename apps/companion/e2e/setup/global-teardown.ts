// No-op teardown — the mock backend is killed when Playwright shuts
// down its `webServer` processes. Kept as a hook so future cleanup
// (e.g. snapshotting state for triage) has a home.
export default async function globalTeardown() {}
