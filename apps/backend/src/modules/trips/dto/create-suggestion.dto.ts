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
  // Run validation unless BOTH sides are symmetrically absent (both
  // `undefined`) or symmetrically cleared (both `null`). Anything
  // asymmetric — including a lone `lat: null` or a lone `lng: null`
  // with no paired key — should 400, so we let @IsLatitude /
  // @IsLongitude fail on the absent or null side.
  //
  //   - `{}`                              → bothUndefined → skip ✓
  //   - `{lat: null, lng: null}`          → bothNull → skip ✓
  //   - `{lat: 46, lng: 11}`              → validate → both pass ✓
  //   - `{lat: 46}` / `{lat: null}`       → validate → lng fails ✓
  //   - `{lng: 11}` / `{lng: null}`       → validate → lat fails ✓
  //   - `{lat: null, lng: 11}` / inverse  → validate → null side fails ✓
  //
  // `lat != null || lng != null` (the previous predicate) missed the
  // lone-null cases because it treated null as "not present", which
  // skipped validation and let the service silently persist
  // `location = null`.
  @ValidateIf((o: CreateSuggestionDto) => !isBalancedCoordinatePair(o))
  @IsLatitude()
  lat?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Optional map marker longitude. Must be paired with `lat` — a lone coordinate is rejected. ' +
      'Pass `null` for both `lat` and `lng` to explicitly clear the marker.',
  })
  @ValidateIf((o: CreateSuggestionDto) => !isBalancedCoordinatePair(o))
  @IsLongitude()
  lng?: number | null;
}

/**
 * True when both coordinates agree on "not supplied" — either both
 * entirely absent from the payload (`undefined`) or both explicitly
 * cleared (`null`). Returns false for mixed/asymmetric pairs so the
 * per-field validators run and fail on the out-of-pattern side.
 */
function isBalancedCoordinatePair(o: CreateSuggestionDto): boolean {
  const bothUndefined = o.lat === undefined && o.lng === undefined;
  const bothNull = o.lat === null && o.lng === null;
  return bothUndefined || bothNull;
}
