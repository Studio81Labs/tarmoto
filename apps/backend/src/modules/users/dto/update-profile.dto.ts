import {
  IsArray,
  IsString,
  IsOptional,
  IsObject,
  IsNumber,
  IsBoolean,
  IsIn,
  MaxLength,
  ValidateIf,
  ValidateNested,
  IsTimeZone,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
  canonicalizeFormatLocale,
  TIMEZONE_MAX_LENGTH,
} from '@tarmoto/shared';
import { IsFormatLocale } from './is-format-locale.validator.js';
import { ROUTE_PREFERENCES } from '../../routing/dto/route.dto.js';

export const MIN_QUALITY_LEVELS = [
  'any',
  'fair_or_better',
  'good_or_better',
  'excellent_only',
] as const;

/**
 * The rider's default route preferences (revision 3 §F) — the trip-wide
 * subset only, pre-applied to every new planner trip. Per-leg overrides
 * and waypoints are per-trip and never persisted here.
 */
export class UserRoutePrefsDto {
  @ApiProperty({ enum: ROUTE_PREFERENCES })
  @IsIn(ROUTE_PREFERENCES)
  road_preference!: (typeof ROUTE_PREFERENCES)[number];

  @ApiProperty()
  @IsBoolean()
  avoid_highways!: boolean;

  @ApiProperty()
  @IsBoolean()
  avoid_tolls!: boolean;

  @ApiProperty()
  @IsBoolean()
  avoid_unpaved!: boolean;

  @ApiProperty({ type: [String] })
  // IsArray is load-bearing: with `each` alone a bare string passes
  // (it validates the value itself), lands in the JSONB, and crashes
  // the companion's wire.surfaces.filter(...) on the next prefs load.
  @IsArray()
  @IsString({ each: true })
  surfaces!: string[];

  @ApiProperty({ enum: MIN_QUALITY_LEVELS })
  @IsIn(MIN_QUALITY_LEVELS)
  min_quality!: (typeof MIN_QUALITY_LEVELS)[number];
}

class LatLngDto {
  @IsNumber()
  lat!: number;

  @IsNumber()
  lng!: number;
}

class UserPreferencesDto {
  @ApiProperty({ enum: ['metric', 'imperial'], required: false })
  @IsOptional()
  @IsIn(['metric', 'imperial'])
  units?: 'metric' | 'imperial';

  /**
   * BCP-47 regional-format tag (e.g. "cs-CZ") driving number/date display.
   * Canonicalized on write ("CS-cz" → "cs-CZ"); when canonicalization fails
   * the raw value is kept so @IsFormatLocale rejects it with a 400 instead
   * of a silent null landing in the JSONB.
   */
  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? (canonicalizeFormatLocale(value) ?? value)
      : value,
  )
  @IsFormatLocale()
  format_locale?: string;

  /** IANA display timezone (e.g. "Europe/Prague"); mirrors the rider's device. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsTimeZone()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  timezone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  daily_km?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  min_quality?: number;

  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsString({ each: true })
  road_types?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  record_gps?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  crash_detection?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => UserRoutePrefsDto)
  route_prefs?: UserRoutePrefsDto;
}

export class UpdateProfileDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  display_name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar_url?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string | null;

  // `language`'s column is NOT NULL (unlike its nullable siblings above), so
  // `@IsOptional()` would be wrong here: it skips validation for `null` too,
  // letting `{ language: null }` bypass `@IsIn` and hit the DB as a NOT NULL
  // violation instead of a 400. `@ValidateIf` only skips validation when the
  // field is `undefined` (absent/omitted) — an explicit `null` still runs
  // `@IsIn`, which rejects it since `null` is never in `SUPPORTED_LOCALES`.
  @ApiProperty({ enum: SUPPORTED_LOCALES, required: false })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(SUPPORTED_LOCALES)
  language?: SupportedLocale;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  home_region?: string | null;

  @ApiProperty({ required: false, type: LatLngDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LatLngDto)
  home_location?: LatLngDto;

  @ApiProperty({ required: false, type: LatLngDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LatLngDto)
  work_location?: LatLngDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UserPreferencesDto)
  preferences?: UserPreferencesDto;
}
