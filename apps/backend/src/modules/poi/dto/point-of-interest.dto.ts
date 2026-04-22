import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { toOptionalNumber } from '../../../common/dto-transforms.js';

/**
 * Kinds of along-route POIs the mobile app surfaces in the trip-day view.
 * Mirrors the OSM tag subset we accept — anything outside this list is
 * dropped at the provider layer so client code doesn't need to deal with
 * unknown kinds. Kept deliberately small (restaurants + viewpoints + cafés
 * + fuel stations) because these are the kinds the spec calls out for
 * US-10 pit-stop suggestions and US-36 fuel-stop markers; the mobile card
 * stays scannable with glove-sized rows.
 */
export const POI_KINDS = [
  'restaurant',
  'viewpoint',
  'cafe',
  'fuel_station',
] as const;

export type PoiKind = (typeof POI_KINDS)[number];

const DEFAULT_RADIUS_KM = 5;
const MAX_RADIUS_KM = 25;

const POI_KIND_SET: ReadonlySet<string> = new Set(POI_KINDS);

function isPoiKind(value: string): value is PoiKind {
  return POI_KIND_SET.has(value);
}

/**
 * Turn a `kinds=restaurant,cafe` query string into a deduplicated,
 * validated array. Tolerates repeated params and whitespace. Unknown
 * tokens are dropped here so the downstream `@IsIn` validator sees a
 * clean `PoiKind[]` — if every token is invalid the result is still
 * `undefined`, which lets the service apply the default (all kinds).
 */
function parseKinds(value: unknown): PoiKind[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const kinds = new Set<PoiKind>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    for (const token of item.split(',')) {
      const trimmed = token.trim();
      if (trimmed && isPoiKind(trimmed)) kinds.add(trimmed);
    }
  }
  return kinds.size === 0 ? undefined : Array.from(kinds);
}

/**
 * Coerce a required numeric query string. A blank or whitespace-only
 * value becomes NaN so `@IsNumber()` rejects it — `Number('')` on its
 * own returns `0`, which would silently validate `?lat=&lng=` as the
 * coordinate origin.
 */
function toRequiredNumber(value: unknown): number {
  if (typeof value === 'string' && value.trim() === '') return Number.NaN;
  return Number(value);
}

export class PoiQueryDto {
  @ApiProperty({ example: 49.1 })
  @Transform(({ value }: { value: unknown }) => toRequiredNumber(value))
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ example: 16.75 })
  @Transform(({ value }: { value: unknown }) => toRequiredNumber(value))
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
    enum: POI_KINDS,
    isArray: true,
    required: false,
    description:
      'Kinds to include. Omit to return all kinds. Accepts a repeated ' +
      'query param (`kinds=restaurant&kinds=cafe`) or a comma-separated ' +
      'value (`kinds=restaurant,cafe`).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseKinds(value))
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(POI_KINDS, { each: true })
  kinds?: PoiKind[];
}

export class PoiDto {
  @ApiProperty()
  external_id!: string;

  @ApiProperty({ nullable: true })
  name!: string | null;

  @ApiProperty({ enum: POI_KINDS })
  kind!: PoiKind;

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
    description:
      'Cuisine or description hint. For restaurants/cafés this is the ' +
      '`cuisine` OSM tag; for viewpoints it is the `description` tag; ' +
      'for fuel stations it is the `brand` tag (falling back to the ' +
      '`operator` tag).',
  })
  hint!: string | null;
}

export class PoiListDto {
  @ApiProperty({ type: [PoiDto] })
  pois!: PoiDto[];

  @ApiProperty({ description: 'Radius actually used for the lookup, km.' })
  radius_km!: number;

  @ApiProperty({
    enum: POI_KINDS,
    isArray: true,
    description: 'Kinds that were actually queried for this response.',
  })
  kinds!: PoiKind[];
}

export { DEFAULT_RADIUS_KM, MAX_RADIUS_KM };
