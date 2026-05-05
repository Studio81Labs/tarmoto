import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Expose } from 'class-transformer';

export class CreateBikeDto {
  @ApiProperty({ example: 'Honda' })
  @IsString()
  @MaxLength(100)
  make!: string;

  @ApiProperty({ example: 'Africa Twin' })
  @IsString()
  @MaxLength(100)
  model!: string;

  @ApiProperty({ required: false, example: 2024 })
  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  year?: number;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  @Expose({ name: 'isActive' })
  is_active?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  @Expose({ name: 'photoUrl' })
  photo_url?: string;
}

export class UpdateBikeDto {
  @ApiProperty({ required: false, example: 'Honda' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  make?: string;

  @ApiProperty({ required: false, example: 'Africa Twin' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @ApiProperty({ required: false, example: 2024 })
  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  year?: number;

  @ApiProperty({ required: false, example: true })
  @IsOptional()
  @IsBoolean()
  @Expose({ name: 'isActive' })
  is_active?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  @Expose({ name: 'photoUrl' })
  photo_url?: string;
}

export class BikeDto {
  @ApiProperty({ example: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Honda' })
  make!: string;

  @ApiProperty({ example: 'Africa Twin' })
  model!: string;

  @ApiProperty({ nullable: true, example: 2024 })
  year!: number | null;

  @ApiProperty({ example: true })
  is_active!: boolean;

  @ApiProperty({ nullable: true })
  photo_url!: string | null;

  @ApiProperty({
    example: 0,
    description: 'Total kilometers recorded with this bike',
  })
  total_km!: number;

  @ApiProperty({
    example: 0,
    description: 'Number of rides recorded with this bike',
  })
  total_rides!: number;

  @ApiProperty({ example: '2026-05-05T00:00:00Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-05T00:00:00Z' })
  updated_at!: string;
}
