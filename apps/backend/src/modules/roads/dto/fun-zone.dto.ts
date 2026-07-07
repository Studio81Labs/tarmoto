import { ApiProperty } from '@nestjs/swagger';
import { LatLngResponseDto } from '../../../common/lat-lng.dto.js';

export class FunZoneDto {
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
    type: [LatLngResponseDto],
    description: 'Outer ring of the zone polygon as {lat,lng} points, WGS84.',
  })
  boundary!: LatLngResponseDto[];
}
