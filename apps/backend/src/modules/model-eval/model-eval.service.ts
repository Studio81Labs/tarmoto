import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ModelEvalSample } from '../../entities/model-eval-sample.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import {
  AGREEMENT_SNAPSHOT_TTL_MS,
  CROSS_AGREEMENT_MIN_DISTINCT,
  DANGEROUS_MISCLASS_ALERT_RATE,
  DEFAULT_SAMPLE_RATE,
  RECONCILE_MIN_CONFIDENCE,
  RECONCILE_MIN_READINGS,
  RECONCILE_MIN_UNIQUE_RIDERS,
  ROLLING_WINDOW_HOURS,
  SPEC_TARGETS,
  classificationToScore,
  deviceFamily,
  formatScore,
} from './model-eval.constants.js';
import {
  ModelEvalAgreementSnapshotDto,
  ModelEvalMetricsResponseDto,
  ModelEvalVersionMetricsDto,
} from './dto/model-eval-metrics.dto.js';

export interface ReconcileResult {
  reconciled: number;
  dangerous: number;
}

export interface SamplePayload {
  surface_reading_id: string;
  road_segment_id: string;
  ride_id: string | null;
  user_id: string | null;
  /**
   * Identifier of the **producer** of `predicted_classification`.
   * Callers MUST pass the version of whatever actually produced the
   * label being graded:
   *
   *   - `SERVER_HEURISTIC_MODEL_VERSION` when the label came from
   *     the server-side RMS heuristic (spec §8.2 v1 fallback);
   *   - the client's `MODEL_VERSION` when (and only when) the
   *     upload contract carries a per-segment client prediction.
   *
   * The upload's `client_model_version` is a separate signal — it
   * tells us which classifier the client *had loaded*, not which
   * one produced the per-segment prediction we store. Conflating
   * the two would let a bad client model appear healthy because
   * the heuristic's metrics get tagged with the client version.
   */
  model_version: string | null;
  device_model: string | null;
  predicted_classification: string;
}

/**
 * Random source seam for tests. Default `Math.random` is replaced
 * with a deterministic generator in unit tests so the sampling path
 * is exercised without flakiness on a 1% roll.
 */
export const MODEL_EVAL_RANDOM_TOKEN = 'MODEL_EVAL_RANDOM';
export type RandomFn = () => number;

@Injectable()
export class ModelEvalService {
  private readonly logger = new Logger(ModelEvalService.name);
  private readonly sampleRate: number;
  private lastDeviceAgreement: ModelEvalAgreementSnapshotDto = {
    computed_at: null,
    agreement_score: null,
    segments_evaluated: 0,
  };
  private lastBikeAgreement: ModelEvalAgreementSnapshotDto = {
    computed_at: null,
    agreement_score: null,
    segments_evaluated: 0,
  };

  constructor(
    @InjectRepository(ModelEvalSample)
    private readonly samples: Repository<ModelEvalSample>,
    @InjectRepository(Ride)
    private readonly rides: Repository<Ride>,
    private readonly config: ConfigService,
    @Optional()
    @Inject(MODEL_EVAL_RANDOM_TOKEN)
    private readonly random: RandomFn = Math.random,
  ) {
    this.sampleRate = this.parseSampleRate();
  }

  /**
   * Roll the sampling die once per `surface_readings` row. Returns
   * `null` when the row is not selected — most rows take this fast
   * path.
   *
   * Sampling is biased away from rows whose `predicted_classification`
   * is unmappable to a 1-5 score (e.g. an unknown label from a future
   * client) so the metrics denominator stays clean. Failure to derive
   * a score short-circuits silently — the caller doesn't know whether
   * a row was rolled-out by the rate or rejected by the score check,
   * and either way the audit log carries the upload's existing
   * telemetry columns.
   */
  async maybeSample(payload: SamplePayload): Promise<ModelEvalSample | null> {
    if (this.sampleRate <= 0) return null;
    const score = classificationToScore(payload.predicted_classification);
    if (score === null) return null;
    if (this.random() >= this.sampleRate) return null;

    const bikeId = await this.lookupBikeId(payload.ride_id);
    const sample = this.samples.create({
      surface_reading_id: payload.surface_reading_id,
      road_segment_id: payload.road_segment_id,
      ride_id: payload.ride_id,
      user_id: payload.user_id,
      bike_id: bikeId,
      model_version: payload.model_version,
      device_model: payload.device_model,
      predicted_classification: payload.predicted_classification,
      predicted_score: score,
    });
    return this.samples.save(sample);
  }

  /**
   * Walk the unreconciled samples whose road segment has accumulated
   * enough INDEPENDENT confirmations (per spec §8.3 step 3) and fold
   * the aggregate truth into each sample row. Returns the count of
   * rows reconciled and the count flagged dangerous so the caller
   * can log a single-line summary.
   *
   * The aggregate is computed **leave-one-out**: it excludes the
   * sample's own `surface_reading` row AND every other reading from
   * the same `user_id`. Without that exclusion the prediction being
   * graded would vote for its own truth label — a segment dominated
   * by the same rider's optimistic classifications could reconcile
   * as Good and avoid the dangerous-misclass counter instead of
   * being compared with independent confirmations. The recency
   * weights and confidence ladder are the same ones the
   * `update_road_quality()` trigger applies (migration #1714700000000),
   * so the LOO truth is still spec-aligned.
   *
   * The dangerous-misclass alert fires here rather than in the
   * metrics endpoint because the endpoint is read-only and a polling
   * dashboard scraping it on a tight cadence would otherwise miss
   * the moment the rate crossed the threshold (the alert is a
   * point-in-time event, the gauge is a snapshot).
   */
  async reconcilePending(limit = 1000): Promise<ReconcileResult> {
    const rawRows: unknown = await this.samples.query(
      `WITH candidates AS (
         SELECT
           mes.id            AS sample_id,
           mes.surface_reading_id,
           mes.road_segment_id,
           mes.predicted_score,
           mes.model_version,
           mes.created_at    AS sample_created_at,
           sr_self.user_id   AS sample_user_id
         FROM model_eval_samples mes
         JOIN surface_readings sr_self ON sr_self.id = mes.surface_reading_id
         JOIN road_segments rs ON rs.id = mes.road_segment_id
         WHERE mes.reconciled_at IS NULL
           -- Cheap gross-threshold pre-filter. The gross aggregate
           -- on road_segments is a strict over-approximation of the
           -- leave-one-out aggregate (LOO drops readings; LOO count
           -- is at most gross count), so failing this gate
           -- guarantees failing LOO and we can skip the expensive
           -- subquery for those rows. NOTE: NO LIMIT here on
           -- purpose -- the LIMIT is applied after the LOO
           -- predicate below so a backlog of same-rider-repeat
           -- candidates cant starve newer reconcilable samples.
           AND rs.reading_count >= $2
           AND rs.confidence    >= $1
       ),
       loo_scored AS (
         -- Per-candidate, leave-one-out: every other reading on the
         -- segment that is NOT the sample row and NOT from the same
         -- user, scored to a 1-5 quality value.
         SELECT
           c.sample_id,
           c.road_segment_id,
           other.user_id,
           other.recorded_at,
           CASE other.classification
             WHEN 'excellent' THEN 5.0
             WHEN 'good'      THEN 4.0
             WHEN 'fair'      THEN 3.0
             WHEN 'poor'      THEN 2.0
             WHEN 'very_poor' THEN 1.0
             ELSE NULL
           END AS quality_score
         FROM candidates c
         JOIN surface_readings other
           ON  other.road_segment_id = c.road_segment_id
           AND other.id != c.surface_reading_id
           -- Require BOTH sides to have a known user_id and require
           -- they differ. Anonymized rows (user_id IS NULL after
           -- AccountDeletionService.purgeUser flips the FK to NULL
           -- via ON DELETE SET NULL) must NOT count as independent
           -- confirmations: a deleted rider's many anonymized
           -- readings would otherwise satisfy the >=5 LOO threshold
           -- and grade the sample against that rider's own history.
           -- Spec section 8.3 step 3 requires independent
           -- confirmations and we can't assert that without a
           -- non-null user_id on both sides.
           AND c.sample_user_id IS NOT NULL
           AND other.user_id IS NOT NULL
           AND other.user_id != c.sample_user_id
           AND other.classification IN
             ('excellent','good','fair','poor','very_poor')
       ),
       loo_stats AS (
         -- Mirror the production outlier filter from migration
         -- #1717300000000 (OutlierFilteredRoadQualityAggregation):
         -- compute mean + sample stddev per candidate over the LOO
         -- set so we can drop >2σ readings before averaging.
         -- Without this the model-eval LOO truth would diverge from
         -- the road_segments.quality_score the map and spec aggregate
         -- show, and a few spike readings could create false
         -- dangerous misses or hide real ones.
         SELECT
           sample_id,
           COUNT(*)::int            AS total_count,
           AVG(quality_score)       AS mean_q,
           stddev_samp(quality_score) AS std_q
         FROM loo_scored
         GROUP BY sample_id
       ),
       loo_kept AS (
         -- Keep readings the production filter would keep:
         --   - <3 readings: no meaningful stddev, keep all (mirrors
         --     spec §8.3 step 1 "skip filter when undefined");
         --   - all readings identical (std_q = 0 or NULL): no spread,
         --     nothing is an outlier;
         --   - otherwise drop |score - mean| > 2 * std_q.
         SELECT
           ls.sample_id,
           ls.user_id,
           ls.recorded_at,
           ls.quality_score
         FROM loo_scored ls
         JOIN loo_stats st ON st.sample_id = ls.sample_id
         WHERE
           st.total_count < 3
           OR st.std_q IS NULL
           OR st.std_q = 0
           OR ABS(ls.quality_score - st.mean_q) <= 2 * st.std_q
       ),
       loo AS (
         SELECT
           sample_id,
           SUM(
             quality_score *
             CASE
               WHEN recorded_at >= NOW() - INTERVAL '30 days'  THEN 1.0
               WHEN recorded_at >= NOW() - INTERVAL '90 days'  THEN 0.7
               WHEN recorded_at >= NOW() - INTERVAL '180 days' THEN 0.4
               ELSE 0.2
             END
           ) / NULLIF(SUM(
             CASE
               WHEN recorded_at >= NOW() - INTERVAL '30 days'  THEN 1.0
               WHEN recorded_at >= NOW() - INTERVAL '90 days'  THEN 0.7
               WHEN recorded_at >= NOW() - INTERVAL '180 days' THEN 0.4
               ELSE 0.2
             END
           ), 0)                       AS loo_quality_score,
           COUNT(*)::int               AS loo_reading_count,
           COUNT(DISTINCT user_id)::int AS loo_unique_rider_count
         FROM loo_kept
         GROUP BY sample_id
       )
       SELECT
         c.sample_id        AS id,
         c.predicted_score,
         c.model_version,
         loo.loo_quality_score AS quality_score,
         loo.loo_reading_count AS reading_count,
         CASE
           WHEN loo.loo_reading_count >= 20
                AND loo.loo_unique_rider_count >= 5 THEN 100
           WHEN loo.loo_reading_count >= 10 THEN 90
           WHEN loo.loo_reading_count >= 5  THEN 70
           WHEN loo.loo_reading_count >= 3  THEN 50
           WHEN loo.loo_reading_count >= 1  THEN 20
           ELSE 0
         END                AS confidence
       FROM candidates c
       JOIN loo ON loo.sample_id = c.sample_id
       WHERE loo.loo_reading_count >= $2
         AND loo.loo_quality_score IS NOT NULL
         -- Spec section 8.3 step 3 frames the aggregate as
         -- "readings from different riders". Require at least N
         -- distinct OTHER riders so one rider's repeated passes
         -- cannot grade another rider's prediction (codex review).
         AND loo.loo_unique_rider_count >= $4
         AND CASE
               WHEN loo.loo_reading_count >= 20
                    AND loo.loo_unique_rider_count >= 5 THEN 100
               WHEN loo.loo_reading_count >= 10 THEN 90
               WHEN loo.loo_reading_count >= 5  THEN 70
               WHEN loo.loo_reading_count >= 3  THEN 50
               WHEN loo.loo_reading_count >= 1  THEN 20
               ELSE 0
             END >= $1
       -- LIMIT is applied AFTER the LOO eligibility predicate so a
       -- backlog of same-rider-repeat candidates (gross-threshold
       -- met but LOO drops every other reading) can't starve newer
       -- independently-reconcilable samples. We pick the oldest
       -- LOO-eligible rows so reconciliation is FIFO across the
       -- actually-reconcilable set.
       ORDER BY c.sample_created_at ASC
       LIMIT $3`,
      [
        RECONCILE_MIN_CONFIDENCE,
        RECONCILE_MIN_READINGS,
        limit,
        RECONCILE_MIN_UNIQUE_RIDERS,
      ],
    );
    const rows = rawRows as Array<{
      id: string;
      predicted_score: number;
      model_version: string | null;
      quality_score: number;
      reading_count: number;
      confidence: number;
    }>;

    let dangerous = 0;
    for (const row of rows) {
      const aggregateScore = Number(row.quality_score);
      const aggregateClass = scoreToClassification(aggregateScore);
      const isDangerous =
        row.predicted_score >= 4 && Math.round(aggregateScore) <= 2;
      if (isDangerous) dangerous += 1;

      await this.samples.update(
        { id: row.id },
        {
          aggregate_score: aggregateScore,
          aggregate_classification: aggregateClass,
          aggregate_confidence: row.confidence,
          aggregate_reading_count: row.reading_count,
          dangerous_misclassification: isDangerous,
          reconciled_at: new Date(),
        },
      );
    }

    if (rows.length > 0) {
      this.logger.log(
        `reconciled ${rows.length} model-eval samples (${dangerous} dangerous)`,
      );
    }

    // Always re-evaluate the 24h dangerous-misclass rate, even on
    // no-op ticks. The rolling rate can change WITHOUT new
    // reconciliations: if safe samples age out of the 24h window
    // before dangerous ones, the rate goes UP without anyone
    // touching the table. Skipping the alert query on
    // `rows.length === 0` would let the scheduled alert stay silent
    // through a regression that the `/model-eval/metrics` endpoint
    // simultaneously reports as `alert_active=true`.
    await this.maybeRaiseAlert();

    return { reconciled: rows.length, dangerous };
  }

  /**
   * Compute the metrics surfaced by the admin endpoint and the
   * markdown report. The cross-device/bike agreement values are
   * read from the in-memory snapshot the weekly job populates;
   * `recomputeAgreements()` falls back to running the calculation
   * inline whenever the snapshot is missing OR older than
   * `AGREEMENT_SNAPSHOT_TTL_MS`.
   *
   * The TTL refresh exists for split deployments
   * (`TARMOTO_QUEUE_WORKER_ENABLED=false` on the API container):
   * without it the API process would compute the snapshot once on
   * the first poll and then return that stale value indefinitely
   * — agreement regressions wouldn't surface until the API
   * restarted because the weekly job runs in a different process
   * and updates only the worker's in-memory cache.
   */
  async getMetrics(): Promise<ModelEvalMetricsResponseDto> {
    const versions = await this.computeVersionMetrics();

    if (this.snapshotIsStale(this.lastDeviceAgreement)) {
      await this.recomputeAgreements();
    }

    return {
      window_hours: ROLLING_WINDOW_HOURS,
      generated_at: new Date().toISOString(),
      versions,
      cross_device_agreement: this.lastDeviceAgreement,
      cross_bike_agreement: this.lastBikeAgreement,
    };
  }

  private snapshotIsStale(snapshot: ModelEvalAgreementSnapshotDto): boolean {
    if (snapshot.computed_at === null) return true;
    const computedMs = Date.parse(snapshot.computed_at);
    if (!Number.isFinite(computedMs)) return true;
    return Date.now() - computedMs > AGREEMENT_SNAPSHOT_TTL_MS;
  }

  /**
   * Run the cross-device + cross-bike agreement calculation against
   * the last 7 days of reconciled samples. Called by the weekly job;
   * also called inline by `getMetrics()` on first request after boot
   * so the snapshot is never `null`.
   *
   * Agreement is computed per qualifying segment as the fraction of
   * pairwise predictions that fall within ±1 quality class, then
   * averaged across segments. We use pairwise rather than std-dev
   * because the metric the spec quotes (>0.80, >0.75) is a
   * fraction-style score, not a dispersion.
   */
  async recomputeAgreements(): Promise<{
    cross_device: ModelEvalAgreementSnapshotDto;
    cross_bike: ModelEvalAgreementSnapshotDto;
  }> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rawRows: unknown = await this.samples.query(
      `SELECT road_segment_id, predicted_score, device_model, bike_id
       FROM model_eval_samples
       WHERE reconciled_at IS NOT NULL
         AND reconciled_at >= $1`,
      [since],
    );
    const rows = rawRows as Array<{
      road_segment_id: string;
      predicted_score: number;
      device_model: string | null;
      bike_id: string | null;
    }>;

    this.lastDeviceAgreement = computeAgreement(
      rows.map((r) => ({
        segmentId: r.road_segment_id,
        score: r.predicted_score,
        bucket: deviceFamily(r.device_model),
      })),
    );
    this.lastBikeAgreement = computeAgreement(
      rows.map((r) => ({
        segmentId: r.road_segment_id,
        score: r.predicted_score,
        bucket: r.bike_id ?? null,
      })),
    );

    this.logger.log(
      `cross-device agreement = ${formatScore(this.lastDeviceAgreement.agreement_score)} ` +
        `over ${this.lastDeviceAgreement.segments_evaluated} segments`,
    );
    this.logger.log(
      `cross-bike agreement = ${formatScore(this.lastBikeAgreement.agreement_score)} ` +
        `over ${this.lastBikeAgreement.segments_evaluated} segments`,
    );

    return {
      cross_device: this.lastDeviceAgreement,
      cross_bike: this.lastBikeAgreement,
    };
  }

  /**
   * Render the metrics snapshot as a Markdown summary suitable for
   * `docs/process/model-eval-report.md`. Format is intentionally
   * stable so a non-engineer (or a CI lint) can diff it across
   * runs.
   */
  async renderMarkdownReport(): Promise<string> {
    const snapshot = await this.getMetrics();
    return renderMarkdown(snapshot);
  }

  private async maybeRaiseAlert(): Promise<void> {
    const versions = await this.computeVersionMetrics();
    for (const v of versions) {
      if (!v.alert_active) continue;
      this.logger.error(
        `model-eval alert: dangerous misclass rate ${(
          v.dangerous_misclass_rate * 100
        ).toFixed(
          2,
        )}% > ${(DANGEROUS_MISCLASS_ALERT_RATE * 100).toFixed(2)}% ` +
          `for model_version=${v.model_version ?? 'null'} (${v.sample_count} samples in 24h)`,
      );
    }
  }

  private async computeVersionMetrics(): Promise<ModelEvalVersionMetricsDto[]> {
    const since = new Date(Date.now() - ROLLING_WINDOW_HOURS * 60 * 60 * 1000);
    const rawRows: unknown = await this.samples.query(
      `SELECT
         model_version,
         COUNT(*)::int AS sample_count,
         SUM(
           CASE WHEN dangerous_misclassification = TRUE THEN 1 ELSE 0 END
         )::int AS dangerous_count,
         SUM(
           CASE WHEN ABS(predicted_score - ROUND(aggregate_score::numeric)::int) <= 1
                THEN 1 ELSE 0 END
         )::int AS adjacent_count,
         AVG(ABS(predicted_score - aggregate_score))::float AS mae
       FROM model_eval_samples
       WHERE reconciled_at IS NOT NULL
         AND reconciled_at >= $1
       GROUP BY model_version
       ORDER BY sample_count DESC`,
      [since],
    );
    const rows = rawRows as Array<{
      model_version: string | null;
      sample_count: number;
      dangerous_count: number;
      adjacent_count: number;
      mae: number | null;
    }>;

    return rows.map((r) => {
      const dangerousRate =
        r.sample_count > 0 ? r.dangerous_count / r.sample_count : 0;
      const adjacentAccuracy =
        r.sample_count > 0 ? r.adjacent_count / r.sample_count : 0;
      return {
        model_version: r.model_version,
        sample_count: r.sample_count,
        dangerous_misclass_rate: roundTo(dangerousRate, 4),
        adjacent_accuracy: roundTo(adjacentAccuracy, 4),
        mae: roundTo(r.mae ?? 0, 4),
        alert_active: dangerousRate > DANGEROUS_MISCLASS_ALERT_RATE,
      };
    });
  }

  private async lookupBikeId(rideId: string | null): Promise<string | null> {
    if (!rideId) return null;
    const ride = await this.rides.findOne({
      where: { id: rideId },
      select: ['id', 'bike_id'],
    });
    return ride?.bike_id ?? null;
  }

  private parseSampleRate(): number {
    const raw = this.config.get<string>('TARMOTO_MODEL_EVAL_SAMPLE_RATE');
    if (raw === undefined || raw === null || raw === '') {
      return DEFAULT_SAMPLE_RATE;
    }
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      this.logger.warn(
        `TARMOTO_MODEL_EVAL_SAMPLE_RATE=${raw} is not a finite number in [0,1]; ` +
          `falling back to default ${DEFAULT_SAMPLE_RATE}`,
      );
      return DEFAULT_SAMPLE_RATE;
    }
    return parsed;
  }
}

function scoreToClassification(score: number): string {
  const rounded = Math.max(1, Math.min(5, Math.round(score)));
  switch (rounded) {
    case 5:
      return 'excellent';
    case 4:
      return 'good';
    case 3:
      return 'fair';
    case 2:
      return 'poor';
    default:
      return 'very_poor';
  }
}

interface AgreementInput {
  segmentId: string;
  score: number;
  bucket: string | null;
}

/**
 * For each segment that was hit by ≥3 distinct buckets (devices or
 * bikes), look at one sample per bucket — the most-common score in
 * that bucket — and compute the fraction of bucket-pairs whose
 * scores stay within ±1 quality class. Average that across all
 * qualifying segments.
 */
export function computeAgreement(
  rows: AgreementInput[],
): ModelEvalAgreementSnapshotDto {
  const bySegment = new Map<string, Map<string, number[]>>();
  for (const row of rows) {
    if (!row.bucket) continue;
    const segment = bySegment.get(row.segmentId) ?? new Map<string, number[]>();
    const scores = segment.get(row.bucket) ?? [];
    scores.push(row.score);
    segment.set(row.bucket, scores);
    bySegment.set(row.segmentId, segment);
  }

  let totalScore = 0;
  let qualifyingSegments = 0;
  for (const buckets of bySegment.values()) {
    if (buckets.size < CROSS_AGREEMENT_MIN_DISTINCT) continue;
    const bucketScores = [...buckets.values()].map(modeOrAverage);
    const pairs = pairwiseFraction(bucketScores);
    if (pairs === null) continue;
    totalScore += pairs;
    qualifyingSegments += 1;
  }

  const computedAt = new Date().toISOString();
  if (qualifyingSegments === 0) {
    return {
      computed_at: computedAt,
      agreement_score: null,
      segments_evaluated: 0,
    };
  }
  return {
    computed_at: computedAt,
    agreement_score: roundTo(totalScore / qualifyingSegments, 4),
    segments_evaluated: qualifyingSegments,
  };
}

function modeOrAverage(scores: number[]): number {
  if (scores.length === 0) return 0;
  if (scores.length === 1) return scores[0];
  const counts = new Map<number, number>();
  for (const s of scores) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best = scores[0];
  let bestCount = 0;
  for (const [score, count] of counts) {
    if (count > bestCount) {
      best = score;
      bestCount = count;
    }
  }
  return best;
}

function pairwiseFraction(scores: number[]): number | null {
  if (scores.length < 2) return null;
  let agree = 0;
  let total = 0;
  for (let i = 0; i < scores.length; i++) {
    for (let j = i + 1; j < scores.length; j++) {
      total += 1;
      if (Math.abs(scores[i] - scores[j]) <= 1) agree += 1;
    }
  }
  if (total === 0) return null;
  return agree / total;
}

function roundTo(value: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}

function renderMarkdown(snapshot: ModelEvalMetricsResponseDto): string {
  const lines: string[] = [];
  lines.push('# Tarmoto — Model Evaluation Snapshot');
  lines.push('');
  lines.push(`Generated: ${snapshot.generated_at}`);
  lines.push(`Window: last ${snapshot.window_hours}h (rolling)`);
  lines.push('');
  lines.push('## Per-version metrics (24h)');
  lines.push('');
  if (snapshot.versions.length === 0) {
    lines.push('_No reconciled samples in the last 24h._');
  } else {
    lines.push(
      '| Model version | Samples | Dangerous misclass | Adjacent accuracy | MAE | Alert |',
    );
    lines.push('|---|---:|---:|---:|---:|:---:|');
    for (const v of snapshot.versions) {
      lines.push(
        `| ${v.model_version ?? '_unknown_'} | ${v.sample_count} | ` +
          `${(v.dangerous_misclass_rate * 100).toFixed(2)}% | ` +
          `${(v.adjacent_accuracy * 100).toFixed(2)}% | ` +
          `${v.mae.toFixed(3)} | ${v.alert_active ? '🔴' : '✅'} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Spec targets (§7)');
  lines.push('');
  lines.push(
    `- Dangerous misclass rate < ${(SPEC_TARGETS.DANGEROUS_MISCLASS_RATE_MAX * 100).toFixed(0)}% (alert > ${(DANGEROUS_MISCLASS_ALERT_RATE * 100).toFixed(1)}%)`,
  );
  lines.push(
    `- Adjacent accuracy > ${(SPEC_TARGETS.ADJACENT_ACCURACY_MIN * 100).toFixed(0)}%`,
  );
  lines.push(`- MAE < ${SPEC_TARGETS.MAE_MAX.toFixed(2)}`);
  lines.push(
    `- Cross-device agreement > ${SPEC_TARGETS.CROSS_DEVICE_AGREEMENT_MIN.toFixed(2)}`,
  );
  lines.push(
    `- Cross-bike agreement > ${SPEC_TARGETS.CROSS_BIKE_AGREEMENT_MIN.toFixed(2)}`,
  );
  lines.push('');
  lines.push('## Cross-device agreement (7d)');
  lines.push('');
  lines.push(
    `- Score: ${formatScore(snapshot.cross_device_agreement.agreement_score)}`,
  );
  lines.push(
    `- Segments evaluated: ${snapshot.cross_device_agreement.segments_evaluated}`,
  );
  lines.push(
    `- Computed at: ${snapshot.cross_device_agreement.computed_at ?? 'n/a'}`,
  );
  lines.push('');
  lines.push('## Cross-bike agreement (7d)');
  lines.push('');
  lines.push(
    `- Score: ${formatScore(snapshot.cross_bike_agreement.agreement_score)}`,
  );
  lines.push(
    `- Segments evaluated: ${snapshot.cross_bike_agreement.segments_evaluated}`,
  );
  lines.push(
    `- Computed at: ${snapshot.cross_bike_agreement.computed_at ?? 'n/a'}`,
  );
  lines.push('');
  return lines.join('\n');
}
