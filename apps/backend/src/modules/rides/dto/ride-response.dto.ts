import { ApiProperty } from '@nestjs/swagger';

export class RideResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  ride_type: string;

  @ApiProperty()
  started_at: string;

  @ApiProperty({ nullable: true })
  ended_at: string | null;

  @ApiProperty({ nullable: true })
  distance_km: number | null;

  @ApiProperty({ nullable: true })
  avg_speed: number | null;

  @ApiProperty({ nullable: true })
  avg_road_quality: number | null;
}

export class RideSummaryDto extends RideResponseDto {
  @ApiProperty({ nullable: true })
  duration_min: number | null;
}

export class RideDetailDto extends RideSummaryDto {
  @ApiProperty({ nullable: true })
  max_speed: number | null;

  @ApiProperty({ type: [Object], nullable: true })
  route_geometry: Array<{ lat: number; lng: number }> | null;

  @ApiProperty({ nullable: true })
  elevation_gain: number | null;

  @ApiProperty({ nullable: true })
  elevation_loss: number | null;

  @ApiProperty({ nullable: true })
  curve_count: number | null;

  @ApiProperty({ nullable: true })
  max_lean_angle: number | null;

  @ApiProperty({ nullable: true })
  fuel_estimate_l: number | null;

  @ApiProperty({ type: [Object] })
  segments: Array<{
    road_segment_id: string | null;
    road_name: string | null;
    quality_reading: number | null;
    speed_avg: number | null;
    lean_angle_max: number | null;
  }>;
}

export class RideListResponseDto {
  @ApiProperty({ type: [RideSummaryDto] })
  rides: RideSummaryDto[];

  @ApiProperty()
  total: number;
}
