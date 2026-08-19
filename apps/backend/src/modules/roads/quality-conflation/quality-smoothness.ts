/**
 * Quality → OSM `smoothness` mapping for GraphHopper conflation (ADR-0005, #779).
 *
 * Tarmoto's per-segment `road_segments.quality_score` is a continuous value in
 * `[1, 5]` (a recency-weighted, outlier-filtered mean of per-reading scores).
 * GraphHopper weights routes off its stock **`smoothness`** encoded value
 * (`OSMSmoothnessParser`), so the conflation job injects an OSM `smoothness` tag
 * derived from that score — no forked image, no custom parser. The request-time
 * `custom_model` (`GraphHopperProvider.preferQuality`) then de-weights the poor
 * tiers.
 *
 * ADR-0005 fixes the anchor mapping at the integer scores:
 *
 * | quality_score | smoothness   |
 * | ------------- | ------------ |
 * | 5             | excellent    |
 * | 4             | good         |
 * | 3             | intermediate |
 * | 2             | bad          |
 * | 1             | very_bad     |
 * | NULL          | _(no tag → MISSING → neutral)_ |
 *
 * A continuous score maps to the **nearest** integer tier. `NULL`/non-finite
 * yields no tag: a segment without crowdsourced data must stay neutral
 * (`MISSING`), never penalised. This is the single source of truth for the
 * mapping — the service maps in TS rather than SQL so the boundary logic is unit
 * tested in one place.
 */
export type OsmSmoothness =
  'excellent' | 'good' | 'intermediate' | 'bad' | 'very_bad';

/** OSM `smoothness` value per integer tier, worst (1) → best (5). */
const TIER_TO_SMOOTHNESS: Record<number, OsmSmoothness> = {
  1: 'very_bad',
  2: 'bad',
  3: 'intermediate',
  4: 'good',
  5: 'excellent',
};

/**
 * Map a `quality_score` to its OSM `smoothness` tag, or `null` when there is no
 * usable score (so the way gets no tag and stays `MISSING`/neutral).
 *
 * The score rounds to the nearest integer tier and is clamped to `[1, 5]`, so a
 * value that drifts just outside the nominal range (a stray `0` or `6` from a
 * future scoring change) still lands on the nearest valid tier rather than
 * silently dropping out of the graph.
 */
export function qualityScoreToSmoothness(
  score: number | null | undefined,
): OsmSmoothness | null {
  if (score == null || !Number.isFinite(score)) return null;
  const tier = Math.min(5, Math.max(1, Math.round(score)));
  return TIER_TO_SMOOTHNESS[tier] ?? null;
}
