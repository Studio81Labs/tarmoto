import {
  IsNumber,
  IsArray,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class WeatherQueryDto {
  @ApiProperty({ example: 49.1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  lat: number;

  @ApiProperty({ example: 16.75 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  lng: number;
}

class LatLngDto {
  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;
}

export class RouteWeatherDto {
  @ApiProperty({ type: [LatLngDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => LatLngDto)
  route: LatLngDto[];
}

export type WeatherCondition =
  | 'clear'
  | 'cloudy'
  | 'rain'
  | 'storm'
  | 'snow'
  | 'fog'
  | 'ice';

export type RoadCondition = 'dry' | 'wet' | 'icy' | 'unknown';

export class WeatherResponseDto {
  @ApiProperty()
  temperature_c: number;

  @ApiProperty({
    enum: ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog', 'ice'],
  })
  condition: WeatherCondition;

  @ApiProperty()
  wind_kmh: number;

  @ApiProperty()
  precipitation_chance: number;

  @ApiProperty({ enum: ['dry', 'wet', 'icy', 'unknown'] })
  road_condition: RoadCondition;

  @ApiProperty({ example: '14°C · Dry roads · Wind 12 km/h' })
  description: string;
}

export class RouteWeatherPointDto extends WeatherResponseDto {
  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;
}

export class RouteWeatherResponseDto {
  @ApiProperty({ type: [RouteWeatherPointDto] })
  points: RouteWeatherPointDto[];

  @ApiProperty()
  has_alerts: boolean;

  @ApiProperty({ type: [String] })
  alerts: string[];
}
