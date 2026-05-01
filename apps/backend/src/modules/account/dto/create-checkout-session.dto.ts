import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { SUBSCRIPTION_TIERS, type SubscriptionTier } from '@tarmoto/shared';

const PAID_SUBSCRIPTION_TIERS = SUBSCRIPTION_TIERS.filter(
  (tier): tier is Exclude<SubscriptionTier, 'free'> => tier !== 'free',
);

export class CreateCheckoutSessionDto {
  @ApiProperty({ enum: PAID_SUBSCRIPTION_TIERS })
  @IsIn(PAID_SUBSCRIPTION_TIERS)
  tier!: Exclude<SubscriptionTier, 'free'>;
}
