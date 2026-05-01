import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { FunZoneClusteringService } from '../../roads/fun-zone-clustering.service.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

export interface FunzoneRecomputeResult {
  zones_written: number;
  zones_pruned: number;
  members_written: number;
  duration_ms: number;
}

/**
 * Weekly recurring job (depends on US-6 — the fun-zone clustering
 * pipeline). Wraps the existing CLI clustering script as a queue
 * processor so the same pipeline runs on a schedule without a human
 * starting it. The CLI script
 * (`apps/backend/src/scripts/cluster-fun-zones.ts`) stays for ad-hoc
 * runs (bbox-scoped recomputes, parameter sweeps).
 */
@Processor(QUEUE_NAMES.FUNZONE_RECOMPUTE, {
  // Clustering is heavy on Postgres and there is exactly one set of
  // global zones, so exactly one worker should run this at a time.
  concurrency: 1,
})
export class FunzoneRecomputeProcessor extends WorkerHost {
  private readonly logger = new Logger(FunzoneRecomputeProcessor.name);

  constructor(private readonly clustering: FunZoneClusteringService) {
    super();
  }

  async process(job: Job): Promise<FunzoneRecomputeResult> {
    // Default options: full recluster, prune dropped zones. Ad-hoc
    // bbox / parameter overrides go through the CLI script.
    const result = await this.clustering.runClustering({});
    this.logger.log(
      `[${job.id ?? 'no-id'}] fun-zone recompute: ` +
        `${result.zones_written} written, ${result.zones_pruned} pruned, ` +
        `${result.members_written} members, ${result.duration_ms}ms`,
    );
    return result;
  }
}
