import { IsNumber, IsOptional, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class ExplorationStatsDto {
  @ApiProperty()
  ridden_segments: number;

  @ApiProperty()
  total_segments: number;

  @ApiProperty()
  percent_explored: number;

  @ApiProperty()
  total_distance_km: number;
}

export class NearbyUnriddenQueryDto {
  @ApiProperty()
  @IsNumber()
  @Type(() => Number)
  lat: number;

  @ApiProperty()
  @IsNumber()
  @Type(() => Number)
  lng: number;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(50)
  radius_km?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(50)
  limit?: number;
}

export class UnriddenSegmentDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ nullable: true })
  road_name: string | null;

  @ApiProperty()
  length_m: number;

  @ApiProperty({ nullable: true })
  quality_score: number | null;

  @ApiProperty()
  surface_type: string;

  @ApiProperty()
  distance_m: number;
}

export class RiddenSegmentIdsDto {
  @ApiProperty({ type: [String] })
  segment_ids: string[];
}
