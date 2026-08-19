import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * The three dimensions ranked by the regional leaderboards endpoint.
 *
 * Names mirror the badge metric keys (`total_distance`, `roads_discovered`,
 * `hazards_reported`) that already drive the gamification dashboard, with
 * the explicit `_km` suffix on distance so the unit is unambiguous in the
 * API surface (the backend stores metric units, so distance is always km).
 */
export type LeaderboardDimension =
  'total_distance_km' | 'roads_discovered' | 'hazards_reported';

export class RegionalLeaderboardEntryDto {
  @ApiProperty()
  rank!: number;

  @ApiProperty()
  user_id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty({ nullable: true })
  home_region!: string | null;

  @ApiProperty({
    description:
      'Score in the dimension unit (km for total_distance_km, count for the others).',
  })
  value!: number;
}

export class DimensionLeaderboardDto {
  @ApiProperty({
    enum: ['total_distance_km', 'roads_discovered', 'hazards_reported'],
  })
  dimension!: LeaderboardDimension;

  @ApiProperty({
    description: 'Unit label for `value` (`km`, `roads`, `reports`).',
  })
  unit!: string;

  @ApiProperty({ type: [RegionalLeaderboardEntryDto] })
  entries!: RegionalLeaderboardEntryDto[];

  @ApiProperty({
    type: RegionalLeaderboardEntryDto,
    nullable: true,
    description:
      "Signed-in rider's row in this dimension, even when outside the top N. " +
      'Null when the rider has no progress in this dimension or is anonymous.',
  })
  me!: RegionalLeaderboardEntryDto | null;
}

export class RegionalLeaderboardsResponseDto {
  @ApiProperty({
    nullable: true,
    description:
      'The region filter that was applied (case-insensitive trimmed match against ' +
      '`users.home_region`). Null when no region filter was applied (global ranking).',
  })
  region!: string | null;

  @ApiProperty({
    description:
      'When this snapshot was computed. Leaderboards are computed on-demand, ' +
      'so this is the response timestamp.',
  })
  generated_at!: string;

  @ApiProperty()
  total_distance_km!: DimensionLeaderboardDto;

  @ApiProperty()
  roads_discovered!: DimensionLeaderboardDto;

  @ApiProperty()
  hazards_reported!: DimensionLeaderboardDto;
}

export class RegionalLeaderboardsQueryDto {
  /**
   * Region filter — matched case-insensitively against the trimmed
   * `users.home_region` column. Free text rather than an enum because
   * `home_region` is rider-supplied. Omit for a global leaderboard.
   */
  @ApiPropertyOptional({
    description:
      'Filter to riders whose `home_region` matches (case-insensitive, ' +
      'trimmed). Omit for a global ranking.',
    example: 'Beskydy',
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  region?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Top-N rows returned per dimension.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
