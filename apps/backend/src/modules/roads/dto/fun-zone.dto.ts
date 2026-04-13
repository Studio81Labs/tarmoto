import { ApiProperty } from '@nestjs/swagger';

export class FunZoneDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ nullable: true })
  name: string | null;

  @ApiProperty()
  composite_score: number;

  @ApiProperty()
  road_count: number;

  @ApiProperty({ nullable: true })
  total_curve_km: number | null;

  @ApiProperty({ nullable: true })
  avg_quality: number | null;

  @ApiProperty({ nullable: true })
  best_season: string | null;

  @ApiProperty({ type: [Object] })
  boundary: Array<{ lat: number; lng: number }>;
}
