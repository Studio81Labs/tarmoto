import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module.js";
import { HealthController } from "../src/health.controller.js";

/**
 * Moved out of the unit suite into e2e (Task 5a review): `AppModule` now
 * imports `PoiDatabaseModule` (a fail-fast migrator — `compile()` alone
 * triggers its `dataSourceFactory`, which opens a real Postgres connection
 * and runs the POI migrations) and `PoiJobsModule` (BullMQ against Redis), so
 * compiling the real `AppModule` needs the same infra as
 * `poi-import.e2e-spec.ts` — `pnpm db:up`. `TARMOTO_QUEUE_WORKER_ENABLED=false`
 * comes from `test/jest-e2e.setup.ts` (a Jest `setupFiles` entry), not this
 * file — see that file for why it has to run there instead of a `beforeAll`.
 */
describe("apps/ingest AppModule", () => {
  it("compiles and exposes the health probe", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const health = moduleRef.get(HealthController);
    expect(health.getHealth()).toEqual({ status: "ok" });
    await moduleRef.close();
  }, 30_000);
});
