import {
  IsOptional,
  IsString,
  IsInt,
  IsIn,
  Min,
  Max,
  IsISO8601,
  IsNumber,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { toOptionalNumber } from '../../../common/dto-transforms.js';

const SORTABLE = [
  'started_at',
  'distance_km',
  'duration_min',
  'avg_road_quality',
] as const;
export type RidesSortField = (typeof SORTABLE)[number];

export class ListRidesDto {
  @ApiProperty({ default: 20, required: false, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiProperty({ default: 0, required: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiProperty({
    required: false,
    enum: ['free', 'commute', 'trip', 'tracked'],
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiProperty({ required: false, description: 'ISO 8601 date (inclusive)' })
  @IsOptional()
  @IsISO8601()
  started_from?: string;

  @ApiProperty({
    required: false,
    description:
      'ISO 8601 upper bound. A date (YYYY-MM-DD) is inclusive end-of-day; ' +
      'a full timestamp is an exact `<=` instant bound (no end-of-day widening).',
  })
  @IsOptional()
  @IsISO8601()
  started_to?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(0)
  min_distance_km?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(0)
  max_distance_km?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(1)
  @Max(5)
  min_quality?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(1)
  @Max(5)
  max_quality?: number;

  @ApiProperty({
    required: false,
    description: 'Case-insensitive substring match against ride name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiProperty({
    required: false,
    minimum: -90,
    maximum: 90,
    description:
      'Latitude of a reference point. Combined with near_lng + near_km, ' +
      'filters to rides whose route passes within near_km of the point. ' +
      'All three near_* params must be supplied together.',
  })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(-90)
  @Max(90)
  near_lat?: number;

  @ApiProperty({
    required: false,
    minimum: -180,
    maximum: 180,
    description: 'Longitude of the reference point. See near_lat.',
  })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(-180)
  @Max(180)
  near_lng?: number;

  @ApiProperty({
    required: false,
    minimum: 0.1,
    maximum: 200,
    description:
      'Proximity radius in kilometres for the near_lat/near_lng filter.',
  })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(0.1)
  @Max(200)
  near_km?: number;

  @ApiProperty({ required: false, enum: SORTABLE })
  @IsOptional()
  @IsIn(SORTABLE)
  sort?: RidesSortField;

  @ApiProperty({ required: false, enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}
