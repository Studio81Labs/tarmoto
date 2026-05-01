import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const ROUTE_COLLECTION_VISIBILITIES = [
  'private',
  'unlisted',
  'public',
] as const;

export type RouteCollectionVisibilityDto =
  (typeof ROUTE_COLLECTION_VISIBILITIES)[number];

export const MAX_COLLECTION_TITLE_LENGTH = 80;
export const MAX_COLLECTION_DESCRIPTION_LENGTH = 500;

export class CreateRouteCollectionDto {
  @ApiProperty({ minLength: 1, maxLength: MAX_COLLECTION_TITLE_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_COLLECTION_TITLE_LENGTH)
  title!: string;

  @ApiProperty({
    required: false,
    maxLength: MAX_COLLECTION_DESCRIPTION_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_COLLECTION_DESCRIPTION_LENGTH)
  description?: string;

  @ApiProperty({
    required: false,
    enum: ROUTE_COLLECTION_VISIBILITIES,
    default: 'private',
  })
  @IsOptional()
  @IsIn(ROUTE_COLLECTION_VISIBILITIES as unknown as string[])
  visibility?: RouteCollectionVisibilityDto;
}

export class UpdateRouteCollectionDto {
  @ApiProperty({
    required: false,
    minLength: 1,
    maxLength: MAX_COLLECTION_TITLE_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_COLLECTION_TITLE_LENGTH)
  title?: string;

  @ApiProperty({
    required: false,
    maxLength: MAX_COLLECTION_DESCRIPTION_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_COLLECTION_DESCRIPTION_LENGTH)
  description?: string | null;

  @ApiProperty({ required: false, enum: ROUTE_COLLECTION_VISIBILITIES })
  @IsOptional()
  @IsIn(ROUTE_COLLECTION_VISIBILITIES as unknown as string[])
  visibility?: RouteCollectionVisibilityDto;
}

/**
 * Add a single trip- or ride-keyed item to a collection. Exactly one of
 * `trip_id` / `ride_id` must be provided — class-validator ensures this with
 * the `ValidateIf`-anchored `IsUUID` so an empty body, both populated, or
 * non-UUIDs all 400. The DB has the same check constraint as a backstop.
 */
export class AddRouteCollectionItemDto {
  @ApiProperty({
    required: false,
    description: 'UUID of a planner trip. Mutually exclusive with `ride_id`.',
    nullable: true,
  })
  @ValidateIf((o: AddRouteCollectionItemDto) => o.trip_id !== undefined)
  @IsUUID()
  trip_id?: string;

  @ApiProperty({
    required: false,
    description: 'UUID of a recorded ride. Mutually exclusive with `trip_id`.',
    nullable: true,
  })
  @ValidateIf((o: AddRouteCollectionItemDto) => o.ride_id !== undefined)
  @IsUUID()
  ride_id?: string;
}

export class RouteCollectionItemResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true })
  trip_id!: string | null;

  @ApiProperty({ nullable: true })
  ride_id!: string | null;

  @ApiProperty()
  position!: number;

  @ApiProperty()
  created_at!: string;
}

export class RouteCollectionSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  owner_id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true })
  description!: string | null;

  @ApiProperty({ enum: ROUTE_COLLECTION_VISIBILITIES })
  visibility!: RouteCollectionVisibilityDto;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ description: 'Total items in the collection.' })
  item_count!: number;

  @ApiProperty()
  created_at!: string;

  @ApiProperty()
  updated_at!: string;
}

export class RouteCollectionDetailDto extends RouteCollectionSummaryDto {
  @ApiProperty({ type: [RouteCollectionItemResponseDto] })
  items!: RouteCollectionItemResponseDto[];

  @ApiProperty({
    description:
      'Display name of the owning rider (for unlisted/public viewing). Empty for soft-deleted accounts; the controller 404s in that case.',
  })
  owner_name!: string;
}

export class RouteCollectionListResponseDto {
  @ApiProperty({ type: [RouteCollectionSummaryDto] })
  items!: RouteCollectionSummaryDto[];

  @ApiProperty()
  total!: number;
}
