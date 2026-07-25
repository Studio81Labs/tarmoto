import { ApiProperty } from '@nestjs/swagger';
import { FEATURE_LIMIT_EXCEEDED } from '@tarmoto/shared';

/**
 * Body shape of the 403 thrown by `featureLimitExceeded` when a request
 * would exceed a numeric entitlement cap. Documents the machine-readable
 * fields so generated consumers can distinguish a cap rejection from any
 * other 403 without string-matching the message. Mirrors the object passed
 * to `ForbiddenException` in `feature-limit.error.ts`.
 */
export class FeatureLimitExceededDto {
  @ApiProperty({ example: 403 })
  statusCode!: number;

  @ApiProperty({ example: 'Forbidden' })
  error!: string;

  @ApiProperty({
    example:
      'Feature limit exceeded: max_trip_collaborators (limit 5, current 5)',
  })
  message!: string;

  @ApiProperty({
    example: FEATURE_LIMIT_EXCEEDED,
    description:
      'Stable discriminator for cap rejections. Always ' +
      `"${FEATURE_LIMIT_EXCEEDED}".`,
  })
  code!: string;

  @ApiProperty({
    example: 'max_trip_collaborators',
    description: 'The `LimitFeatureKey` that was exceeded.',
  })
  feature!: string;

  @ApiProperty({
    example: 5,
    description: 'The resolved cap that was hit.',
  })
  limit!: number;

  @ApiProperty({
    example: 5,
    description: 'The current count that meets or exceeds the cap.',
  })
  current!: number;
}
