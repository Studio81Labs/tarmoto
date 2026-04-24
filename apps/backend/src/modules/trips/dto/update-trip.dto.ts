import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  IsIn,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const ROAD_PREFERENCES = ['curvy', 'scenic', 'fast', 'mixed'] as const;
const TRIP_STATUSES = ['draft', 'planned', 'active', 'completed'] as const;

/**
 * All fields optional — the PATCH endpoint applies whichever are
 * supplied, leaving the rest untouched. Validation runs against the
 * effective post-patch row in the service (e.g. `daily_km_min` vs
 * `daily_km_max`) so partial updates can't land an invalid pairing.
 */
export class UpdateTripDto {
  @ApiProperty({ required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiProperty({ required: false, nullable: true, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  region?: string | null;

  @ApiProperty({ required: false, minimum: 1, maximum: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  num_days?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  min_quality?: number;

  @ApiProperty({ required: false, enum: ROAD_PREFERENCES })
  @IsOptional()
  @IsIn(ROAD_PREFERENCES as unknown as string[])
  road_preference?: (typeof ROAD_PREFERENCES)[number];

  @ApiProperty({ required: false, minimum: 1, maximum: 1000 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000)
  daily_km_min?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 1000 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000)
  daily_km_max?: number;

  @ApiProperty({ required: false, enum: TRIP_STATUSES })
  @IsOptional()
  @IsIn(TRIP_STATUSES as unknown as string[])
  status?: (typeof TRIP_STATUSES)[number];
}
