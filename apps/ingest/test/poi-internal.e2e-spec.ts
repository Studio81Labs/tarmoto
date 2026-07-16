import { Test, type TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { POI_IMPORT_QUEUE } from "@tarmoto/ingest";
import { AppModule } from "../src/app.module.js";
import { PoiInternalService } from "../src/internal/poi-internal.service.js";

/**
 * Real-PG + real-Redis proof of the internal API's two live seams: the manual
 * enqueue (`triggerImport`) and the coverage table (`listRegionStatus`).
 * Worker OFF (`TARMOTO_QUEUE_WORKER_ENABLED=false` from test/jest-e2e.setup.ts)
 * so the enqueued job SITS in the queue for the assertions. OSM is enabled via
 * env so CZ is a configured pair. Prerequisite: `pnpm db:up`.
 */
describe("apps/ingest POI internal API (real infra)", () => {
  let app: TestingModule;
  let svc: PoiInternalService;
  let queue: Queue;
  const dir = mkdtempSync(join(tmpdir(), "poi-internal-e2e-"));
  const JOB_ID = "import-region_manual_osm_CZ";

  beforeAll(async () => {
    // Config factories read env at ConfigModule init (during compile()), so
    // set these BEFORE compile. Enable OSM so CZ is enabled+configured.
    process.env.TARMOTO_POI_IMPORT_ENABLED = "true";
    process.env.TARMOTO_POI_IMPORT_DIR = dir;

    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    svc = app.get(PoiInternalService);
    queue = app.get<Queue>(getQueueToken(POI_IMPORT_QUEUE));
    // Clean any leftover from a previous aborted run.
    await queue.remove(JOB_ID).catch(() => undefined);
  }, 30_000);

  afterAll(async () => {
    await queue.remove(JOB_ID).catch(() => undefined);
    if (app) await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("triggerImport enqueues a manual osm/CZ job (worker off)", async () => {
    const res = await svc.triggerImport("osm", "CZ");
    expect(res.job_id).toBe(JOB_ID);
    const job = await queue.getJob(JOB_ID);
    expect(job).toBeTruthy();
  });

  it("listRegionStatus reports osm/CZ configured with live_state reflecting the queued job", async () => {
    const rows = await svc.listRegionStatus();
    const osmCz = rows.find((r) => r.source === "osm" && r.code === "CZ");
    expect(osmCz?.configured).toBe(true);
    expect(typeof osmCz?.poi_count).toBe("number");
    // The job enqueued above is waiting (worker off) → 'queued'.
    expect(osmCz?.live_state).toBe("queued");
  });
});
