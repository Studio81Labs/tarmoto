// Defensive mirror of `jest-e2e.setup.ts` for the UNIT jest project (see that
// file for the full `setupFiles`-timing rationale). The unit suite should
// never import `AppModule` or `PoiJobsModule` — the spec that used to do that
// (`app.module.spec.ts`) has moved to `test/app.e2e-spec.ts` specifically
// because a unit run has no business booting the real Postgres-backed
// `PoiDatabaseModule` migrator or a live BullMQ worker/scheduler against
// Redis. This is a belt-and-braces gate, not a currently-exercised path: if a
// future unit spec ever adds `imports: [AppModule]` (or otherwise pulls in
// `PoiJobsModule`), this ensures its worker/scheduler providers still don't
// get constructed, so the unit suite stays hermetic (no Postgres, no Redis)
// even if that mistake slips back in.
process.env.TARMOTO_QUEUE_WORKER_ENABLED = "false";
