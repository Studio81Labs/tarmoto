import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChallengeDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  description: string;

  @ApiProperty()
  metric: string;

  @ApiProperty()
  target: number;

  @ApiProperty()
  starts_at: string;

  @ApiProperty()
  ends_at: string;

  @ApiPropertyOptional({ nullable: true })
  reward_badge_key: string | null;

  @ApiProperty()
  participant_count: number;
}

export class LeaderboardEntryDto {
  @ApiProperty()
  rank: number;

  @ApiProperty()
  user_id: string;

  @ApiProperty()
  display_name: string;

  @ApiProperty()
  progress: number;

  @ApiProperty()
  completed: boolean;
}

export class ChallengeDetailDto extends ChallengeDto {
  @ApiPropertyOptional({ nullable: true })
  my_progress: number | null;

  @ApiPropertyOptional({ nullable: true })
  my_completed: boolean | null;

  @ApiProperty({ type: [LeaderboardEntryDto] })
  leaderboard: LeaderboardEntryDto[];
}

export class JoinChallengeResponseDto {
  @ApiProperty()
  challenge_id: string;

  @ApiProperty()
  joined_at: string;
}

export class ProgressDto {
  @ApiProperty()
  challenge_id: string;

  @ApiProperty()
  progress: number;

  @ApiProperty()
  target: number;

  @ApiProperty()
  completed: boolean;

  @ApiPropertyOptional({ nullable: true })
  completed_at: string | null;

  @ApiProperty()
  percent: number;
}
