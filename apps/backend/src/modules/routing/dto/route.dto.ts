import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Road-character preferences (revision 3 §A). Independent of the avoid
 * flags, which are hard constraints layered on top of any preference.
 * 'efficient_loop' is the roundtrip drafting mode and routes like
 * 'direct' at the costing level.
 */
export const ROUTE_PREFERENCES = [
  'direct',
  'balanced',
  'scenic_balance',
  'maximum_twisty',
  'efficient_loop',
] as const;
export type RoutePreferenceOption = (typeof ROUTE_PREFERENCES)[number];

/**
 * Upper bound on waypoints accepted by the routing + save endpoints. Caps
 * Valhalla request size and the per-route PostGIS `ST_DWithin` enrichment
 * work; the manual planner only ever needs a small, bounded set of points.
 */
export const MAX_ROUTE_WAYPOINTS = 50;

export class LatLngDto {
  @ApiProperty({ minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;
}

export class RouteOptionsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  avoid_highways?: boolean;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  avoid_tolls?: boolean;
  @ApiProperty({
    required: false,
    description:
      'Prefer good-surface roads using crowdsourced quality (GraphHopper ' +
      'only; no-op until conflation is provisioned — ADR-0005 / #779).',
  })
  @IsOptional()
  @IsBoolean()
  prefer_quality?: boolean;
  @ApiProperty({
    required: false,
    description:
      'Reserved — accepted but not yet applied to live routing (phase 1).',
  })
  @IsOptional()
  @IsBoolean()
  avoid_unpaved?: boolean;
  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Reserved — accepted but not yet applied to live routing (phase 1).',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  surfaces?: string[];
  @ApiProperty({
    required: false,
    enum: ROUTE_PREFERENCES,
    description:
      'Road character for this request (per-leg costing, revision 3). ' +
      'Mapped onto engine costing where supported (Valhalla use_highways ' +
      'weighting); engines that cannot honour it silently no-op.',
  })
  @IsOptional()
  @IsIn(ROUTE_PREFERENCES)
  preference?: RoutePreferenceOption;
}

export class RouteRequestDto {
  @ApiProperty({
    type: [LatLngDto],
    minItems: 2,
    maxItems: MAX_ROUTE_WAYPOINTS,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_ROUTE_WAYPOINTS)
  @ValidateNested({ each: true })
  @Type(() => LatLngDto)
  waypoints!: LatLngDto[];

  @ApiProperty({ required: false, type: RouteOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RouteOptionsDto)
  options?: RouteOptionsDto;
}

export class RouteResponseDto {
  @ApiProperty({ type: [LatLngDto] }) geometry!: LatLngDto[];
  @ApiProperty() distance_km!: number;
  @ApiProperty() duration_min!: number;
  @ApiProperty({ nullable: true }) avg_quality!: number | null;
  @ApiProperty({ nullable: true }) curviness_score!: number | null;
  @ApiProperty() elevation_gain_m!: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  surface_mix!: Record<string, number>;
}
