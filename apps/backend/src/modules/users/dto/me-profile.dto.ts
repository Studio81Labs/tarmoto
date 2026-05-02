import { ApiProperty } from '@nestjs/swagger';
import type { MeProfile } from '@tarmoto/shared';

/**
 * Authenticated rider's own profile summary (issue #334). Returned by
 * `GET /users/me/profile` and consumed by the companion gamification
 * dashboard (`riderStatsFromBadges` previously fell back to zero/epoch
 * defaults for `total_hours`/`joined_at`) and the mobile profile screen.
 *
 * The `implements MeProfile` clause locks the field set / nullability to
 * the canonical interface in `@tarmoto/shared` — drift here surfaces as a
 * compile error rather than as a runtime mismatch.
 */
export class MeProfileDto implements MeProfile {
  @ApiProperty({ description: 'ISO 8601 join timestamp.' })
  joined_at!: string;

  @ApiProperty({
    description:
      "Total ride time in hours across the rider's `status = 'completed'` rides.",
  })
  total_hours!: number;

  @ApiProperty({ description: 'Count of completed rides.' })
  total_rides!: number;

  @ApiProperty({
    description: 'Sum of `distance_km` across completed rides (metric).',
  })
  total_distance_km!: number;

  @ApiProperty({
    description: 'Distinct road segments ridden across completed rides.',
  })
  roads_discovered!: number;

  @ApiProperty({
    description: 'Count of hazard reports authored by the rider.',
  })
  hazards_reported!: number;

  @ApiProperty({ description: 'Riders following the user.' })
  follower_count!: number;

  @ApiProperty({ description: 'Riders the user follows.' })
  following_count!: number;

  @ApiProperty({ description: 'Badges earned at any tier.' })
  badges_earned!: number;
}
