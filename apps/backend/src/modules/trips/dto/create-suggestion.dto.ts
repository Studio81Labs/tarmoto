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
      'Optional map marker latitude. Must be paired with `lng` — a lone coordinate is rejected. ' +
      'Pass `null` for both `lat` and `lng` to explicitly clear the marker.',
  })
  // Trigger validation only when at least one coordinate is a real
  // VALUE (not missing, not null). That way:
  //   - `{}` or `{lat: null, lng: null}`  → skipped → "no marker" ✓
  //   - `{lat: 46, lng: 11}`              → both validated ✓
  //   - `{lat: 46}` / `{lat: null, lng: 11}` → the missing/null side
  //     fails @IsLatitude/@IsLongitude and the request is 400'd
  //
  // The previous `!== undefined` guard spuriously fired on an explicit
  // null pair — which the OpenAPI contract describes as a valid
  // "clear the marker" payload — and forced clients to elide the
  // keys entirely.
  @ValidateIf((o: CreateSuggestionDto) => o.lat != null || o.lng != null)
  @IsLatitude()
  lat?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Optional map marker longitude. Must be paired with `lat` — a lone coordinate is rejected. ' +
      'Pass `null` for both `lat` and `lng` to explicitly clear the marker.',
  })
  @ValidateIf((o: CreateSuggestionDto) => o.lat != null || o.lng != null)
  @IsLongitude()
  lng?: number | null;
}
