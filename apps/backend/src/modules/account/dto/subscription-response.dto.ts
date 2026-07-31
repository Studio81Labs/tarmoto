import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  SUBSCRIPTION_TIERS,
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_MANAGED_BY,
  type SubscriptionTier,
  type SubscriptionProvider,
  type SubscriptionManagedBy,
} from '@tarmoto/shared';

class SubscriptionPlanDto {
  @ApiProperty({ enum: SUBSCRIPTION_TIERS })
  tier!: SubscriptionTier;
}

class CurrentSubscriptionPlanDto {
  @ApiProperty({ enum: SUBSCRIPTION_TIERS })
  tier!: SubscriptionTier;

  @ApiProperty({ enum: ['active', 'trialing', 'past_due', 'canceled'] })
  status!: 'active' | 'trialing' | 'past_due' | 'canceled';

  @ApiPropertyOptional({ type: String, nullable: true })
  renews_at!: string | null;

  @ApiProperty()
  cancel_at_period_end!: boolean;
}

class SubscriptionPaymentMethodDto {
  @ApiProperty()
  brand!: string;

  @ApiProperty()
  last4!: string;

  @ApiProperty()
  exp_month!: number;

  @ApiProperty()
  exp_year!: number;
}

class SubscriptionInvoiceDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  date!: string;

  @ApiProperty()
  amount_label!: string;

  @ApiProperty({ description: 'Charge amount in the currency minor unit.' })
  amount_minor!: number;

  @ApiProperty({ example: 'EUR' })
  currency!: string;

  @ApiProperty({ enum: ['paid', 'open', 'refunded'] })
  status!: 'paid' | 'open' | 'refunded';

  @ApiPropertyOptional({ nullable: true })
  invoice_url!: string | null;
}

export class SubscriptionSnapshotResponseDto {
  @ApiProperty({ type: CurrentSubscriptionPlanDto })
  current_plan!: CurrentSubscriptionPlanDto;

  @ApiProperty({ type: [SubscriptionPlanDto] })
  plans!: SubscriptionPlanDto[];

  @ApiPropertyOptional({
    type: SubscriptionPaymentMethodDto,
    nullable: true,
  })
  payment_method!: SubscriptionPaymentMethodDto | null;

  @ApiProperty({ type: [SubscriptionInvoiceDto] })
  billing_history!: SubscriptionInvoiceDto[];

  @ApiProperty()
  portal_available!: boolean;

  @ApiPropertyOptional({ enum: SUBSCRIPTION_PROVIDERS, nullable: true })
  provider!: SubscriptionProvider | null;

  @ApiPropertyOptional({ enum: SUBSCRIPTION_MANAGED_BY, nullable: true })
  managed_by!: SubscriptionManagedBy | null;

  @ApiProperty()
  trial_eligible!: boolean;
}

export class RedirectUrlResponseDto {
  @ApiProperty()
  url!: string;
}
