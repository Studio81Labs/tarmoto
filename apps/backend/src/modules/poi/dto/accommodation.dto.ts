import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { ACCOMMODATION_KINDS, type AccommodationKind } from '@tarmoto/shared';
import { toOptionalNumber } from '../../../common/dto-transforms.js';

const DEFAULT_RADIUS_KM = 5;
const MAX_RADIUS_KM = 25;

/**
 * Turn a `kinds=hotel,camp_site` query string into a deduplicated
 * array. Tolerates repeated params and whitespace. Unknown tokens are
 * preserved so the downstream `@IsIn` validator rejects the request
 * with a 400 — we'd rather be loud about `?kinds=bogus` than silently
 * broaden the query into "all kinds" and mislead the caller. Returns
 * `undefined` only when the param is truly absent; an explicit empty
 * value becomes `[]` so `@ArrayNotEmpty()` can flag it.
 *
 * Deliberately stricter than the sibling helper in
 * `point-of-interest.dto.ts`, which is lenient for historic reasons.
 * New endpoints should prefer this behaviour.
 */
function parseKinds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const kinds = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    for (const token of item.split(',')) {
      const trimmed = token.trim();
      if (trimmed) kinds.add(trimmed);
    }
  }
  return Array.from(kinds);
}

export class AccommodationQueryDto {
  @ApiProperty({ example: 49.1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ example: 16.75 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @ApiProperty({
    example: DEFAULT_RADIUS_KM,
    required: false,
    description: `Search radius in km (defaulted to ${DEFAULT_RADIUS_KM}, capped at ${MAX_RADIUS_KM} by the service).`,
  })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  radius_km?: number;

  @ApiProperty({
    enum: ACCOMMODATION_KINDS,
    isArray: true,
    required: false,
    description:
      'Kinds to include. Omit to return all kinds. Accepts a repeated ' +
      'query param (`kinds=hotel&kinds=camp_site`) or a comma-separated ' +
      'value (`kinds=hotel,camp_site`).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseKinds(value))
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(ACCOMMODATION_KINDS, { each: true })
  kinds?: AccommodationKind[];

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 5,
    description:
      'Keep only accommodations whose reported star rating is at least ' +
      'this value (1..5). Entries with no star rating are dropped when ' +
      'this filter is active so the response never mixes "no rating" in ' +
      'with ratings the rider explicitly asked for.',
  })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsInt()
  @Min(1)
  @Max(5)
  min_stars?: number;
}

export class AccommodationDto {
  @ApiProperty()
  external_id!: string;

  @ApiProperty({ nullable: true })
  name!: string | null;

  @ApiProperty({ enum: ACCOMMODATION_KINDS })
  kind!: AccommodationKind;

  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;

  @ApiProperty({ description: 'Distance from the anchor point, km.' })
  distance_km!: number;

  @ApiProperty({ nullable: true })
  website!: string | null;

  @ApiProperty({ nullable: true })
  phone!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Hotel star rating 1..5 when the provider reports one.',
  })
  stars!: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Raw OSM `opening_hours` (reception hours) when tagged.',
  })
  opening_hours!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Street line (street + number).',
  })
  address_street!: string | null;

  @ApiProperty({ nullable: true })
  address_city!: string | null;

  @ApiProperty({ nullable: true })
  address_postcode!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'ISO 3166-1 alpha-2 country code.',
  })
  address_country!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Canonical OpenStreetMap detail URL — the "view source" link and ' +
      'ODbL attribution target.',
  })
  osm_url!: string | null;

  @ApiProperty({
    description:
      'Google Maps deep link (photos / reviews), built from name + coords ' +
      '— no API key or call.',
  })
  maps_url!: string;
}

export class AccommodationListDto {
  @ApiProperty({ type: [AccommodationDto] })
  accommodations!: AccommodationDto[];

  @ApiProperty({ description: 'Radius actually used for the lookup, km.' })
  radius_km!: number;

  @ApiProperty({
    enum: ACCOMMODATION_KINDS,
    isArray: true,
    description: 'Kinds that were actually queried for this response.',
  })
  kinds!: AccommodationKind[];
}

export { DEFAULT_RADIUS_KM, MAX_RADIUS_KM };
