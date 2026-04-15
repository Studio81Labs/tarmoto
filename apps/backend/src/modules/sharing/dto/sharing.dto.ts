import { IsBoolean, IsOptional, IsNumber, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class ToggleShareDto {
  @ApiProperty({ description: 'Whether the ride should be publicly visible' })
  @IsBoolean()
  is_public: boolean;
}

export class CommunityRidesQueryDto {
  @ApiProperty({ description: 'Latitude of search center' })
  @IsNumber()
  @Type(() => Number)
  lat: number;

  @ApiProperty({ description: 'Longitude of search center' })
  @IsNumber()
  @Type(() => Number)
  lng: number;

  @ApiPropertyOptional({
    description: 'Search radius in km',
    default: 25,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  radius_km?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(50)
  limit?: number;
}

export class SharedRideResponseDto {
  @ApiProperty()
  share_token: string;

  @ApiProperty()
  is_public: boolean;

  @ApiProperty()
  share_url: string;
}

export class SharedRideDetailDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  rider_name: string;

  @ApiProperty()
  ride_type: string;

  @ApiProperty()
  started_at: string;

  @ApiProperty({ nullable: true })
  ended_at: string | null;

  @ApiProperty({ nullable: true })
  distance_km: number | null;

  @ApiProperty({ nullable: true })
  avg_speed: number | null;

  @ApiProperty({ nullable: true })
  max_speed: number | null;

  @ApiProperty({ nullable: true })
  avg_road_quality: number | null;

  @ApiProperty({ nullable: true })
  duration_min: number | null;

  @ApiProperty({ nullable: true, type: [Object] })
  route_geometry: Array<{ lat: number; lng: number }> | null;
}

export class CommunityRideDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  share_token: string;

  @ApiProperty()
  rider_name: string;

  @ApiProperty()
  ride_type: string;

  @ApiProperty()
  started_at: string;

  @ApiProperty({ nullable: true })
  distance_km: number | null;

  @ApiProperty({ nullable: true })
  avg_speed: number | null;

  @ApiProperty({ nullable: true })
  avg_road_quality: number | null;

  @ApiProperty({ nullable: true })
  duration_min: number | null;
}
