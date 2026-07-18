import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** Admin wire shapes for numeric limit entitlements. The limit
 * vocabulary is code-defined (`FEATURE_DEFINITIONS`) — operators manage
 * only the two override layers. `null` = unlimited everywhere. */

export class TierLimitValuesDto {
  @ApiProperty({ type: Number, nullable: true }) free!: number | null;
  @ApiProperty({ type: Number, nullable: true }) pro!: number | null;
  @ApiProperty({ type: Number, nullable: true }) premium!: number | null;
}

export class AdminFeatureLimitDto {
  @ApiProperty({ description: 'Registry limit key.' })
  feature!: string;

  @ApiProperty() description!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Registry value for unknown tiers.',
  })
  default_value!: number | null;

  @ApiProperty({ type: TierLimitValuesDto })
  tier_values!: TierLimitValuesDto;

  @ApiProperty({ description: 'Whether a global override row exists.' })
  global_active!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Global override value (null = unlimited). Only meaningful when global_active.',
  })
  global_value!: number | null;

  @ApiProperty({ nullable: true }) global_reason!: string | null;
  @ApiProperty({ nullable: true }) global_updated_by!: string | null;
  @ApiProperty({ nullable: true }) global_updated_at!: string | null;

  @ApiProperty({ description: 'Users with a per-user override.' })
  overridden_user_count!: number;
}

export class AdminFeatureLimitsResponseDto {
  @ApiProperty({ type: [AdminFeatureLimitDto] })
  limits!: AdminFeatureLimitDto[];
}

export class SetLimitGlobalValueDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Override value; null = unlimited (launch mode / promo raise).',
  })
  @ValidateIf((o: SetLimitGlobalValueDto) => o.value !== null)
  @IsInt()
  @Min(0)
  value!: number | null;

  @ApiProperty({
    maxLength: 500,
    description:
      'Why the override is set — always required (any global limit change ' +
      'is user-visible). Stored on the row, never audited.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class SetUserLimitOverrideDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Override value; null = unlimited.',
  })
  @ValidateIf((o: SetUserLimitOverrideDto) => o.value !== null)
  @IsInt()
  @Min(0)
  value!: number | null;
}

export class AdminUserFeatureLimitDto {
  @ApiProperty() feature!: string;
  @ApiProperty() description!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'The value the user actually resolves to right now (null = unlimited).',
  })
  resolved!: number | null;

  @ApiProperty({ description: 'Whether a per-user override row exists.' })
  override_active!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Override value (null = unlimited). Only meaningful when override_active.',
  })
  override_value!: number | null;
}

export class AdminUserFeatureLimitsResponseDto {
  @ApiProperty() user_id!: string;
  @ApiProperty({ type: [AdminUserFeatureLimitDto] })
  limits!: AdminUserFeatureLimitDto[];
}
