import {
  IsNumber,
  IsArray,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WeatherQueryDto {
  @ApiProperty({ example: 49.1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  lat!: number;

  @ApiProperty({ example: 16.75 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  lng!: number;
}

class LatLngDto {
  @IsNumber()
  lat!: number;

  @IsNumber()
  lng!: number;
}

export class RouteWeatherDto {
  @ApiProperty({ type: [LatLngDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => LatLngDto)
  route!: LatLngDto[];
}

export type WeatherCondition =
  'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'fog' | 'ice';

export type RoadCondition = 'dry' | 'wet' | 'icy' | 'unknown';

export class WeatherResponseDto {
  @ApiProperty()
  temperature_c!: number;

  @ApiProperty({
    enum: ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog', 'ice'],
  })
  condition!: WeatherCondition;

  @ApiProperty()
  wind_kmh!: number;

  @ApiProperty()
  precipitation_chance!: number;

  @ApiProperty({ enum: ['dry', 'wet', 'icy', 'unknown'] })
  road_condition!: RoadCondition;

  @ApiProperty({ example: '14°C · Dry roads · Wind 12 km/h' })
  description!: string;
}

export class RouteWeatherPointDto extends WeatherResponseDto {
  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;
}

/**
 * Kind of route weather alert. Drives the icon and copy on clients;
 * `severity` controls colour and whether it qualifies for a TTS read-out.
 */
export type WeatherAlertKind = 'storm' | 'ice' | 'wet' | 'wind';

/**
 * Severity buckets the mobile banner uses to pick a colour:
 *   - `critical` (storm, ice) — red, voice-announced
 *   - `warning`  (high wind)  — orange, banner only
 *   - `info`     (wet roads)  — yellow, banner only
 */
export type WeatherAlertSeverity = 'info' | 'warning' | 'critical';

export class WeatherAlertDto {
  /**
   * Stable identifier deterministic in (kind, sample-index) so the mobile
   * client can dedupe across polls without juggling fuzzy lat/lng matches.
   */
  @ApiProperty({ example: 'storm-3' })
  id!: string;

  @ApiProperty({ enum: ['storm', 'ice', 'wet', 'wind'] })
  kind!: WeatherAlertKind;

  @ApiProperty({ enum: ['info', 'warning', 'critical'] })
  severity!: WeatherAlertSeverity;

  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;

  /**
   * Distance from the route's start (km), measured along the supplied
   * polyline. The mobile client compares this against its live progress
   * to drop alerts the rider has already passed.
   */
  @ApiProperty()
  distance_km_from_start!: number;

  /**
   * Structured temperature for wet/ice alerts. Together with `kind` and
   * `wind_kmh`, this lets clients reconstruct the sampled conditions in the
   * active locale instead of parsing the English compatibility `message`.
   */
  @ApiPropertyOptional({ example: -3 })
  temperature_c?: number;

  /**
   * Structured wind speed for wind, wet, and ice alerts. Clients use this
   * value when constructing localized copy instead of parsing the English
   * compatibility `message`.
   */
  @ApiPropertyOptional({ example: 75 })
  wind_kmh?: number;

  @ApiProperty({ example: 'Storm warning ahead' })
  title!: string;

  @ApiProperty({
    example: 'Severe storm at 49.12, 16.75 — pull over or reroute.',
  })
  message!: string;
}

export class RouteWeatherResponseDto {
  @ApiProperty({ type: [RouteWeatherPointDto] })
  points!: RouteWeatherPointDto[];

  @ApiProperty()
  has_alerts!: boolean;

  /**
   * Plain-text alert summaries kept for backwards compatibility with the
   * existing commute-status surface. `typed_alerts` is the structured
   * source the new navigation banner consumes.
   */
  @ApiProperty({ type: [String] })
  alerts!: string[];

  @ApiProperty({ type: [WeatherAlertDto] })
  typed_alerts!: WeatherAlertDto[];
}
