import {
  IsNumber,
  IsString,
  IsEnum,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const HAZARD_TYPES = [
  'pothole',
  'gravel',
  'oil_spill',
  'roadworks',
  'animals',
  'police',
  'flooding',
  'ice',
  'other',
] as const;

export type HazardType = (typeof HAZARD_TYPES)[number];

export const SEVERITY_LEVELS = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

/** Default expiry hours by hazard type */
export const EXPIRY_HOURS: Record<string, number> = {
  pothole: 72,
  gravel: 48,
  oil_spill: 24,
  roadworks: 72,
  animals: 24,
  police: 24,
  flooding: 48,
  ice: 48,
  other: 24,
};

export class CreateHazardDto {
  @ApiProperty({ example: 49.1 })
  @IsNumber()
  lat!: number;

  @ApiProperty({ example: 16.75 })
  @IsNumber()
  lng!: number;

  @ApiProperty({ enum: HAZARD_TYPES, example: 'pothole' })
  @IsEnum(HAZARD_TYPES)
  hazard_type!: HazardType;

  @ApiProperty({ enum: SEVERITY_LEVELS, default: 'medium', required: false })
  @IsOptional()
  @IsEnum(SEVERITY_LEVELS)
  severity?: Severity;

  @ApiProperty({ maxLength: 500, required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
