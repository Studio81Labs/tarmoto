import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ModelEvalService } from '../../model-eval/model-eval.service.js';
import { formatScore } from '../../model-eval/model-eval.constants.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

export interface ModelEvalAgreementResult {
  cross_device_score: number | null;
  cross_device_segments: number;
  cross_bike_score: number | null;
  cross_bike_segments: number;
}

/**
 * Weekly recurring job (issue #496). Recomputes the cross-device
 * and cross-bike agreement scores from the last 7 days of reconciled
 * samples and caches the result on `ModelEvalService` so the
 * `/model-eval/metrics` endpoint can read it without doing a 7-day
 * scan on every request. Spec §7.2 — `>0.80` cross-device, `>0.75`
 * cross-bike.
 */
@Processor(QUEUE_NAMES.MODEL_EVAL_AGREEMENT, {
  // Single-worker — the calculation is global state cached on the
  // singleton service.
  concurrency: 1,
})
export class ModelEvalAgreementProcessor extends WorkerHost {
  private readonly logger = new Logger(ModelEvalAgreementProcessor.name);

  constructor(private readonly evalService: ModelEvalService) {
    super();
  }

  async process(job: Job): Promise<ModelEvalAgreementResult> {
    const result = await this.evalService.recomputeAgreements();
    this.logger.log(
      `[${job.id ?? 'no-id'}] model-eval agreement: ` +
        `device=${formatScore(result.cross_device.agreement_score)} (${result.cross_device.segments_evaluated} segs), ` +
        `bike=${formatScore(result.cross_bike.agreement_score)} (${result.cross_bike.segments_evaluated} segs)`,
    );
    return {
      cross_device_score: result.cross_device.agreement_score,
      cross_device_segments: result.cross_device.segments_evaluated,
      cross_bike_score: result.cross_bike.agreement_score,
      cross_bike_segments: result.cross_bike.segments_evaluated,
    };
  }
}
