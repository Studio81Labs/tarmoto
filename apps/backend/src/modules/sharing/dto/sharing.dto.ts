import {
  IsBoolean,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { RIDE_TYPES, type RideType } from '@tarmoto/shared';

export class ToggleShareDto {
  @ApiProperty({ description: 'Whether the ride should be publicly visible' })
  @IsBoolean()
  is_public!: boolean;
}

export const COMMUNITY_RIDE_SORT_VALUES = [
  'newest',
  'oldest',
  'longest',
  'shortest',
  'highest_quality',
  'curviest',
  'most_popular',
  'nearest',
] as const;
export type CommunityRideSort = (typeof COMMUNITY_RIDE_SORT_VALUES)[number];

export class CommunityRidesQueryDto {
  /**
   * Latitude / longitude of the search centre. Optional — when both are
   * omitted the feed is global, sorted by `sort` (default `newest`). When
   * one is supplied the other is required so we never run a half-defined
   * spatial query. Required when `sort = nearest`.
   */
  @ApiPropertyOptional({
    description:
      'Latitude of the search centre. Required when `lng` is set or when `sort = nearest`.',
  })
  @ValidateIf(
    (o: CommunityRidesQueryDto) => o.lng !== undefined || o.sort === 'nearest',
  )
  @IsLatitude()
  @Type(() => Number)
  lat?: number;

  @ApiPropertyOptional({
    description:
      'Longitude of the search centre. Required when `lat` is set or when `sort = nearest`.',
  })
  @ValidateIf(
    (o: CommunityRidesQueryDto) => o.lat !== undefined || o.sort === 'nearest',
  )
  @IsLongitude()
  @Type(() => Number)
  lng?: number;

  @ApiPropertyOptional({
    description:
      'Search radius in km. Only applied when `lat` and `lng` are set.',
    default: 25,
    minimum: 1,
    maximum: 500,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(500)
  radius_km?: number;

  @ApiPropertyOptional({
    description: 'Minimum ride distance in km.',
    minimum: 0,
    maximum: 10_000,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(10_000)
  min_distance_km?: number;

  @ApiPropertyOptional({
    description: 'Maximum ride distance in km.',
    minimum: 0,
    maximum: 10_000,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(10_000)
  max_distance_km?: number;

  @ApiPropertyOptional({
    description: 'Minimum average road quality (0..5).',
    minimum: 0,
    maximum: 5,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(5)
  min_quality?: number;

  @ApiPropertyOptional({
    description: 'Minimum community popularity, measured as public view count.',
    minimum: 0,
    maximum: 1_000_000,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(1_000_000)
  min_popularity?: number;

  @ApiPropertyOptional({
    description:
      'Minimum length-weighted curviness. Rides without a computed ' +
      '`avg_curviness` are excluded when this filter is set — "no value" ' +
      'is not "low value", and silently including them would contaminate ' +
      '"curvy rides" results.',
    minimum: 0,
    maximum: 10,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(10)
  min_curviness?: number;

  @ApiPropertyOptional({
    description: 'Maximum length-weighted curviness.',
    minimum: 0,
    maximum: 10,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(10)
  max_curviness?: number;

  @ApiPropertyOptional({
    description: 'Restrict results to a single ride type.',
    enum: RIDE_TYPES,
  })
  @IsOptional()
  @IsIn(RIDE_TYPES)
  ride_type?: RideType;

  @ApiPropertyOptional({
    description:
      'Sort order. `nearest` requires `lat`/`lng` (enforced above) — requests without a centre are rejected with 400 rather than silently re-sorted.',
    enum: COMMUNITY_RIDE_SORT_VALUES,
    default: 'newest',
  })
  @IsOptional()
  @IsIn(COMMUNITY_RIDE_SORT_VALUES)
  sort?: CommunityRideSort;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 10_000 })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(10_000)
  offset?: number;
}

export class SharedRideResponseDto {
  @ApiProperty()
  share_token!: string;

  @ApiProperty()
  is_public!: boolean;

  @ApiProperty()
  share_url!: string;
}

class RouteGeometryPointDto {
  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;
}

export class SharedRideDetailDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rider_name!: string;

  @ApiProperty()
  ride_type!: string;

  @ApiProperty()
  started_at!: string;

  @ApiProperty({ nullable: true })
  ended_at!: string | null;

  @ApiProperty({ nullable: true })
  distance_km!: number | null;

  @ApiProperty({ nullable: true })
  avg_speed!: number | null;

  @ApiProperty({ nullable: true })
  max_speed!: number | null;

  @ApiProperty({ nullable: true })
  avg_road_quality!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Length-weighted average `curviness_score` across the road segments this ride crossed.',
  })
  avg_curviness!: number | null;

  @ApiProperty({ nullable: true })
  duration_min!: number | null;

  @ApiProperty({
    description:
      'Number of times this shared ride has been viewed via its token. Incremented on each fetch.',
  })
  view_count!: number;

  @ApiProperty({
    description:
      'Number of outbound clicks from embeddable route widgets into the full Tarmoto ride page.',
  })
  embed_click_count!: number;

  @ApiProperty({ nullable: true, type: [RouteGeometryPointDto] })
  route_geometry!: Array<{ lat: number; lng: number }> | null;
}

export class CommunityRideDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  share_token!: string;

  @ApiProperty()
  rider_id!: string;

  @ApiProperty()
  rider_name!: string;

  @ApiProperty({ nullable: true })
  rider_avatar_url!: string | null;

  @ApiProperty()
  ride_type!: string;

  @ApiProperty()
  started_at!: string;

  @ApiProperty({ nullable: true })
  distance_km!: number | null;

  @ApiProperty({ nullable: true })
  avg_speed!: number | null;

  @ApiProperty({ nullable: true })
  avg_road_quality!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Length-weighted average `curviness_score` across the road segments this ride crossed. Drives the `curviest` sort.',
  })
  avg_curviness!: number | null;

  @ApiProperty({ nullable: true })
  duration_min!: number | null;

  @ApiProperty({
    description:
      'Number of times this shared ride has been viewed via its token. Drives the `most_popular` sort.',
  })
  view_count!: number;

  @ApiProperty({
    nullable: true,
    description:
      'Optional rider-authored caption for the feed card. Null when none was set.',
  })
  description!: string | null;

  @ApiProperty({ description: 'Number of riders who hearted this route.' })
  like_count!: number;

  @ApiProperty({
    description:
      'Whether the authenticated viewer has hearted this route. Always false for anonymous viewers.',
  })
  viewer_has_liked!: boolean;

  @ApiProperty({
    description: 'Number of times this route has been cloned into trips.',
  })
  clone_count!: number;

  @ApiProperty({
    nullable: true,
    type: [RouteGeometryPointDto],
    description:
      'Polyline used for feed-card mini-previews. Null when the ride has no stored route geometry.',
  })
  route_geometry!: Array<{ lat: number; lng: number }> | null;
}

export class RideLikeResponseDto {
  @ApiProperty({ description: 'Total hearts after the toggle.' })
  like_count!: number;

  @ApiProperty({ description: 'Whether the viewer now hearts this route.' })
  viewer_has_liked!: boolean;
}

export class CloneRideResponseDto {
  @ApiProperty({ description: 'Id of the trip created from the shared route.' })
  trip_id!: string;

  @ApiProperty({ description: 'Total clones after this one.' })
  clone_count!: number;
}

export class CommunityRidesResponseDto {
  @ApiProperty({ type: [CommunityRideDto] })
  items!: CommunityRideDto[];

  @ApiProperty({
    description:
      'Total number of public rides matching the filter set (ignores limit/offset). Lets clients render "page X of N".',
  })
  total!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  offset!: number;
}

export class UserSharedRidesQueryDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 10_000 })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(10_000)
  offset?: number;
}

export class UserSharedRideDto {
  @ApiProperty({ description: 'Underlying ride id.' })
  id!: string;

  @ApiProperty()
  share_token!: string;

  @ApiProperty()
  ride_type!: string;

  @ApiProperty({
    description:
      'Whether the share is publicly visible. Always true for non-self viewers (private shares are filtered out server-side); both states appear when the rider is viewing their own list so they can spot private shares.',
  })
  is_public!: boolean;

  @ApiProperty()
  started_at!: string;

  @ApiProperty({ nullable: true })
  ended_at!: string | null;

  @ApiProperty({ nullable: true })
  distance_km!: number | null;

  @ApiProperty({ nullable: true })
  avg_speed!: number | null;

  @ApiProperty({ nullable: true })
  avg_road_quality!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Length-weighted average `curviness_score` across the road segments this ride crossed.',
  })
  avg_curviness!: number | null;

  @ApiProperty({ nullable: true })
  duration_min!: number | null;

  @ApiProperty({
    description:
      'Number of times this shared ride has been viewed via its token.',
  })
  view_count!: number;

  @ApiProperty({
    description:
      'ISO 8601 timestamp of when the rider shared this ride (not when the ride happened — see `started_at` for that). Drives the newest-first sort.',
  })
  shared_at!: string;

  @ApiProperty({
    nullable: true,
    type: [RouteGeometryPointDto],
    description:
      'Polyline used for profile-card mini-previews. Null when the ride has no stored route geometry.',
  })
  route_geometry!: Array<{ lat: number; lng: number }> | null;
}

export class UserSharedRidesResponseDto {
  @ApiProperty({ type: [UserSharedRideDto] })
  items!: UserSharedRideDto[];

  @ApiProperty({
    description:
      'Total number of shared rides for the rider visible to the viewer (ignores limit/offset). Lets clients render "page X of N".',
  })
  total!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  offset!: number;
}
