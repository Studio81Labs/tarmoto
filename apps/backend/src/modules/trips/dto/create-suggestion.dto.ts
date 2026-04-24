import {
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateSuggestionDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ required: false, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Scope to a specific trip day, or omit for whole-trip scope.',
  })
  @IsOptional()
  @IsUUID()
  trip_day_id?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Optional road segment this suggestion references.',
  })
  @IsOptional()
  @IsUUID()
  road_segment_id?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Optional map marker latitude. Must be paired with `lng` — a lone coordinate is rejected.',
  })
  // Trigger validation whenever EITHER coordinate is supplied, so a
  // lone `lat` or lone `lng` fails with a 400 instead of silently
  // storing `location = null`. `@IsOptional` would short-circuit the
  // check and mask the contract violation.
  @ValidateIf(
    (o: CreateSuggestionDto) => o.lat !== undefined || o.lng !== undefined,
  )
  @IsLatitude()
  lat?: number;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Optional map marker longitude. Must be paired with `lat` — a lone coordinate is rejected.',
  })
  @ValidateIf(
    (o: CreateSuggestionDto) => o.lat !== undefined || o.lng !== undefined,
  )
  @IsLongitude()
  lng?: number;
}
