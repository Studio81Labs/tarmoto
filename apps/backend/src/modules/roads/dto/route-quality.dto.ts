import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Hard cap on routed-geometry vertices. Bounds the bind-param array and
 * `ST_MakeLine` size independently of the 500 km length guard — a geometry
 * densified well below segment scale is rejected at the DTO boundary (400)
 * before any query is built. Sized to fit a dense max-length route (well over
 * one vertex per sampled 40 m) while staying under the 1 MiB body limit.
 */
export const MAX_ROUTE_QUALITY_POINTS = 25000;

/**
 * Body limit for `POST /roads/route-quality`. A routed day/leg polyline can
 * carry a few thousand vertices — well over the global 100 kb default — while
 * still under the service's 500 km length cap, so this endpoint is scoped up in
 * `main.ts` and the request reaches the handler instead of a body-parser 413.
 * 1 MiB comfortably fits a dense max-length route's geometry.
 */
export const ROUTE_QUALITY_BODY_LIMIT_BYTES = 1_048_576;

/**
 * One point of a routed polyline (request side). Mirrors the passes
 * `RoutePointDto` — validated lat/lng so a malformed body is rejected at
 * the DTO boundary before it reaches the spatial query.
 */
class RouteQualityPointDto {
  @ApiProperty()
  @IsLatitude()
  @Type(() => Number)
  lat!: number;

  @ApiProperty()
  @IsLongitude()
  @Type(() => Number)
  lng!: number;
}

/**
 * `POST /roads/route-quality` request — a routed polyline whose per-segment
 * road-surface quality the planner wants to display (#862). The geometry is
 * the routed line from `RouteResponseDto.geometry`; the endpoint spatially
 * joins it to `road_segments`.
 */
export class RouteQualityRequestDto {
  @ApiProperty({
    type: [RouteQualityPointDto],
    minItems: 2,
    maxItems: MAX_ROUTE_QUALITY_POINTS,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_ROUTE_QUALITY_POINTS)
  @ValidateNested({ each: true })
  @Type(() => RouteQualityPointDto)
  geometry!: RouteQualityPointDto[];

  @ApiPropertyOptional({
    minimum: 5,
    maximum: 200,
    // No `default:` here on purpose — openapi-typescript emits a schema
    // property that carries a default as *required*, which would force the
    // companion to pass `buffer_m` on every default call. The default is
    // applied server-side (`dto.buffer_m ?? 25`) and documented below.
    description:
      'Buffer in meters around the routed line within which a `road_segments` ' +
      'row counts as "on the route". Defaults to 25 m when omitted — kept tight ' +
      'because the routed line follows the same OSM ways the segments were cut ' +
      'from, so a wide buffer would pull in parallel/adjacent roads.',
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(5)
  @Max(200)
  buffer_m?: number;
}

/**
 * One quality span along the route — a `road_segments` row the routed line
 * passes through, positioned by the fraction of the route it covers so the
 * client can paint it onto the polyline. Gaps between consecutive spans (and
 * anything before the first / after the last) are genuine no-coverage
 * stretches the planner renders as "no data".
 */
export class RouteQualitySegmentDto {
  @ApiProperty({
    nullable: true,
    description:
      'road_segments UUID of the matched span, so a client can open the same ' +
      '`/roads/{segmentId}` detail (reviews + history) the road explorer uses. ' +
      'Null only for a not-yet-matched/legacy span.',
  })
  segment_id!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'OSM way id of the matched segment (segment identity from #751). Null ' +
      'for segments imported before OSM identity was captured.',
  })
  osm_way_id!: string | null;

  @ApiProperty({ nullable: true })
  segment_index!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Distance-weighted road-surface quality, 1–5. Null when the segment has ' +
      'no snapped surface readings yet (rendered as an unscored stretch).',
  })
  quality_score!: number | null;

  @ApiProperty({ description: 'Curviness score 0–5.' })
  curviness_score!: number;

  @ApiProperty()
  surface_type!: string;

  @ApiProperty({
    description:
      'Number of surface readings snapped to this segment. Drives the ' +
      'low-confidence treatment when small.',
  })
  reading_count!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 1,
    description:
      'Fraction along the route (0 = start, 1 = end) where this span begins. ' +
      'Spans are returned ordered by `start_fraction`.',
  })
  start_fraction!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 1,
    description: 'Fraction along the route where this span ends.',
  })
  end_fraction!: number;
}

/** `POST /roads/route-quality` response. */
export class RouteQualityResponseDto {
  @ApiProperty({
    type: [RouteQualitySegmentDto],
    description:
      'The road segments the route passes through, ordered along the route. ' +
      'Empty when no imported segments cover the route (the whole route is ' +
      'then "no data").',
  })
  segments!: RouteQualitySegmentDto[];
}
