import { ApiProperty } from '@nestjs/swagger';
import type { ContributionStats } from '@tarmoto/shared';

/**
 * `GET /users/me/contribution` response. `implements ContributionStats`
 * locks the field set to the canonical `@tarmoto/shared` interface so any
 * drift is a compile error, mirroring `MonthlyStatsDto` / `MeProfileDto`.
 */
export class ContributionStatsDto implements ContributionStats {
  @ApiProperty({
    description:
      'Distinct road-segment length the rider contributed quality data to, in km.',
  })
  km_mapped!: number;

  @ApiProperty({
    description:
      'Count of distinct road segments the rider contributed quality data to.',
  })
  segments_mapped!: number;

  @ApiProperty({
    nullable: true,
    description: "The rider's home_region, or null when unset.",
  })
  home_region!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      '1-based DENSE_RANK within the region by km mapped; null when the rider has no region or no contribution.',
  })
  rank_in_region!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Riders ranked in the region (the rank denominator); null when unranked.',
  })
  region_rider_count!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      '"Top N%" = ceil(rank / region_rider_count * 100), 1–100; null when unranked.',
  })
  percentile!: number | null;
}
