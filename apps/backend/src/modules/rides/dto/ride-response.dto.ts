import { ApiProperty } from '@nestjs/swagger';
import { RIDE_TYPES, type RideType } from '@tarmoto/shared';
import { LatLngResponseDto } from '../../../common/lat-lng.dto.js';

export const RIDE_STATUSES = ['active', 'completed', 'cancelled'] as const;
export type RideStatus = (typeof RIDE_STATUSES)[number];

/**
 * Per-ride lean histogram (US-19). Counts of 1-second sensor windows in
 * each absolute-lean bucket. Listed explicitly so the generated OpenAPI
 * schema names every key — that gives mobile / companion drift detection
 * if a future bucket is added or renamed.
 */
class LeanDistributionDto {
  @ApiProperty({ description: 'Samples with absolute lean < 10°.' })
  '0_10'!: number;

  @ApiProperty({ description: 'Samples with absolute lean ≥ 10° and < 20°.' })
  '10_20'!: number;

  @ApiProperty({ description: 'Samples with absolute lean ≥ 20° and < 30°.' })
  '20_30'!: number;

  @ApiProperty({ description: 'Samples with absolute lean ≥ 30°.' })
  '30_plus'!: number;
}

/**
 * Per-segment summary attached to a ride detail. The road_segment_id is
 * `null` when the rider's GPS samples didn't snap to any known segment
 * (e.g. unmapped private roads).
 */
class RideSegmentDto {
  @ApiProperty({ nullable: true })
  road_segment_id!: string | null;

  @ApiProperty({ nullable: true })
  road_name!: string | null;

  @ApiProperty({ nullable: true })
  quality_reading!: number | null;

  @ApiProperty({ nullable: true })
  speed_avg!: number | null;

  @ApiProperty({ nullable: true })
  lean_angle_max!: number | null;
}

export class RideResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: RIDE_STATUSES })
  status!: RideStatus;

  @ApiProperty({ enum: RIDE_TYPES })
  ride_type!: RideType;

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
      'Length-weighted average `curviness_score` of the road segments this ride crossed. `null` when no segments are snapped yet.',
  })
  avg_curviness!: number | null;
}

export class RideSummaryDto extends RideResponseDto {
  @ApiProperty({ nullable: true })
  name!: string | null;

  @ApiProperty({ nullable: true })
  duration_min!: number | null;
}

export class RideDetailDto extends RideSummaryDto {
  @ApiProperty({ nullable: true })
  max_speed!: number | null;

  @ApiProperty({ type: [LatLngResponseDto], nullable: true })
  route_geometry!: LatLngResponseDto[] | null;

  @ApiProperty({ nullable: true })
  elevation_gain!: number | null;

  @ApiProperty({ nullable: true })
  elevation_loss!: number | null;

  @ApiProperty({ nullable: true })
  curve_count!: number | null;

  @ApiProperty({ nullable: true })
  max_lean_angle!: number | null;

  @ApiProperty({ type: LeanDistributionDto, nullable: true })
  lean_distribution!: LeanDistributionDto | null;

  @ApiProperty({ nullable: true })
  fuel_estimate_l!: number | null;

  @ApiProperty({ type: [RideSegmentDto] })
  segments!: RideSegmentDto[];
}

export class RideListResponseDto {
  @ApiProperty({ type: [RideSummaryDto] })
  rides!: RideSummaryDto[];

  @ApiProperty()
  total!: number;
}

export class RideTrackDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true })
  geometry!: { type: 'LineString'; coordinates: number[][] } | null;
}

export class RideTracksResponseDto {
  @ApiProperty({ type: [RideTrackDto] })
  tracks!: RideTrackDto[];

  @ApiProperty({ description: 'true when the 500-row cap was hit' })
  truncated!: boolean;
}
