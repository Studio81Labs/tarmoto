import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ModelEvalService } from '../../model-eval/model-eval.service.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

export interface ModelEvalReconcileResult {
  reconciled: number;
  dangerous: number;
}

/**
 * Hourly recurring job (issue #496). Walks unreconciled
 * `model_eval_samples` rows whose road segment has hit the spec-§8.3
 * confirmation level and folds the aggregate truth into each one.
 * Logs the dangerous-misclass alert when the rolling 24h rate
 * crosses the threshold — the alert is raised inside
 * `ModelEvalService.reconcilePending` so a fresh reconciliation that
 * tips the rate over the line is captured the moment it happens, not
 * on the next dashboard scrape.
 */
@Processor(QUEUE_NAMES.MODEL_EVAL_RECONCILE, {
  // The reconciliation is a single SQL walk — exactly one worker
  // should run it at a time so the partial index isn't being
  // re-walked concurrently and we don't double-update the same row.
  concurrency: 1,
})
export class ModelEvalReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(ModelEvalReconcileProcessor.name);

  constructor(private readonly evalService: ModelEvalService) {
    super();
  }

  async process(job: Job): Promise<ModelEvalReconcileResult> {
    const result = await this.evalService.reconcilePending();
    this.logger.log(
      `[${job.id ?? 'no-id'}] model-eval reconcile: ` +
        `${result.reconciled} reconciled, ${result.dangerous} dangerous`,
    );
    return result;
  }
}
