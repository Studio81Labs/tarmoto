import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BadgeProgressDto {
  @ApiProperty()
  current!: number;

  @ApiProperty()
  bronze!: number;

  @ApiProperty()
  silver!: number;

  @ApiProperty()
  gold!: number;
}

export class BadgeDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  category!: string;

  @ApiProperty({ nullable: true })
  tier!: string | null;

  @ApiPropertyOptional({ nullable: true })
  earned_at!: string | null;

  @ApiProperty()
  progress!: BadgeProgressDto;
}

export class CheckBadgesResponseDto {
  @ApiProperty({ type: [String] })
  newly_earned!: string[];
}
