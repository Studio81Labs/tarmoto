// Jest `setupFiles` run before the test framework is installed AND before the
// test file's own module graph is required — this is the only hook point
// that runs early enough to matter here. `PoiJobsModule`'s worker/scheduler
// gate (`apps/ingest/src/poi/jobs.module.ts`) is a plain top-level `const`
// read once at module-require time (Nest providers can't be conditionally
// included from an async factory, so it can't be deferred into a
// `ConfigService`-backed lazy read like `TARMOTO_POI_IMPORT_DIR` can).
// Setting this inside a test file's `beforeAll` would be too late: by then
// the spec's own static `import { AppModule }` has already pulled in
// `jobs.module.ts` and evaluated the gate with whatever the env var was at
// process start (unset). Setting it here, before that import ever runs,
// keeps the BullMQ worker + scheduler out of the compiled module graph, so
// this e2e never depends on Redis being reachable.
process.env.TARMOTO_QUEUE_WORKER_ENABLED = "false";

// The bare code default in `jobs.module.ts` is now 6379 (the deployment
// value, matching the backend producer) — NOT where the local docker-compose
// Redis listens (6380; see `infra/docker/docker-compose.yml`). Pin the test
// Redis port explicitly rather than relying on that default, but still
// respect an explicitly-set env (e.g. CI pointing at a different Redis).
process.env.TARMOTO_REDIS_PORT ??= "6380";
