import { ApiProperty } from '@nestjs/swagger';
import { SURFACE_TYPES, type SurfaceType } from '@tarmoto/shared';
import { LatLngResponseDto } from '../../../common/lat-lng.dto.js';
import { HazardResponseDto } from '../../hazards/dto/hazard-response.dto.js';
import { ReviewResponseDto } from '../../reviews/dto/review.dto.js';
import { TrendPointDto } from './trend-point.dto.js';

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

  @ApiProperty({ enum: SURFACE_TYPES })
  surface_type!: SurfaceType;

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
  @ApiProperty({ type: [LatLngResponseDto] })
  geometry!: LatLngResponseDto[];

  @ApiProperty({ nullable: true })
  elevation_min!: number | null;

  @ApiProperty({ nullable: true })
  elevation_max!: number | null;

  @ApiProperty({
    nullable: true,
    type: [Number],
    description:
      'Per-vertex elevation in meters, aligned with `geometry`. Null when no elevation samples have been ingested yet.',
  })
  elevation_profile!: number[] | null;

  @ApiProperty({ type: QualityBreakdownDto })
  quality_breakdown!: QualityBreakdownDto;

  @ApiProperty({ type: [HazardResponseDto] })
  active_hazards!: HazardResponseDto[];

  @ApiProperty()
  active_hazard_count!: number;

  @ApiProperty({ type: [ReviewResponseDto] })
  recent_reviews!: ReviewResponseDto[];

  @ApiProperty()
  review_count!: number;

  @ApiProperty({ nullable: true })
  avg_review_rating!: number | null;

  @ApiProperty()
  riders_per_month!: number;

  @ApiProperty({
    type: [TrendPointDto],
    description: 'Monthly quality trend from surface readings (US-45).',
  })
  quality_history!: TrendPointDto[];

  @ApiProperty({
    type: [TrendPointDto],
    description:
      'Regional average quality trend for comparison (US-45). Empty when no regional data is available.',
  })
  regional_quality_history!: TrendPointDto[];
}
