import {
  IsNumber,
  IsString,
  IsEnum,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { HAZARD_EXPIRY_HOURS } from '@tarmoto/shared';
import { IsHazardPhotoUrl } from './hazard-photo.dto.js';

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

/**
 * Default expiry hours by hazard type. Single-sourced in `@tarmoto/shared`
 * (`HAZARD_EXPIRY_HOURS`) so the mobile offline queue expires reports held
 * longer than their hazard's lifetime; re-exported here under the name the
 * backend has always used.
 */
export const EXPIRY_HOURS = HAZARD_EXPIRY_HOURS;

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

  @ApiProperty({
    required: false,
    description:
      'URL of a hazard photo hosted on Tarmoto media storage. Use ' +
      'POST /hazards/photos to obtain this URL.',
  })
  @IsOptional()
  @IsHazardPhotoUrl()
  photo_url?: string;
}
