import { stat } from "node:fs/promises";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { DataSource, Repository } from "typeorm";
import {
  DEFAULT_REGIONS,
  POI_IMPORT_JOB,
  POI_IMPORT_QUEUE,
  type PoiImportRegionJobData,
  type RegionImportStatus,
  type RunSummary,
  type TriggerImportResponse,
} from "@tarmoto/ingest";
import { PoiImportRun } from "@tarmoto/poi-db";
import {
  POI_IMPORT_SOURCES,
  PoiImportService,
} from "../poi/poi-import.service.js";
import { isPoiConnectionError } from "../poi/poi-repo.js";

/**
 * The internal-API service (Phase 3): owns the whole POI-import admin data
 * plane — the coverage table (`listRegionStatus`), run history (`listRuns`),
 * and the manual enqueue (`triggerImport`). Relocated from the backend
 * `PoiImportAdminService`, but now sourcing enablement from the real
 * `POI_IMPORT_SOURCES` registry instead of the backend's SOURCE_STRATEGIES ×
 * DEFAULT_REGIONS shim. The upload path (and its lock) stays on the backend.
 */
@Injectable()
export class PoiInternalService {
  constructor(
    @InjectDataSource("poi") private readonly poi: DataSource,
    @InjectRepository(PoiImportRun, "poi")
    private readonly runs: Repository<PoiImportRun>,
    @InjectQueue(POI_IMPORT_QUEUE)
    private readonly queue: Queue<PoiImportRegionJobData>,
    @Inject(POI_IMPORT_SOURCES)
    private readonly importers: PoiImportService[],
  ) {}

  /** Deterministic BullMQ job id for a manual trigger — verbatim from the
   *  backend admin service (`:` stripped, it's BullMQ's key delimiter). */
  manualJobId(source: string, code: string): string {
    return `import-region:manual:${source}:${code}`.replace(/:/g, "_");
  }

  async listRegionStatus(): Promise<RegionImportStatus[]> {
    // ADAPTATION (a): the enablement view. Only ENABLED sources contribute
    // rows (a disabled source drops all 17 — "fewer rows when disabled"), each
    // × DEFAULT_REGIONS, with `configured` = that source's OWN regions list.
    const enabled = this.importers.filter((imp) => imp.enabled);
    const pairs = enabled.flatMap((importer) =>
      DEFAULT_REGIONS.map((region) => ({
        importer,
        code: region.code,
        configured: importer.regions.some((r) => r.code === region.code),
      })),
    );

    // Two bulk queries up front (verbatim from the backend) — one coverage
    // scan, one grouped count — keyed into Maps the per-pair loop reads.
    const [coverageRows, countRows] = await this.withPoiStore(() =>
      Promise.all([
        this.poi.query<{ code: string; imported_at: string | null }[]>(
          `SELECT code, imported_at FROM poi_import_regions`,
        ),
        this.poi.query<
          { source: string; import_region: string; n: number | string }[]
        >(
          `SELECT source, import_region, count(*)::int AS n
             FROM pois
             WHERE deactivated_at IS NULL AND import_region IS NOT NULL
             GROUP BY source, import_region`,
        ),
      ]),
    );
    const coverageByCode = new Map(
      coverageRows.map((r) => [r.code, r.imported_at]),
    );
    const countBySourceRegion = new Map(
      countRows.map((r) => [`${r.source}:${r.import_region}`, Number(r.n)]),
    );

    // One in-flight scan (verbatim) — active/waiting/delayed/prioritized,
    // keyed by payload (source, code).
    const inFlight = await this.queue.getJobs([
      "active",
      "waiting",
      "delayed",
      "prioritized",
    ]);
    const liveBySourceRegion = new Map<string, "running" | "queued">();
    for (const job of inFlight) {
      const data = job?.data as PoiImportRegionJobData | undefined;
      if (!data?.code) continue;
      const key = `${data.source ?? "osm"}:${data.code}`;
      const state = await job.getState();
      if (state === "active") {
        liveBySourceRegion.set(key, "running");
      } else if (
        (state === "waiting" ||
          state === "delayed" ||
          state === "prioritized") &&
        !liveBySourceRegion.has(key)
      ) {
        liveBySourceRegion.set(key, "queued");
      }
    }

    return Promise.all(
      pairs.map((p) =>
        this.statusFor(
          p.importer,
          p.code,
          p.configured,
          coverageByCode,
          countBySourceRegion,
          liveBySourceRegion,
        ),
      ),
    );
  }

  // Verbatim from the backend `withPoiStore` — cold-start / connection-drop →
  // 503; a real query error still propagates.
  private async withPoiStore<T>(op: () => Promise<T>): Promise<T> {
    if (this.poi.isInitialized === false) {
      throw new ServiceUnavailableException("POI store is unavailable");
    }
    try {
      return await op();
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      if (isPoiConnectionError(err)) {
        throw new ServiceUnavailableException("POI store is unavailable");
      }
      throw err;
    }
  }

  private async statusFor(
    importer: PoiImportService,
    code: string,
    configured: boolean,
    coverageByCode: Map<string, string | null>,
    countBySourceRegion: Map<string, number>,
    liveBySourceRegion: Map<string, "running" | "queued">,
  ): Promise<RegionImportStatus> {
    const source = importer.source;
    // OSM-only coverage (verbatim rationale).
    const coverageAt =
      source === "osm" ? (coverageByCode.get(code) ?? null) : null;
    const imported_at = coverageAt ? new Date(coverageAt).toISOString() : null;
    const poi_count = countBySourceRegion.get(`${source}:${code}`) ?? 0;

    // ADAPTATION (b): resolve the extract path from the importer's own
    // strategy. Only stat when this source has a dir AND owns this code —
    // `getExtractPath` throws for a code outside its `regions`. Same
    // ENOENT→null / non-regular→throw / other→throw rules as the backend.
    let extract: RegionImportStatus["extract"] = null;
    if (configured && importer.extractDirConfigured) {
      try {
        const path = importer.getExtractPath(code);
        const s = await stat(path);
        if (!s.isFile()) {
          throw new Error(`POI extract path is not a regular file: ${path}`);
        }
        extract = {
          present: true,
          size_bytes: s.size,
          modified_at: new Date(s.mtimeMs).toISOString(),
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    const runRow = await this.withPoiStore(() =>
      this.runs.findOne({
        where: { source, region_code: code },
        order: { started_at: "DESC", id: "DESC" },
      }),
    );

    const live_state: RegionImportStatus["live_state"] =
      liveBySourceRegion.get(`${source}:${code}`) ?? "idle";

    return {
      source,
      code,
      configured,
      imported_at,
      poi_count,
      extract,
      last_run: runRow ? this.toSummary(runRow) : null,
      live_state,
    };
  }

  // Verbatim from the backend `listRuns` (clamp to [1,200], default 50; whole
  // build+run behind withPoiStore).
  async listRuns(filter: {
    source?: string;
    code?: string;
    limit: number;
  }): Promise<RunSummary[]> {
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit) || 50), 200);
    const rows = await this.withPoiStore(() => {
      const qb = this.runs
        .createQueryBuilder("r")
        .orderBy("r.started_at", "DESC")
        .addOrderBy("r.id", "DESC")
        .limit(limit);
      if (filter.source) {
        qb.andWhere("r.source = :source", { source: filter.source });
      }
      if (filter.code) {
        qb.andWhere("r.region_code = :code", { code: filter.code });
      }
      return qb.getMany();
    });
    return rows.map((r) => this.toSummary(r));
  }

  // Verbatim from the backend `toSummary`.
  private toSummary(r: PoiImportRun): RunSummary {
    return {
      id: r.id,
      source: r.source,
      region_code: r.region_code,
      status: r.status,
      trigger: r.trigger,
      fetched: r.fetched,
      upserted: r.upserted,
      tombstoned: r.tombstoned,
      skip_reason: r.skip_reason,
      warning: r.warning,
      error: r.error,
      started_at: r.started_at.toISOString(),
      finished_at: r.finished_at ? r.finished_at.toISOString() : null,
    };
  }

  // Verbatim from the backend `importInFlight` (shared "in flight" definition).
  private async importInFlight(source: string, code: string): Promise<boolean> {
    const inFlight = await this.queue.getJobs([
      "active",
      "waiting",
      "delayed",
      "prioritized",
    ]);
    return inFlight.some(
      (j) => j?.data?.code === code && (j?.data?.source ?? "osm") === source,
    );
  }

  async triggerImport(
    source: string,
    code: string,
    trigger: "manual" | "cron" = "manual",
  ): Promise<TriggerImportResponse> {
    // Unknown source / region → 400 (verbatim intent of the backend
    // `importerFor`).
    const importer = this.importers.find((imp) => imp.source === source);
    if (!importer) {
      throw new BadRequestException(`unknown source: ${source}`);
    }
    if (!DEFAULT_REGIONS.some((r) => r.code === code)) {
      throw new BadRequestException(
        `unknown region ${code} for source ${source}`,
      );
    }
    // ADAPTATION (c): the enablement-400 — stricter than Phase 2's
    // accept-and-skip, and the point of the enablement view. (The worker's own
    // graceful skip stays as defence for a stale queued job.)
    if (!importer.enabled || !importer.regions.some((r) => r.code === code)) {
      throw new BadRequestException(
        `source ${source} is not enabled for region ${code}`,
      );
    }

    // The queue-in-flight 409 lives here now (relocated). The upload-lock 409
    // (`uploadInProgress`) stays on the backend and runs BEFORE this call.
    if (await this.importInFlight(source, code)) {
      throw new ConflictException(
        `import for ${source}/${code} already in flight`,
      );
    }

    const jobId = this.manualJobId(source, code);
    await this.queue.add(
      POI_IMPORT_JOB.REGION,
      { code, source, trigger },
      {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        // Immediate removal on terminal state so a re-import (fresh extract →
        // click Import) is never deduped against a retained terminal job with
        // this stable manual jobId — verbatim rationale from the backend.
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return { job_id: jobId };
  }
}
