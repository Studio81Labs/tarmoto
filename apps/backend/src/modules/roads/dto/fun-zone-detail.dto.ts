import { ApiProperty } from '@nestjs/swagger';

import { GeometryPointDto } from './best-roads.dto.js';

export class FunZoneDetailZoneDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true })
  name!: string | null;

  @ApiProperty()
  composite_score!: number;

  @ApiProperty()
  road_count!: number;

  @ApiProperty({ nullable: true })
  total_curve_km!: number | null;

  @ApiProperty({ nullable: true })
  avg_quality!: number | null;

  @ApiProperty({ nullable: true })
  best_season!: string | null;

  @ApiProperty({
    type: [Object],
    description: 'Outer ring of the zone polygon as {lat,lng} points, WGS84.',
  })
  boundary!: Array<{ lat: number; lng: number }>;
}

export class FunZoneRoadDto {
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

  @ApiProperty({ description: 'Segment length in metres' })
  length_m!: number;

  @ApiProperty({ description: '0-100 confidence score' })
  confidence!: number;

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

  @ApiProperty({
    type: [GeometryPointDto],
    description:
      'Polyline of { lat, lng } points, ordered along direction of travel',
  })
  geometry!: GeometryPointDto[];

  @ApiProperty({
    nullable: true,
    description:
      "Opaque score from the analytics pipeline ranking this road's contribution to the zone's composite score. Null when not yet computed.",
  })
  contribution_score!: number | null;
}

export class FunZoneDetailDto {
  @ApiProperty({ type: FunZoneDetailZoneDto })
  zone!: FunZoneDetailZoneDto;

  @ApiProperty({ type: [FunZoneRoadDto] })
  top_roads!: FunZoneRoadDto[];
}
