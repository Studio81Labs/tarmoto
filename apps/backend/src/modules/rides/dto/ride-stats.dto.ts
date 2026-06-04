import { ApiProperty } from '@nestjs/swagger';
import type { RideStats } from '@tarmoto/shared';

export class RideStatsDto implements RideStats {
  @ApiProperty({ description: 'Sum of distance_km across filtered rides.' })
  total_distance_km!: number;

  @ApiProperty({
    description: 'Total ride time (hours) across filtered rides.',
  })
  total_hours!: number;

  @ApiProperty({ description: 'Distinct road segments touched (new roads).' })
  new_roads!: number;

  @ApiProperty({
    nullable: true,
    description: 'Distance-weighted avg quality (0–5).',
  })
  avg_quality!: number | null;

  @ApiProperty({ description: 'Number of rides matched by the filter.' })
  ride_count!: number;
}
