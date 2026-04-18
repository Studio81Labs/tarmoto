import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export type PassStatus = 'open' | 'closed' | 'unknown';

export class MountainPassDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'ISO 3166-1 alpha-2 country code' })
  country_code: string;

  @ApiProperty({ nullable: true })
  region: string | null;

  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;

  @ApiProperty()
  elevation_m: number;

  @ApiProperty({ description: '1=January .. 12=December (inclusive)' })
  typical_open_month: number;

  @ApiProperty({ description: '1=January .. 12=December (inclusive)' })
  typical_close_month: number;

  @ApiProperty({ enum: ['open', 'closed', 'unknown'] })
  status: PassStatus;

  @ApiProperty({
    description:
      'True when status comes from a manual override rather than the typical schedule.',
  })
  status_overridden: boolean;

  @ApiProperty({ nullable: true })
  notes: string | null;

  @ApiProperty()
  last_updated: string;
}

export class ListPassesQueryDto {
  /**
   * Bounding box "minLng,minLat,maxLng,maxLat". When omitted the
   * endpoint returns the entire seeded set — fine for now (we only
   * have a few dozen passes); when the dataset grows the bbox becomes
   * the recommended path.
   */
  @ApiPropertyOptional({
    description:
      'Bounding box filter "minLng,minLat,maxLng,maxLat". Omit to list all.',
    example: '5,45,17,49',
  })
  @IsOptional()
  @IsString()
  @Matches(/^-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?){3}$/, {
    message: 'bbox must be "minLng,minLat,maxLng,maxLat"',
  })
  bbox?: string;
}

class RoutePointDto {
  @ApiProperty()
  @IsLatitude()
  @Type(() => Number)
  lat: number;

  @ApiProperty()
  @IsLongitude()
  @Type(() => Number)
  lng: number;
}

export class CheckRouteDto {
  @ApiProperty({ type: [RoutePointDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => RoutePointDto)
  route: RoutePointDto[];

  @ApiPropertyOptional({
    default: 1500,
    minimum: 100,
    maximum: 20000,
    description:
      'Buffer in meters around the route to consider a pass "on it".',
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(100)
  @Max(20000)
  buffer_m?: number;
}

export class CheckRouteResponseDto {
  @ApiProperty({ type: [MountainPassDto] })
  passes: MountainPassDto[];

  @ApiProperty({
    description: 'Count of passes on the route currently closed.',
  })
  closed_count: number;

  @ApiProperty({ description: 'Count of passes whose status is unknown.' })
  unknown_count: number;
}
