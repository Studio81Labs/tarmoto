import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BADGE_KEYS,
  CHALLENGE_CONTENT_KEYS,
  type BadgeKey,
  type ChallengeContentKey,
} from '@tarmoto/shared';

export class ChallengeDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    enum: CHALLENGE_CONTENT_KEYS,
    description: 'Stable client-catalog key for challenge title and copy.',
  })
  content_key!: ChallengeContentKey;

  @ApiProperty()
  metric!: string;

  @ApiProperty()
  target!: number;

  @ApiProperty()
  starts_at!: string;

  @ApiProperty()
  ends_at!: string;

  @ApiProperty({ enum: BADGE_KEYS, nullable: true })
  reward_badge_key!: BadgeKey | null;

  @ApiProperty()
  participant_count!: number;
}

export class LeaderboardEntryDto {
  @ApiProperty()
  rank!: number;

  @ApiProperty()
  user_id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty()
  progress!: number;

  @ApiProperty()
  completed!: boolean;
}

export class ChallengeDetailDto extends ChallengeDto {
  @ApiProperty({ nullable: true })
  my_progress!: number | null;

  @ApiProperty({ nullable: true })
  my_completed!: boolean | null;

  @ApiProperty({ type: [LeaderboardEntryDto] })
  leaderboard!: LeaderboardEntryDto[];
}

export class JoinChallengeResponseDto {
  @ApiProperty()
  challenge_id!: string;

  @ApiProperty()
  joined_at!: string;
}

export class ProgressDto {
  @ApiProperty()
  challenge_id!: string;

  @ApiProperty()
  progress!: number;

  @ApiProperty()
  target!: number;

  @ApiProperty()
  completed!: boolean;

  @ApiPropertyOptional({ nullable: true })
  completed_at!: string | null;

  @ApiProperty()
  percent!: number;
}
