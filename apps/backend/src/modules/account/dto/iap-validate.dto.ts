import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import {
  SUBSCRIPTION_PROVIDERS,
  type SubscriptionProvider,
} from '@tarmoto/shared';
import { SubscriptionSnapshotResponseDto } from './subscription-response.dto';

// P1a supports Apple only; Google Play IAP validation lands in a later phase.
const IAP_SUPPORTED_PROVIDERS = SUBSCRIPTION_PROVIDERS.filter(
  (provider): provider is Extract<SubscriptionProvider, 'apple'> =>
    provider === 'apple',
);

export class IapValidateRequestDto {
  @ApiProperty({
    enum: IAP_SUPPORTED_PROVIDERS,
    description:
      'IAP store provider. Only "apple" is supported in this phase; Google Play follows later.',
  })
  @IsIn(IAP_SUPPORTED_PROVIDERS)
  provider!: Extract<SubscriptionProvider, 'apple'>;

  @ApiProperty({
    description: 'StoreKit2 signed transaction (JWS) to verify server-side.',
  })
  @IsString()
  @IsNotEmpty()
  transaction!: string;

  // Hint only, NEVER trusted for entitlement: the granted tier is always
  // derived from the verified transaction server-side, not from this value.
  @ApiPropertyOptional({
    description:
      'Client-reported App Store product identifier. Hint only; never trusted for entitlement — the tier is derived from the verified transaction.',
  })
  @IsOptional()
  @IsString()
  productId?: string;
}

// Extends the subscription snapshot shape rather than duplicating its fields
// (matches the RideSummaryDto/RideDetailDto and ChallengeDto/ChallengeDetailDto
// extension pattern elsewhere in the backend). `provider` is already exposed by
// `SubscriptionSnapshotResponseDto` as required-nullable
// (`@ApiProperty({ enum: SUBSCRIPTION_PROVIDERS, nullable: true })`), so it is
// inherited as-is here and does not need to be redeclared.
export class IapValidateResponseDto extends SubscriptionSnapshotResponseDto {
  @ApiProperty({
    description:
      'Whether the client should retry validation (e.g. a transient verification failure) rather than treat this as a terminal error.',
  })
  retryable!: boolean;
}

// The uniform error body returned by every validation failure (400/409/503).
// Published so the generated client types the body as `{ message, retryable }`
// instead of `never`, letting a typed consumer implement the retry/finish
// decision documented on the endpoint.
export class IapValidateErrorResponseDto {
  @ApiProperty({
    description: 'Human-readable, non-sensitive explanation of the failure.',
  })
  message!: string;

  @ApiProperty({
    description:
      'Whether the client should retry validation (true for a transient store outage) rather than treat this as a terminal failure.',
  })
  retryable!: boolean;
}
