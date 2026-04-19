import {
  IsUUID,
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsInt,
  ValidateNested,
  ArrayMaxSize,
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

  @ApiProperty({ type: [SensorReadingDto], maxItems: 5000 })
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => SensorReadingDto)
  readings!: SensorReadingDto[];
}
