import { ApiProperty } from '@nestjs/swagger';

export class RideResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  status!: string;

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

  @ApiProperty({ type: [Object], nullable: true })
  route_geometry!: Array<{ lat: number; lng: number }> | null;

  @ApiProperty({ nullable: true })
  elevation_gain!: number | null;

  @ApiProperty({ nullable: true })
  elevation_loss!: number | null;

  @ApiProperty({ nullable: true })
  curve_count!: number | null;

  @ApiProperty({ nullable: true })
  max_lean_angle!: number | null;

  @ApiProperty({
    nullable: true,
    type: 'object',
    description:
      'US-19 per-ride lean histogram. Counts of orientation-filter ' +
      'samples in each bucket (0-10°, 10-20°, 20-30°, 30°+). Null when ' +
      'no lean samples were captured (ride pre-dates US-19 or rider ' +
      'never let the orientation filter calibrate).',
    additionalProperties: { type: 'integer' },
  })
  lean_distribution!: {
    '0_10': number;
    '10_20': number;
    '20_30': number;
    '30_plus': number;
  } | null;

  @ApiProperty({ nullable: true })
  fuel_estimate_l!: number | null;

  @ApiProperty({ type: [Object] })
  segments!: Array<{
    road_segment_id: string | null;
    road_name: string | null;
    quality_reading: number | null;
    speed_avg: number | null;
    lean_angle_max: number | null;
  }>;
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
