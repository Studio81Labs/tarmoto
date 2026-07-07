import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
  @ApiProperty({ type: [RouteQualityPointDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => RouteQualityPointDto)
  geometry!: RouteQualityPointDto[];

  @ApiPropertyOptional({
    default: 25,
    minimum: 5,
    maximum: 200,
    description:
      'Buffer in meters around the routed line within which a `road_segments` ' +
      'row counts as "on the route". Kept tight (default 25 m) because the ' +
      'routed line follows the same OSM ways the segments were cut from, so a ' +
      'wide buffer would pull in parallel/adjacent roads.',
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
