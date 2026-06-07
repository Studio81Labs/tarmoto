import { IsNumber, IsOptional, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class FollowUserResponseDto {
  @ApiProperty()
  following_id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty()
  followed_at!: string;
}

export class FollowerDto {
  @ApiProperty()
  user_id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty()
  followed_at!: string;
}

export class FollowingDto {
  @ApiProperty()
  user_id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty()
  followed_at!: string;
}

export class FeedQueryDto {
  @ApiPropertyOptional({ description: 'Latitude to filter rides by location' })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  lat?: number;

  @ApiPropertyOptional({
    description: 'Longitude to filter rides by location',
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  lng?: number;

  @ApiPropertyOptional({
    description: 'Search radius in km (requires lat/lng)',
    default: 50,
    minimum: 1,
    maximum: 200,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(200)
  radius_km?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(50)
  limit?: number;
}

export class FeedRideDto {
  @ApiProperty()
  ride_id!: string;

  @ApiProperty()
  share_token!: string;

  @ApiProperty()
  rider_id!: string;

  @ApiProperty()
  rider_name!: string;

  @ApiProperty()
  ride_type!: string;

  @ApiProperty()
  started_at!: string;

  @ApiProperty({ nullable: true })
  distance_km!: number | null;

  @ApiProperty({ nullable: true })
  avg_speed!: number | null;

  @ApiProperty({ nullable: true })
  avg_road_quality!: number | null;

  @ApiProperty({ nullable: true })
  duration_min!: number | null;
}

export class SuggestedRiderDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty({ nullable: true })
  avatar_url!: string | null;

  @ApiProperty({ nullable: true })
  home_region!: string | null;

  @ApiProperty({ description: 'Number of rides the rider has recorded.' })
  ride_count!: number;
}
