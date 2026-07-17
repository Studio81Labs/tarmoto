import { registerAs } from '@nestjs/config';

/**
 * Config for the scheduled road-quality → GraphHopper conflation job (#779
 * Phase 2, ADR-0005).
 *
 * `enabled` defaults to **false** so the weekly job is dormant until a
 * deployment opts in and has provisioned the input/output paths + a GraphHopper
 * that re-imports the derived extract. When off, a tick is a cheap no-op.
 *
 * `inputFilePath` is the `.osm` XML extract to tag — normally the **same**
 * extract GraphHopper imports (typically one of the folder model's per-region
 * `<code>.osm` files, Sub-project B, or a merged extract the operator provides).
 * The job reads it, injects a `smoothness` tag onto every way it has a quality
 * score for, and writes `outputFilePath`, which the GraphHopper import then
 * consumes. Both are required when enabled; the job throws a clear error
 * rather than silently producing nothing.
 *
 * The conflation **region** is not configured here — conflation is
 * WHOLE-NETWORK (Sub-project B): it scores every live, scored way regardless
 * of which region(s) contributed it, since the road import now spans multiple
 * independently-refreshed regions and no single bbox describes the covered
 * area anymore. See {@link QualityConflationService.buildConflation}.
 */
export interface QualityConflationConfig {
  enabled: boolean;
  inputFilePath: string | null;
  outputFilePath: string | null;
}

export const qualityConflationConfig = registerAs(
  'qualityConflation',
  (): QualityConflationConfig => {
    const inputFilePath =
      process.env.TARMOTO_QUALITY_CONFLATION_INPUT_FILE?.trim();
    const outputFilePath =
      process.env.TARMOTO_QUALITY_CONFLATION_OUTPUT_FILE?.trim();
    return {
      enabled:
        (process.env.TARMOTO_QUALITY_CONFLATION_ENABLED ?? 'false')
          .trim()
          .toLowerCase() === 'true',
      inputFilePath: inputFilePath ? inputFilePath : null,
      outputFilePath: outputFilePath ? outputFilePath : null,
    };
  },
);
