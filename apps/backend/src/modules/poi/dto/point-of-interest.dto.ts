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

/**
 * Kinds of along-route POIs the mobile app surfaces in the trip-day view.
 * Mirrors the OSM tag subset we accept — anything outside this list is
 * dropped at the provider layer so client code doesn't need to deal with
 * unknown kinds. Kept deliberately small (restaurants + viewpoints +
 * cafés) because those are the only three the spec calls out and the mobile
 * card stays scannable with glove-sized rows.
 */
export const POI_KINDS = ['restaurant', 'viewpoint', 'cafe'] as const;

export type PoiKind = (typeof POI_KINDS)[number];

const DEFAULT_RADIUS_KM = 5;
const MAX_RADIUS_KM = 25;

/**
 * Turn a `kinds=restaurant,cafe` query string into a deduplicated,
 * validated array. Tolerates repeated params and whitespace. An empty
 * value falls through to `undefined` so the service applies the default
 * (all POI kinds).
 */
function parseKinds(value: unknown): PoiKind[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const parts: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    for (const token of item.split(',')) {
      const trimmed = token.trim();
      if (trimmed) parts.push(trimmed);
    }
  }
  if (parts.length === 0) return undefined;
  return Array.from(new Set(parts)) as PoiKind[];
}

export class PoiQueryDto {
  @ApiProperty({ example: 49.1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @ApiProperty({ example: 16.75 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;

  @ApiProperty({
    example: DEFAULT_RADIUS_KM,
    required: false,
    description: `Search radius in km (defaulted to ${DEFAULT_RADIUS_KM}, capped at ${MAX_RADIUS_KM} by the service).`,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : Number(value),
  )
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
  external_id: string;

  @ApiProperty({ nullable: true })
  name: string | null;

  @ApiProperty({ enum: POI_KINDS })
  kind: PoiKind;

  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;

  @ApiProperty({ description: 'Distance from the anchor point, km.' })
  distance_km: number;

  @ApiProperty({ nullable: true })
  website: string | null;

  @ApiProperty({ nullable: true })
  phone: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Cuisine or description hint. For restaurants/cafés this is the ' +
      '`cuisine` OSM tag; for viewpoints it is the `description` tag.',
  })
  hint: string | null;
}

export class PoiListDto {
  @ApiProperty({ type: [PoiDto] })
  pois: PoiDto[];

  @ApiProperty({ description: 'Radius actually used for the lookup, km.' })
  radius_km: number;

  @ApiProperty({
    enum: POI_KINDS,
    isArray: true,
    description: 'Kinds that were actually queried for this response.',
  })
  kinds: PoiKind[];
}

export { DEFAULT_RADIUS_KM, MAX_RADIUS_KM };
