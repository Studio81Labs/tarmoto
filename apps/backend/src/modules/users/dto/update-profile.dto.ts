import {
  IsArray,
  IsString,
  IsOptional,
  IsObject,
  IsNumber,
  IsBoolean,
  IsIn,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
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
  @IsOptional()
  @IsString()
  units?: string;

  @IsOptional()
  @IsNumber()
  daily_km?: number;

  @IsOptional()
  @IsNumber()
  min_quality?: number;

  @IsOptional()
  @IsString({ each: true })
  road_types?: string[];

  @IsOptional()
  @IsBoolean()
  record_gps?: boolean;

  @IsOptional()
  @IsBoolean()
  crash_detection?: boolean;

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
