import { ApiProperty } from '@nestjs/swagger';

export class RoadSegmentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true })
  road_name!: string | null;

  @ApiProperty({ nullable: true })
  road_number!: string | null;

  @ApiProperty({ description: '1-5 scale', nullable: true })
  quality_score!: number | null;

  @ApiProperty({ description: '0-5 scale' })
  curviness_score!: number;

  @ApiProperty()
  surface_type!: string;

  @ApiProperty()
  length_m!: number;

  @ApiProperty({ description: '0-100, based on number of readings' })
  confidence!: number;

  @ApiProperty()
  reading_count!: number;

  @ApiProperty()
  last_updated!: string;

  @ApiProperty({
    required: false,
    description: 'Distance from query point in meters',
  })
  distance_m?: number;
}

export class QualityBreakdownDto {
  @ApiProperty()
  excellent!: number;

  @ApiProperty()
  good!: number;

  @ApiProperty()
  fair!: number;

  @ApiProperty()
  poor!: number;

  @ApiProperty()
  very_poor!: number;
}

export class RoadSegmentDetailDto extends RoadSegmentDto {
  @ApiProperty({ type: [Object] })
  geometry!: Array<{ lat: number; lng: number }>;

  @ApiProperty({ nullable: true })
  elevation_min!: number | null;

  @ApiProperty({ nullable: true })
  elevation_max!: number | null;

  @ApiProperty({ type: QualityBreakdownDto })
  quality_breakdown!: QualityBreakdownDto;

  @ApiProperty()
  active_hazards!: number;

  @ApiProperty()
  review_count!: number;

  @ApiProperty({ nullable: true })
  avg_review_rating!: number | null;

  @ApiProperty()
  riders_per_month!: number;
}
