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
  @IsOptional()
  @IsLatitude()
  @ValidateIf((o: CreateSuggestionDto) => o.lng !== undefined)
  lat?: number;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Optional map marker longitude. Must be paired with `lat` — a lone coordinate is rejected.',
  })
  @IsOptional()
  @IsLongitude()
  @ValidateIf((o: CreateSuggestionDto) => o.lat !== undefined)
  lng?: number;
}
