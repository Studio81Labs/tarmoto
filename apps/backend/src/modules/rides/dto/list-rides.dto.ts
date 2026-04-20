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
    description: 'ISO 8601 date (inclusive end-of-day)',
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

  @ApiProperty({ required: false, enum: SORTABLE })
  @IsOptional()
  @IsIn(SORTABLE as unknown as string[])
  sort?: RidesSortField;

  @ApiProperty({ required: false, enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}
