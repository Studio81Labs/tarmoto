import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { toOptionalBoolean } from '../../../common/dto-transforms.js';

export const ROAD_CLOSURE_REASONS = [
  'closure',
  'roadworks',
  'seasonal',
  'weather',
  'event',
  'other',
] as const;
export type RoadClosureReason = (typeof ROAD_CLOSURE_REASONS)[number];

export const ROAD_CLOSURE_SEVERITIES = ['advisory', 'partial', 'full'] as const;
export type RoadClosureSeverity = (typeof ROAD_CLOSURE_SEVERITIES)[number];

export const ROAD_CLOSURE_SOURCES = ['operator', 'osm', 'official'] as const;
export type RoadClosureSource = (typeof ROAD_CLOSURE_SOURCES)[number];

export class ClosurePointDto {
  @ApiProperty()
  @IsLatitude()
  @Type(() => Number)
  lat!: number;

  @ApiProperty()
  @IsLongitude()
  @Type(() => Number)
  lng!: number;
}

export class RoadClosureDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ enum: ROAD_CLOSURE_REASONS })
  reason!: RoadClosureReason;

  @ApiProperty({ enum: ROAD_CLOSURE_SEVERITIES })
  severity!: RoadClosureSeverity;

  @ApiProperty({
    type: [ClosurePointDto],
    description: 'Polyline (2+ points) of the affected road stretch.',
  })
  geometry!: ClosurePointDto[];

  @ApiProperty({
    type: [ClosurePointDto],
    nullable: true,
    description:
      'Optional detour polyline for roadworks. Null for closures ' +
      'without a captured detour, and for every non-roadworks reason.',
  })
  detour!: ClosurePointDto[] | null;

  @ApiProperty({ description: 'ISO 3166-1 alpha-2 country code' })
  country_code!: string;

  @ApiProperty({ nullable: true })
  region!: string | null;

  @ApiProperty({ description: 'ISO 8601 timestamp (UTC)' })
  starts_at!: string;

  @ApiProperty({
    nullable: true,
    description:
      'ISO 8601 timestamp (UTC). Null means the closure is in effect indefinitely.',
  })
  ends_at!: string | null;

  @ApiProperty({ nullable: true })
  notes!: string | null;

  @ApiProperty({ enum: ROAD_CLOSURE_SOURCES })
  source!: RoadClosureSource;

  @ApiProperty({
    nullable: true,
    description: 'User ID of the creator, or null for imported data.',
  })
  created_by!: string | null;

  @ApiProperty()
  created_at!: string;

  @ApiProperty()
  updated_at!: string;
}

export class ListClosuresQueryDto {
  @ApiPropertyOptional({
    description:
      'Bounding box filter "minLng,minLat,maxLng,maxLat". Omit to list all.',
    example: '5,45,17,49',
  })
  @IsOptional()
  @IsString()
  @Matches(/^-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?){3}$/, {
    message: 'bbox must be "minLng,minLat,maxLng,maxLat"',
  })
  bbox?: string;

  /**
   * Restricts the result to closures in effect on the given instant. A
   * closure is "active" when `starts_at <= active_on` AND
   * (`ends_at IS NULL` OR `ends_at >= active_on`). Defaults to NOW so
   * the planner map only shows what's currently relevant.
   */
  @ApiPropertyOptional({
    description:
      'ISO 8601 instant. Only closures active on this instant are returned. Defaults to now.',
    example: '2026-07-15T00:00:00Z',
  })
  @IsOptional()
  @IsISO8601()
  active_on?: string;

  @ApiPropertyOptional({
    enum: ROAD_CLOSURE_SEVERITIES,
    description: 'Filter by severity.',
  })
  @IsOptional()
  @IsIn(ROAD_CLOSURE_SEVERITIES)
  severity?: RoadClosureSeverity;

  @ApiPropertyOptional({
    enum: ROAD_CLOSURE_REASONS,
    description: 'Filter by reason.',
  })
  @IsOptional()
  @IsIn(ROAD_CLOSURE_REASONS)
  reason?: RoadClosureReason;

  /**
   * By default `active_on` is applied (only currently-active closures).
   * Set this to `true` to get the full history, e.g. for an admin UI.
   */
  @ApiPropertyOptional({
    description:
      'When true, ignore `active_on` and return all closures regardless of window.',
    default: false,
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  include_past?: boolean;
}

export class CreateClosureDto {
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @Length(1, 160)
  title!: string;

  @ApiProperty({ enum: ROAD_CLOSURE_REASONS })
  @IsIn(ROAD_CLOSURE_REASONS)
  reason!: RoadClosureReason;

  @ApiProperty({ enum: ROAD_CLOSURE_SEVERITIES })
  @IsIn(ROAD_CLOSURE_SEVERITIES)
  severity!: RoadClosureSeverity;

  @ApiProperty({ type: [ClosurePointDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => ClosurePointDto)
  geometry!: ClosurePointDto[];

  @ApiPropertyOptional({
    type: [ClosurePointDto],
    minItems: 2,
    description:
      'Optional detour polyline (2+ points). Only permitted when ' +
      '`reason = "roadworks"` — the service rejects a detour on any ' +
      'other reason.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => ClosurePointDto)
  detour?: ClosurePointDto[];

  @ApiProperty({ description: 'ISO 3166-1 alpha-2 country code' })
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, {
    message: 'country_code must be a 2-letter ISO 3166-1 alpha-2 code',
  })
  country_code!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  region?: string;

  @ApiProperty({ description: 'ISO 8601 timestamp (UTC).' })
  @IsDateString()
  starts_at!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'ISO 8601 timestamp (UTC). Omit for an indefinite / until-further-notice closure.',
  })
  @IsOptional()
  @IsDateString()
  ends_at?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateClosureDto {
  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @IsString()
  @Length(1, 160)
  title?: string;

  @ApiPropertyOptional({ enum: ROAD_CLOSURE_REASONS })
  @IsOptional()
  @IsIn(ROAD_CLOSURE_REASONS)
  reason?: RoadClosureReason;

  @ApiPropertyOptional({ enum: ROAD_CLOSURE_SEVERITIES })
  @IsOptional()
  @IsIn(ROAD_CLOSURE_SEVERITIES)
  severity?: RoadClosureSeverity;

  @ApiPropertyOptional({ type: [ClosurePointDto], minItems: 2 })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => ClosurePointDto)
  geometry?: ClosurePointDto[];

  @ApiPropertyOptional({
    type: [ClosurePointDto],
    minItems: 2,
    nullable: true,
    description:
      'Optional detour polyline. Pass `null` explicitly to clear an ' +
      'existing detour. When set, `reason` must be (or become) ' +
      '"roadworks".',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => ClosurePointDto)
  detour?: ClosurePointDto[] | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, {
    message: 'country_code must be a 2-letter ISO 3166-1 alpha-2 code',
  })
  country_code?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  region?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  starts_at?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Pass `null` explicitly to clear an existing end date.',
  })
  @IsOptional()
  @IsDateString()
  ends_at?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string | null;
}

export class CheckRouteClosuresDto {
  @ApiProperty({
    type: [ClosurePointDto],
    minItems: 2,
    description: 'Planned route polyline (2+ points, WGS84 lat/lng).',
  })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => ClosurePointDto)
  route!: ClosurePointDto[];

  @ApiPropertyOptional({
    default: 100,
    minimum: 10,
    maximum: 5000,
    description:
      'Buffer in meters around the route to treat a closure as "on it". ' +
      'Smaller than the passes default (1500 m) because closures are ' +
      'linestrings that already trace the affected road stretch.',
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(10)
  @Max(5000)
  buffer_m?: number;

  @ApiPropertyOptional({
    description:
      'ISO 8601 instant. Only closures active on this instant are checked. ' +
      'Defaults to now, so the planner gets the closures the rider would ' +
      'hit if they left immediately.',
    example: '2026-07-15T00:00:00Z',
  })
  @IsOptional()
  @IsISO8601()
  active_on?: string;
}

export class CheckRouteClosuresResponseDto {
  @ApiProperty({
    type: [RoadClosureDto],
    description:
      'Active closures within `buffer_m` of the route, ordered by ' +
      'severity (full > partial > advisory), then by start date.',
  })
  closures!: RoadClosureDto[];

  @ApiProperty({ description: 'Count of closures with severity = full.' })
  full_count!: number;

  @ApiProperty({ description: 'Count of closures with severity = partial.' })
  partial_count!: number;

  @ApiProperty({ description: 'Count of closures with severity = advisory.' })
  advisory_count!: number;
}
