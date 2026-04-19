import {
  IsNumber,
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class QueryNearbyDto {
  @ApiProperty({ example: 49.1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  lat!: number;

  @ApiProperty({ example: 16.75 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  lng!: number;

  @ApiProperty({ default: 5000, required: false, maximum: 50000 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(100)
  @Max(50000)
  radius?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(1)
  @Max(5)
  min_quality?: number;

  @ApiProperty({
    required: false,
    enum: ['asphalt', 'concrete', 'cobblestone', 'gravel', 'dirt'],
  })
  @IsOptional()
  @IsString()
  surface_type?: string;
}
