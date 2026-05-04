import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The three preset options US-7 ships with. They are also the
 * `id` values returned in the response's `options[]`, and the value the
 * caller passes back as `option` to re-generate with a different bias.
 */
export const TRIP_GENERATION_OPTIONS = [
  'best-fit',
  'scenic',
  'fastest',
] as const;
export type TripGenerationOptionId = (typeof TRIP_GENERATION_OPTIONS)[number];

/**
 * Surface tags allowed on the per-request `surfaces` filter. Mirrors the
 * `road_segments.surface_type` vocabulary. Kept narrow on purpose — only
 * the surfaces a rider would realistically want to *include*.
 */
export const ALLOWED_SURFACES = [
  'asphalt',
  'concrete',
  'cobblestone',
  'gravel',
  'dirt',
] as const;
export type AllowedSurface = (typeof ALLOWED_SURFACES)[number];

export class LatLngDto {
  @ApiProperty({ minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;
}

/**
 * Body of `POST /trips/:tripId/generate`.
 *
 * `start_location` is required: every option's first day starts here.
 * `bbox` is optional — when omitted, the generator uses the bbox of the
 * trip's persisted region (when it matches a known region slug) or a
 * sensible default radius around the start. Avoidance flags and the
 * surface filter are per-request rather than persisted on the Trip so a
 * collaborator can experiment without mutating shared trip metadata.
 */
export class GenerateTripDto {
  @ApiProperty({ type: LatLngDto })
  @ValidateNested()
  @Type(() => LatLngDto)
  start_location!: LatLngDto;

  /**
   * Optional bbox in `west,south,east,north` lng/lat order. When
   * omitted, the generator falls back to the trip's region (looked up in
   * the shared `regions` catalog) or a default ~150km radius around
   * `start_location`.
   */
  @ApiProperty({
    required: false,
    description: 'Bounding box: west,south,east,north (lng/lat in WGS84)',
    example: '11.0,46.0,12.5,47.0',
  })
  @IsOptional()
  @IsString()
  @Matches(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, {
    message: 'bbox must be 4 comma-separated numbers',
  })
  bbox?: string;

  /**
   * Which preset to persist. The other two presets are still computed
   * and returned in the response's `options[]` so the UI can compare
   * side-by-side without an extra round-trip. Default: `best-fit`.
   */
  @ApiProperty({ required: false, enum: TRIP_GENERATION_OPTIONS })
  @IsOptional()
  @IsIn(TRIP_GENERATION_OPTIONS)
  option?: TripGenerationOptionId;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  avoid_highways?: boolean;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  avoid_tolls?: boolean;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  avoid_unpaved?: boolean;

  @ApiProperty({
    required: false,
    enum: ALLOWED_SURFACES,
    isArray: true,
    description:
      'Allowed surfaces. When omitted, all paved surfaces are allowed; ' +
      '`avoid_unpaved=true` additionally drops gravel/dirt.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(ALLOWED_SURFACES.length)
  @IsIn(ALLOWED_SURFACES, { each: true })
  surfaces?: AllowedSurface[];
}
