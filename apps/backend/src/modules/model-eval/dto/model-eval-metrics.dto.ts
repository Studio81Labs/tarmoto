import { ApiProperty } from '@nestjs/swagger';

/** Last cross-device or cross-bike weekly agreement score. */
export class ModelEvalAgreementSnapshotDto {
  @ApiProperty({ description: 'ISO timestamp the agreement was last computed' })
  computed_at!: string | null;

  @ApiProperty({
    description:
      'Mean fraction of segments with ≥3 distinct devices/bikes ' +
      'whose paired predictions stay within ±1 quality class.',
    nullable: true,
  })
  agreement_score!: number | null;

  @ApiProperty({ description: 'Number of segments included in the score' })
  segments_evaluated!: number;
}

/**
 * 24h rolling window snapshot for one model version. Mirrors the
 * spec §7 metrics that gate the model for launch, plus the §7.3
 * dangerous-misclass safety metric.
 *
 * Returned as part of `ModelEvalMetricsResponseDto.versions` — there
 * is one entry per `model_version` that has any reconciled samples
 * in the window, so a v1.0/v1.1 rollout can be compared without the
 * caller doing a join.
 */
export class ModelEvalVersionMetricsDto {
  @ApiProperty({ example: 'rsc-v1.1.0', nullable: true })
  model_version!: string | null;

  @ApiProperty({ description: 'Reconciled samples in the window' })
  sample_count!: number;

  @ApiProperty({
    description:
      'Fraction of samples where predicted Excellent/Good but ' +
      'aggregate truth was Poor/Very Poor. Spec §7.3 target <0.01; ' +
      'alerts fire above 0.015.',
  })
  dangerous_misclass_rate!: number;

  @ApiProperty({
    description:
      'Fraction of samples whose predicted score is within ±1 of ' +
      'the aggregate truth on the 1-5 scale. Spec §7.1 target >0.95.',
  })
  adjacent_accuracy!: number;

  @ApiProperty({
    description:
      'Mean absolute error of predicted vs aggregate score on the ' +
      '1-5 scale. Spec §7.2 target <0.5.',
  })
  mae!: number;

  @ApiProperty({
    description:
      'True when `dangerous_misclass_rate` has crossed the alert ' +
      'threshold for this version in the window.',
  })
  alert_active!: boolean;

  @ApiProperty({
    description:
      'Cross-device agreement (spec §7.2) computed from this ' +
      "version's samples only. Partitioning by version prevents an " +
      'overlapping rollout (v1.0 + v1.1 active simultaneously) from ' +
      'showing inter-version differences as cross-device disagreement.',
    type: ModelEvalAgreementSnapshotDto,
  })
  cross_device_agreement!: ModelEvalAgreementSnapshotDto;

  @ApiProperty({
    description:
      'Cross-bike agreement (spec §7.2), partitioned by version for ' +
      'the same reason as `cross_device_agreement`.',
    type: ModelEvalAgreementSnapshotDto,
  })
  cross_bike_agreement!: ModelEvalAgreementSnapshotDto;
}

export class ModelEvalMetricsResponseDto {
  @ApiProperty({ description: 'Window length in hours (always 24)' })
  window_hours!: number;

  @ApiProperty({ description: 'ISO timestamp the snapshot was generated' })
  generated_at!: string;

  @ApiProperty({ type: [ModelEvalVersionMetricsDto] })
  versions!: ModelEvalVersionMetricsDto[];

  @ApiProperty({ type: ModelEvalAgreementSnapshotDto })
  cross_device_agreement!: ModelEvalAgreementSnapshotDto;

  @ApiProperty({ type: ModelEvalAgreementSnapshotDto })
  cross_bike_agreement!: ModelEvalAgreementSnapshotDto;
}
