import {
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

class LatLngDto {
  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;
}

export class CreateCommuteRouteDto {
  @ApiProperty({ default: 'Default', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({ type: LatLngDto })
  @ValidateNested()
  @Type(() => LatLngDto)
  origin: LatLngDto;

  @ApiProperty({ type: LatLngDto })
  @ValidateNested()
  @Type(() => LatLngDto)
  destination: LatLngDto;
}

export class CommuteStatsQueryDto {
  @ApiProperty({ enum: ['week', 'month'], default: 'week', required: false })
  @IsOptional()
  @IsEnum(['week', 'month'])
  period?: 'week' | 'month';
}

export class CommuteRouteResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: LatLngDto })
  origin: { lat: number; lng: number };

  @ApiProperty({ type: LatLngDto })
  destination: { lat: number; lng: number };

  @ApiProperty({ nullable: true })
  distance_km: number | null;

  @ApiProperty({ nullable: true })
  avg_quality: number | null;

  @ApiProperty()
  is_primary: boolean;

  @ApiProperty()
  created_at: string;
}

export class CommuteStatusResponseDto {
  @ApiProperty({ type: CommuteRouteResponseDto })
  route: CommuteRouteResponseDto;

  @ApiProperty()
  hazard_count: number;

  @ApiProperty({ nullable: true })
  route_quality: number | null;

  @ApiProperty({
    enum: ['clear', 'hazards', 'weather_warning', 'delays'],
  })
  status: string;
}

class DailyBreakdownDto {
  @ApiProperty()
  date: string;

  @ApiProperty()
  rides: number;

  @ApiProperty()
  km: number;

  @ApiProperty()
  duration_min: number;
}

export class CommuteStatsResponseDto {
  @ApiProperty()
  period: string;

  @ApiProperty()
  total_rides: number;

  @ApiProperty()
  total_km: number;

  @ApiProperty()
  total_time_min: number;

  @ApiProperty()
  avg_duration_min: number;

  @ApiProperty()
  fuel_estimate_l: number;

  @ApiProperty({ type: [DailyBreakdownDto] })
  daily_breakdown: DailyBreakdownDto[];
}
