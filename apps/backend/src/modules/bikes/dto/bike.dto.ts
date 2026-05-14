import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Expose, Transform } from 'class-transformer';

const trim = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value,
);

export const MIN_BIKE_YEAR = 1900;

// `currentYear + 1` because manufacturers ship next-model-year bikes
// mid-season. Computed at request time so the ceiling rolls forward
// without redeploying.
export function maxBikeYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

/**
 * Validates a bike year against `[MIN_BIKE_YEAR, currentYear + 1]`.
 *
 * Reaches for a custom constraint instead of `@Min(...) @Max(...)`
 * because decorator arguments are evaluated once at module load — so
 * a `@Max(maxBikeYear())` ceiling captured when the process started
 * in 2026 would keep rejecting `2028` model-year bikes throughout
 * 2027 until the next deploy. `validate()` runs per request, so the
 * ceiling rolls forward at midnight UTC on Jan 1.
 */
@ValidatorConstraint({ name: 'isBikeYear', async: false })
export class IsBikeYearConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= MIN_BIKE_YEAR &&
      value <= maxBikeYear()
    );
  }
  defaultMessage(): string {
    return `year must be an integer between ${MIN_BIKE_YEAR} and ${maxBikeYear()}`;
  }
}

export class CreateBikeDto {
  @ApiProperty({ example: 'Honda', minLength: 1 })
  @trim
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  make!: string;

  @ApiProperty({ example: 'Africa Twin', minLength: 1 })
  @trim
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  model!: string;

  @ApiPropertyOptional({ example: 2024 })
  @IsOptional()
  @IsInt()
  @Validate(IsBikeYearConstraint)
  year?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Expose({ name: 'isActive' })
  is_active?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  @Expose({ name: 'photoUrl' })
  photo_url?: string | null;

  @ApiPropertyOptional({
    description: 'Short slug for the rider-picked bike icon.',
  })
  @IsOptional()
  @trim
  @IsString()
  @MaxLength(32)
  icon?: string;

  @ApiPropertyOptional({ description: 'Free-form rider notes.' })
  @IsOptional()
  @trim
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class UpdateBikeDto {
  @ApiPropertyOptional({ example: 'Honda' })
  @IsOptional()
  @trim
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  make?: string;

  @ApiPropertyOptional({ example: 'Africa Twin' })
  @IsOptional()
  @trim
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({ example: 2024 })
  @IsOptional()
  @IsInt()
  @Validate(IsBikeYearConstraint)
  year?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  @Expose({ name: 'isActive' })
  is_active?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  @Expose({ name: 'photoUrl' })
  photo_url?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @trim
  @IsString()
  @MaxLength(32)
  icon?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @trim
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class BikeDto {
  @ApiProperty({ example: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Honda' })
  make!: string;

  @ApiProperty({ example: 'Africa Twin' })
  model!: string;

  @ApiProperty({ nullable: true, example: 2024 })
  year!: number | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ nullable: true })
  icon!: string | null;

  @ApiProperty({ nullable: true })
  notes!: string | null;

  @ApiProperty({
    example: 0,
    description: 'Total kilometers recorded with this bike',
  })
  totalKm!: number;

  @ApiProperty({
    example: 0,
    description: 'Number of rides recorded with this bike',
  })
  totalRides!: number;

  @ApiProperty({ example: '2026-05-05T00:00:00Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-05-05T00:00:00Z' })
  updatedAt!: string;
}
