import {
  IsUUID,
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsInt,
  ValidateNested,
  ArrayMaxSize,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class SensorReadingDto {
  @ApiProperty({ description: 'Unix timestamp milliseconds' })
  @IsInt()
  t!: number;

  @ApiProperty({ description: 'Accelerometer X (m/s²)' })
  @IsNumber()
  ax!: number;

  @ApiProperty({ description: 'Accelerometer Y (m/s²)' })
  @IsNumber()
  ay!: number;

  @ApiProperty({ description: 'Accelerometer Z (m/s²)' })
  @IsNumber()
  az!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  lat?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  lng?: number;

  @ApiProperty({ required: false, description: 'Speed in m/s' })
  @IsOptional()
  @IsNumber()
  speed?: number;
}

export class UploadSensorDataDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  ride_id!: string;

  @ApiProperty({ required: false, example: 'iPhone 15 Pro' })
  @IsOptional()
  @IsString()
  device_model?: string;

  /**
   * Identifier of the on-device classifier that produced this batch's
   * window-level outputs (US-3). Optional / absent when the v0 RMS
   * heuristic on the mobile side fired (model not bundled, load
   * failed, or runtime error). Persisted on each `surface_readings`
   * row so a future deprecation can ignore older outputs.
   *
   * Constrained to `^[A-Za-z0-9._-]{1,32}$` so a malicious or buggy
   * client can't inject control characters into log lines or DB
   * indexes that key on the column.
   */
  @ApiProperty({
    required: false,
    example: 'rsc-v1.0.0',
    description:
      'Identifier of the on-device classifier that produced the labels in ' +
      'this batch. Null/absent means the v0 RMS heuristic ran instead.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'model_version must be alphanumeric with optional ._- separators',
  })
  model_version?: string;

  @ApiProperty({ type: [SensorReadingDto], maxItems: 5000 })
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => SensorReadingDto)
  readings!: SensorReadingDto[];
}
