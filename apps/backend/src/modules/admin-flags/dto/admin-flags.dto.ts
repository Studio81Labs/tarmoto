import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  FEATURE_OVERRIDE_STATES,
  GLOBAL_FEATURE_STATES,
  type FeatureOverrideState,
  type GlobalFeatureState,
} from '@tarmoto/shared';

/**
 * Admin wire shapes for the tier-aware feature-flag system. The flag
 * vocabulary is code-defined (`FEATURE_DEFINITIONS` in `@tarmoto/shared`),
 * so there is no create/delete — operators manage global overrides
 * (kill switch / force-on) and per-user overrides only.
 */

export class AdminFeatureFlagDto {
  @ApiProperty({ description: 'Registry feature key.' })
  feature!: string;

  @ApiProperty() description!: string;

  @ApiProperty({
    description: 'Registry baseline before tier grants and overrides.',
  })
  default_value!: boolean;

  @ApiProperty({
    type: [String],
    description: 'Subscription tiers granted the feature.',
  })
  tiers!: string[];

  @ApiProperty({
    enum: GLOBAL_FEATURE_STATES,
    nullable: true,
    description: 'Active global override, or null when resolving normally.',
  })
  global_state!: GlobalFeatureState | null;

  @ApiProperty({ nullable: true })
  global_reason!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Admin user id that last set the global override.',
  })
  global_updated_by!: string | null;

  @ApiProperty({ nullable: true })
  global_updated_at!: string | null;

  @ApiProperty({ description: 'Users with a per-user override.' })
  overridden_user_count!: number;
}

export class AdminFeatureFlagsResponseDto {
  @ApiProperty({ type: [AdminFeatureFlagDto] })
  flags!: AdminFeatureFlagDto[];
}

export class SetFeatureGlobalStateDto {
  @ApiProperty({ enum: GLOBAL_FEATURE_STATES })
  @IsIn(GLOBAL_FEATURE_STATES)
  state!: GlobalFeatureState;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Why the override is set. Required for force_off (a kill switch ' +
      'must carry incident context). Stored on the row, never audited.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf(
    (o: SetFeatureGlobalStateDto) =>
      o.state === 'force_off' || o.reason !== undefined,
  )
  @IsString()
  @IsNotEmpty({ message: 'reason is required when forcing a feature off' })
  @MaxLength(500)
  reason?: string;
}

export class SetFeatureOverrideDto {
  @ApiProperty({
    description: 'true force-grants the feature, false force-revokes it.',
  })
  @IsBoolean()
  enabled!: boolean;
}

export class AdminUserFeatureFlagDto {
  @ApiProperty() feature!: string;
  @ApiProperty() description!: string;
  @ApiProperty() default_value!: boolean;

  @ApiProperty({
    description: 'The value the user actually resolves to right now.',
  })
  resolved!: boolean;

  @ApiProperty({
    enum: FEATURE_OVERRIDE_STATES,
    description: 'Per-user override state ("default" = no override row).',
  })
  override_state!: FeatureOverrideState;
}

export class AdminUserFeatureFlagsResponseDto {
  @ApiProperty() user_id!: string;
  @ApiProperty({ type: [AdminUserFeatureFlagDto] })
  flags!: AdminUserFeatureFlagDto[];
}

export const FEATURE_FLAG_USER_OVERRIDE_FILTERS = [
  'force_on',
  'force_off',
] as const;
export type FeatureFlagUserOverrideFilter =
  (typeof FEATURE_FLAG_USER_OVERRIDE_FILTERS)[number];

export class ListFeatureFlagUsersQueryDto {
  @ApiPropertyOptional({
    description: 'Substring match on email or display_name.',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    enum: FEATURE_FLAG_USER_OVERRIDE_FILTERS,
    description: 'Only overrides of this direction.',
  })
  @IsOptional()
  @IsIn(FEATURE_FLAG_USER_OVERRIDE_FILTERS)
  override?: FeatureFlagUserOverrideFilter;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class AdminFeatureFlagUserRowDto {
  @ApiProperty() user_id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() display_name!: string;
  @ApiProperty() subscription_tier!: string;
  @ApiProperty({
    description: 'true = per-user force-on, false = per-user force-off.',
  })
  enabled!: boolean;
  @ApiProperty() updated_at!: string;
}

export class AdminFeatureFlagUsersResponseDto {
  @ApiProperty({ type: [AdminFeatureFlagUserRowDto] })
  rows!: AdminFeatureFlagUserRowDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}
