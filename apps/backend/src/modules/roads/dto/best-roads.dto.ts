import { ApiProperty } from '@nestjs/swagger';

export class GeometryPointDto {
  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;
}

export class BestRoadsRegionDto {
  @ApiProperty({ example: 'beskydy' })
  slug!: string;

  @ApiProperty({ example: 'cz' })
  country!: string;

  @ApiProperty({ example: 'Beskydy' })
  name!: string;

  @ApiProperty({
    type: [Number],
    description: '[west, south, east, north] in WGS84 degrees',
    example: [18.0, 49.3, 18.85, 49.7],
  })
  bbox!: [number, number, number, number];
}

export class BestRoadDto {
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

  @ApiProperty({
    type: [GeometryPointDto],
    description:
      'Polyline of { lat, lng } points, ordered along direction of travel',
  })
  geometry!: GeometryPointDto[];

  @ApiProperty({
    nullable: true,
    description:
      'Composite best-road ranking score (opaque, for debugging). Null while ' +
      'the road_quality_overlay operator kill is active: the score is ' +
      'quality_score*2 + curviness_score + LEAST(length_m/1000, 20)*0.1, so ' +
      'with curviness and length in the same row it would hand back the ' +
      'killed quality_score in one line of algebra (#1203).',
  })
  best_score!: number | null;
}

export class BestRoadsResponseDto {
  @ApiProperty({ type: BestRoadsRegionDto })
  region!: BestRoadsRegionDto;

  @ApiProperty({ type: [BestRoadDto] })
  roads!: BestRoadDto[];
}
