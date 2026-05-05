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
  MinLength,
} from 'class-validator';
import { Expose, Transform } from 'class-transformer';

const trim = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value,
);

export class CreateBikeDto {
  @ApiProperty({ example: 'Honda', minLength: 1 })
  @trim
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  make!: string;

  @ApiProperty({ example: 'Africa Twin', minLength: 1 })
  @trim
  @IsString()
  @MinLength(1)
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
  @trim
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  make?: string;

  @ApiProperty({ required: false, example: 'Africa Twin' })
  @IsOptional()
  @trim
  @IsString()
  @MinLength(1)
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
  isActive!: boolean;

  @ApiProperty({ nullable: true })
  photoUrl!: string | null;

  @ApiProperty({
    example: 0,
    description: 'Total kilometers recorded with this bike',
  })
  totalKm!: number;

  @ApiProperty({
    example: 0,
    description: 'Number of rides recorded with this bike',
  })
  totalRides!: number;

  @ApiProperty({ example: '2026-05-05T00:00:00Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-05-05T00:00:00Z' })
  updatedAt!: string;
}
