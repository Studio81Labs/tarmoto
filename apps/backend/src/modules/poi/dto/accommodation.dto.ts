import { IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Kinds of overnight stops the mobile app surfaces. Mirrors the OSM
 * `tourism=*` tag subset we accept — anything outside this list is dropped
 * at the provider layer so client code doesn't need to handle unknown
 * kinds.
 */
export const ACCOMMODATION_KINDS = [
  'hotel',
  'motel',
  'hostel',
  'guest_house',
  'apartment',
  'chalet',
  'camp_site',
] as const;

export type AccommodationKind = (typeof ACCOMMODATION_KINDS)[number];

const DEFAULT_RADIUS_KM = 5;
const MAX_RADIUS_KM = 25;

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
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : Number(value),
  )
  @IsNumber()
  radius_km?: number;
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
}

export class AccommodationListDto {
  @ApiProperty({ type: [AccommodationDto] })
  accommodations!: AccommodationDto[];

  @ApiProperty({ description: 'Radius actually used for the lookup, km.' })
  radius_km!: number;
}

export { DEFAULT_RADIUS_KM, MAX_RADIUS_KM };
