import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  IsIn,
  ValidateIf,
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
  @IsIn(ROAD_PREFERENCES)
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
  @IsIn(TRIP_STATUSES)
  status?: (typeof TRIP_STATUSES)[number];

  /**
   * US-37 — assign or unassign the trip's folder. Pass a folder UUID to
   * move the trip into a folder, or `null` to mark it unfiled. Omit the
   * field to leave the assignment untouched.
   */
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Folder uuid to move the trip into, or `null` to unfile it. Omit to leave unchanged.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  folder_id?: string | null;
}
