import { ApiProperty } from '@nestjs/swagger';

/**
 * Body shape of the plain 403 that `FeatureGuard` throws (Nest's
 * `ForbiddenException('Feature unavailable: <key>')`) when a boolean
 * entitlement is not granted. Unlike {@link FeatureLimitExceededDto} it
 * carries NO machine-readable `code`/`feature`/`limit`/`current` fields —
 * it is the standard Nest forbidden envelope. Documented so a generated
 * consumer can tell an entitlement-gate rejection apart from a numeric-cap
 * rejection on endpoints that can emit both.
 */
export class FeatureForbiddenDto {
  @ApiProperty({ example: 403 })
  statusCode!: number;

  @ApiProperty({ example: 'Forbidden' })
  error!: string;

  @ApiProperty({ example: 'Feature unavailable: collaborative_trips' })
  message!: string;
}
