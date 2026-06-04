import { ApiProperty } from '@nestjs/swagger';
import type { MonthlyStats } from '@tarmoto/shared';

/**
 * `GET /users/me/stats/monthly` response. `implements MonthlyStats` locks
 * the field set to the canonical `@tarmoto/shared` interface so any drift
 * is a compile error, mirroring `MeProfileDto`.
 */
export class MonthlyStatsDto implements MonthlyStats {
  @ApiProperty({
    description: 'Distance (km) over completed rides this month.',
  })
  this_month_km!: number;

  @ApiProperty({ description: 'Distance (km) the previous calendar month.' })
  prev_month_km!: number;

  @ApiProperty({ description: 'Ride time (hours) this month.' })
  ride_hours!: number;

  @ApiProperty({
    description: 'Ride time (hours) the previous calendar month.',
  })
  prev_ride_hours!: number;

  @ApiProperty({ description: 'Distinct road segments ridden this month.' })
  new_roads!: number;

  @ApiProperty({
    nullable: true,
    description: 'Max lean angle (deg) this month.',
  })
  max_lean_deg!: number | null;

  @ApiProperty({ nullable: true, description: 'Ride that set the max lean.' })
  max_lean_ride_name!: string | null;

  @ApiProperty({ nullable: true, description: 'ISO start of that ride.' })
  max_lean_at!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Latest mobile upload, or null.',
  })
  last_synced_at!: string | null;
}
