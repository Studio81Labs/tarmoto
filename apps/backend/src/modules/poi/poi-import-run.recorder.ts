import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PoiImportRun,
  type PoiImportTrigger,
} from '../../entities/poi-import-run.entity.js';
import type { PoiImportResult } from './poi-import.service.js';

const ERROR_MAX = 2000;

/** Lifecycle writer for `poi_import_runs` (#847). */
@Injectable()
export class PoiImportRunRecorder {
  constructor(
    @InjectRepository(PoiImportRun, 'poi')
    private readonly repo: Repository<PoiImportRun>,
  ) {}

  async start(input: {
    source: string;
    regionCode: string;
    trigger: PoiImportTrigger;
    jobId: string | null;
  }): Promise<string> {
    const row = await this.repo.save(
      this.repo.create({
        source: input.source,
        region_code: input.regionCode,
        status: 'running',
        trigger: input.trigger,
        job_id: input.jobId,
        started_at: new Date(),
      }),
    );
    return row.id;
  }

  async finish(id: string, result: PoiImportResult): Promise<void> {
    await this.repo.update(id, {
      status: result.skipped ? 'skipped' : 'success',
      fetched: result.fetched,
      upserted: result.upserted,
      tombstoned: result.tombstoned,
      // Carry the REAL, path-specific reason `PoiImportService` attached to
      // the result (#847 review) — e.g. "no extract file at <path>" vs.
      // "extract yielded 0 in-bbox rows" — rather than synthesizing one
      // generic message that couldn't tell those two operator-actionable
      // cases apart. The `??` fallback only fires if `skipped` is true but
      // `skipReason` is somehow null, which no current code path produces.
      skip_reason: result.skipped
        ? (result.skipReason ?? `import skipped (fetched=${result.fetched})`)
        : null,
      finished_at: new Date(),
    });
  }

  async fail(id: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.repo.update(id, {
      status: 'failed',
      error: message.slice(0, ERROR_MAX),
      finished_at: new Date(),
    });
  }
}
