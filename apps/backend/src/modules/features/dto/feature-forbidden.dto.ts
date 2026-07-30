import { ApiProperty } from '@nestjs/swagger';

/**
 * Body shape of the 403 that `FeatureGuard` throws when a boolean entitlement
 * (or operator kill switch) is not granted. Carries a machine-readable
 * `feature` so a client can tell WHICH key fired — the mobile offline hazard
 * queue keys on `feature === 'hazard_reporting'` to DEFER (retain) a report
 * during a reporting shutdown instead of dropping it as a poison pill. Distinct
 * from {@link FeatureLimitExceededDto} (numeric-cap rejection with `code`), so a
 * generated consumer can discriminate on endpoints that emit both.
 */
export class FeatureForbiddenDto {
  @ApiProperty({ example: 403 })
  statusCode!: number;

  @ApiProperty({ example: 'Forbidden' })
  error!: string;

  @ApiProperty({ example: 'Feature unavailable: collaborative_trips' })
  message!: string;

  @ApiProperty({
    example: 'hazard_reporting',
    description:
      'The `ToggleFeatureKey` whose entitlement/kill-switch blocked.',
  })
  feature!: string;
}
