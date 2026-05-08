/**
 * Quality-class scores from `docs/ML_MODEL_SPEC.md` §5.3. The order
 * is significant — `predicted_score`/`aggregate_score` use this 1-5
 * mapping for the dangerous-misclass rule and the MAE / adjacent-
 * accuracy metrics.
 */
export const QUALITY_CLASS_TO_SCORE: Record<string, number> = {
  excellent: 5,
  good: 4,
  fair: 3,
  poor: 2,
  very_poor: 1,
};

export function classificationToScore(classification: string): number | null {
  return QUALITY_CLASS_TO_SCORE[classification] ?? null;
}

/** Spec §7.1 — primary metric targets that gate the model for launch. */
export const SPEC_TARGETS = {
  WEIGHTED_F1_MIN: 0.8,
  ADJACENT_ACCURACY_MIN: 0.95,
  CONFUSION_BETWEEN_EXTREMES_MAX: 0.02,
  MAE_MAX: 0.5,
  SURFACE_TYPE_ACCURACY_MIN: 0.85,
  CROSS_DEVICE_AGREEMENT_MIN: 0.8,
  CROSS_BIKE_AGREEMENT_MIN: 0.75,
  /** Spec §7.3 — safety metric: the model says Excellent/Good when
   * truth is Poor/Very Poor. The launch gate is <1%; the production
   * alert fires above 1.5%. */
  DANGEROUS_MISCLASS_RATE_MAX: 0.01,
} as const;

/** Spec §8.3 step 3 — the aggregate is only used as truth when the
 * segment has accumulated at least these many readings AND its
 * confidence has reached this threshold. */
export const RECONCILE_MIN_CONFIDENCE = 70;
export const RECONCILE_MIN_READINGS = 5;

/**
 * 24h rolling alert threshold. Above this rate the reconciliation
 * processor logs at error level and the metric record is annotated
 * so the on-call dashboard surfaces it. The launch target is 1% — we
 * give a 0.5pp safety margin before firing the page-worthy alert so
 * a one-off statistical fluctuation doesn't wake on-call.
 */
export const DANGEROUS_MISCLASS_ALERT_RATE = 0.015;

/**
 * Window for the 24h rolling gauges exposed by the metrics endpoint
 * and consumed by the alert. Kept as a constant so the alert's
 * window matches the gauge's window — drifting them apart would
 * give the alert a different denominator than the dashboard.
 */
export const ROLLING_WINDOW_HOURS = 24;

/** Default fraction of readings to sample when no env override is
 * set. 1% per spec acceptance criteria — high enough to give a
 * meaningful denominator for the alert without ballooning the
 * `model_eval_samples` table. */
export const DEFAULT_SAMPLE_RATE = 0.01;

/** Cross-device / cross-bike agreement weekly job thresholds (spec
 * §7.2): only count segments hit by at least three distinct device
 * families / bikes. */
export const CROSS_AGREEMENT_MIN_DISTINCT = 3;

/**
 * Bucket a `device_model` like "iPhone 15 Pro" or "Samsung Galaxy
 * S23" into a coarse vendor family for cross-device agreement. Falls
 * back to the lowercased full string when the model string is short
 * or unrecognised so two distinct devices never collapse into one
 * bucket on a vendor we haven't taught the bucketer about.
 */
export function deviceFamily(deviceModel: string | null | undefined): string {
  if (!deviceModel) return 'unknown';
  const trimmed = deviceModel.trim().toLowerCase();
  if (trimmed.length === 0) return 'unknown';
  if (trimmed.startsWith('iphone')) return 'iphone';
  if (trimmed.startsWith('ipad')) return 'ipad';
  if (trimmed.startsWith('samsung')) return 'samsung';
  if (trimmed.startsWith('galaxy')) return 'samsung';
  if (trimmed.startsWith('pixel')) return 'pixel';
  if (trimmed.startsWith('xiaomi')) return 'xiaomi';
  if (trimmed.startsWith('oneplus')) return 'oneplus';
  if (trimmed.startsWith('redmi')) return 'xiaomi';
  if (trimmed.startsWith('huawei')) return 'huawei';
  if (trimmed.startsWith('motorola')) return 'motorola';
  if (trimmed.startsWith('moto ')) return 'motorola';
  // Fall through — keep the full string so a never-seen-before device
  // doesn't silently merge into another vendor's bucket.
  return trimmed.split(/\s+/)[0] ?? trimmed;
}
