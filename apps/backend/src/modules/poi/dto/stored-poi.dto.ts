import {
  ArrayMinSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { toOptionalNumber } from '../../../common/dto-transforms.js';
import { DEFAULT_BUFFER_KM, MAX_BUFFER_KM } from './point-of-interest.dto.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * Coerce a required numeric query param. A blank / whitespace / null value
 * becomes NaN so `@IsNumber` rejects it, rather than `Number('')` → 0
 * silently validating `?min_lng=` as the prime meridian.
 */
function toRequiredNumber(value: unknown): number {
  if (value === null) return Number.NaN;
  if (typeof value === 'string' && value.trim() === '') return Number.NaN;
  return Number(value);
}

/**
 * Parse `kinds=fuel_station,restaurant` (repeated param or comma-joined)
 * into a deduped string[]. The store `kind` is the free-form OSM import
 * superset (fast_food, rest_area, ice_cream, accommodation kinds, …), not
 * the live `POI_KINDS` enum, so this stays unconstrained on purpose.
 */
function parseKindStrings(value: unknown): string[] | undefined {
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
  return kinds.size === 0 ? undefined : Array.from(kinds);
}

/**
 * Query for `GET /poi/in-bbox`. Four typed corner params (not a single
 * `bbox` string) so class-validator range-checks each coordinate; the
 * service enforces min < max.
 */
export class InBboxQueryDto {
  @ApiProperty({ example: 18.0 })
  @Transform(({ value }: { value: unknown }) => toRequiredNumber(value))
  @IsNumber()
  @Min(-180)
  @Max(180)
  min_lng!: number;

  @ApiProperty({ example: 49.3 })
  @Transform(({ value }: { value: unknown }) => toRequiredNumber(value))
  @IsNumber()
  @Min(-90)
  @Max(90)
  min_lat!: number;

  @ApiProperty({ example: 18.9 })
  @Transform(({ value }: { value: unknown }) => toRequiredNumber(value))
  @IsNumber()
  @Min(-180)
  @Max(180)
  max_lng!: number;

  @ApiProperty({ example: 49.75 })
  @Transform(({ value }: { value: unknown }) => toRequiredNumber(value))
  @IsNumber()
  @Min(-90)
  @Max(90)
  max_lat!: number;

  @ApiPropertyOptional({
    isArray: true,
    description:
      'Store kinds to include (e.g. `fuel_station,restaurant`). Free-form — ' +
      'the store `kind` is the OSM import superset, not the live enum. Omit ' +
      'to return every kind in the box.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseKindStrings(value))
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  kinds?: string[];

  @ApiPropertyOptional({
    default: DEFAULT_LIMIT,
    maximum: MAX_LIMIT,
    description: `Max rows to return (default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}).`,
  })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
}

/**
 * A POI served from the offline `pois` store. Unlike `PoiDto` there is no
 * anchor, so no `distance_km`; it carries provenance (`source`,
 * `last_imported_at`) and every decision-support field so a map popup / detail
 * view can render without a second call.
 */
export class StoredPoiDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Provider layer, e.g. `osm`.' })
  source!: string;

  @ApiProperty()
  external_id!: string;

  @ApiProperty({ nullable: true })
  name!: string | null;

  @ApiProperty({ description: 'OSM import kind (superset of the live enum).' })
  kind!: string;

  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;

  @ApiProperty({ nullable: true })
  website!: string | null;

  @ApiProperty({ nullable: true })
  phone!: string | null;

  @ApiProperty({ nullable: true })
  opening_hours!: string | null;

  @ApiProperty({ nullable: true })
  address_street!: string | null;

  @ApiProperty({ nullable: true })
  address_city!: string | null;

  @ApiProperty({ nullable: true })
  address_postcode!: string | null;

  @ApiProperty({ nullable: true })
  address_country!: string | null;

  @ApiProperty({ nullable: true })
  cuisine!: string | null;

  @ApiProperty({ nullable: true })
  brand!: string | null;

  @ApiProperty({ nullable: true })
  stars!: number | null;

  @ApiProperty({ nullable: true, description: 'OSM detail / attribution URL.' })
  osm_url!: string | null;

  @ApiProperty({
    description:
      'Google Maps deep link (photos / reviews); no API key or call.',
  })
  maps_url!: string;

  @ApiProperty({
    description: 'When the import last wrote this row (ISO 8601).',
  })
  last_imported_at!: string;
}

export class StoredPoiListDto {
  @ApiProperty({ type: [StoredPoiDto] })
  pois!: StoredPoiDto[];

  @ApiProperty({ description: 'Number of rows returned.' })
  count!: number;
}

class CorridorRoutePointDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => toRequiredNumber(value))
  @IsLatitude()
  lat!: number;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => toRequiredNumber(value))
  @IsLongitude()
  lng!: number;
}

/**
 * Body for `POST /poi/in-corridor` — stored POIs within `buffer_km` of a route
 * polyline. POST (not GET) so a long polyline can't overflow the URL, matching
 * `/poi/along-route` and `/passes/check-route`.
 */
export class CorridorBodyDto {
  @ApiProperty({ type: [CorridorRoutePointDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => CorridorRoutePointDto)
  route!: CorridorRoutePointDto[];

  @ApiPropertyOptional({
    default: DEFAULT_BUFFER_KM,
    maximum: MAX_BUFFER_KM,
    description: `Corridor half-width in km (default ${DEFAULT_BUFFER_KM}, capped at ${MAX_BUFFER_KM}).`,
  })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Max(MAX_BUFFER_KM)
  buffer_km?: number;

  @ApiPropertyOptional({
    isArray: true,
    description:
      'Store kinds to include (free-form OSM import superset). Omit for all.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseKindStrings(value))
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  kinds?: string[];
}

/** A stored POI matched against a route corridor — adds the route-relative
 * distances the STOPS tab renders (how far along, how far off). */
export class StoredCorridorPoiDto extends StoredPoiDto {
  @ApiProperty({ description: 'Distance from the route start to the POI, km.' })
  distance_along_route_km!: number;

  @ApiProperty({
    description: 'Shortest distance from the POI to the route line, km.',
  })
  distance_from_route_km!: number;
}

export class StoredCorridorListDto {
  @ApiProperty({ type: [StoredCorridorPoiDto] })
  pois!: StoredCorridorPoiDto[];

  @ApiProperty({ description: 'Buffer actually used for the lookup, km.' })
  buffer_km!: number;

  @ApiProperty({ description: 'Number of rows returned.' })
  count!: number;
}

export { DEFAULT_LIMIT, MAX_LIMIT };
