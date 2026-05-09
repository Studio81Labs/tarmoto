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

export class CreateTripDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ minimum: 1, maximum: 30 })
  @IsInt()
  @Min(1)
  @Max(30)
  num_days!: number;

  @ApiProperty({ required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  region?: string;

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

  /**
   * US-37 — file the new trip into one of the caller's folders. Used by
   * the companion's "Duplicate" action so a duplicated trip stays in
   * the same folder as the original. The DTO accepts the field at
   * create time because the global `ValidationPipe`
   * (`forbidNonWhitelisted: true`) would otherwise 400 every duplicate
   * of a filed trip.
   */
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Optional folder uuid to file the new trip under. Must belong to the caller; cross-user references 404.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  folder_id?: string | null;
}
