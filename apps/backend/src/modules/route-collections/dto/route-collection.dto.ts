import {
  ArrayMinSize,
  IsArray,
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
  @IsIn(ROUTE_COLLECTION_VISIBILITIES)
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
  @IsIn(ROUTE_COLLECTION_VISIBILITIES)
  visibility?: RouteCollectionVisibilityDto;
}

/**
 * Add a single trip- or ride-keyed item to a collection.
 *
 * Validation runs in three layers, each catching a different failure mode:
 *
 *  1. Field-level `@IsUUID` (gated by `@ValidateIf`) — catches a non-UUID
 *     value in either `trip_id` or `ride_id` at the ValidationPipe (400).
 *  2. `RouteCollectionsService.addItem` — catches the cross-field invariants
 *     class-validator can't express cleanly: empty body and both fields
 *     populated. Throws `BadRequestException` (also 400) with a clear
 *     message before touching the DB.
 *  3. `chk_route_collection_items_target` DB CHECK — final backstop so a
 *     hand-written INSERT can't drift the row state.
 *
 * (The cross-field check lives in the service, not the DTO, because
 * `@ValidateIf` short-circuits *all* property decorators when its predicate
 * returns false — including `@Validate(...)` — so the empty-body case is
 * unreachable from a field-level constraint without a structural workaround
 * that would be more confusing than the service check it would replace.)
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

/**
 * Reorder every item in a collection by submitting the desired full order.
 *
 * The contract is intentionally "send the whole list" rather than per-item
 * position deltas: the UI naturally produces a final ordering on drop, and a
 * full-list payload makes the server side trivially atomic — we renumber
 * 0..N-1 in one transaction, no merging of concurrent partial updates.
 *
 * `item_ids` must be the exact set of the collection's current items (no
 * missing, no extras, no duplicates). The service rejects any mismatch with a
 * 400 so a stale client can't silently drop a row that another tab just added.
 */
export class ReorderRouteCollectionItemsDto {
  @ApiProperty({
    type: [String],
    minItems: 2,
    description:
      'Full ordered list of the collection item ids (the join-row uuids returned by add-item / detail). Must exactly match the current set of items in the collection.',
  })
  @IsArray()
  @ArrayMinSize(2)
  @IsUUID('all', { each: true })
  item_ids!: string[];
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

  @ApiProperty({
    nullable: true,
    description:
      "Stable id of the owning rider. `null` when the owner has set `profile_visibility = 'private'` and the viewer is not the owner — masked alongside `owner_name` so the id can't be cross-referenced to recover the rider's identity (#279 / #501).",
  })
  owner_id!: string | null;

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

  @ApiProperty({
    nullable: true,
    description:
      "Display name of the owning rider. Populated for endpoints that surface other riders' collections (e.g. the followed list); `null` on the caller's own list since the rider already knows their own name.",
  })
  owner_name!: string | null;

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
      'Number of riders following this collection. 0 for a brand-new collection; surfaced on the owner detail-page stats.',
  })
  follower_count!: number;

  // owner_name is inherited from the summary as `string | null`. Detail
  // responses always populate it (empty string for soft-deleted accounts,
  // since the controller 404s in that case before reaching the response),
  // but we keep the inherited type rather than narrowing — a `declare`
  // override does not reliably re-emit the @ApiProperty metadata across
  // TypeScript versions, so the OpenAPI schema would silently disagree
  // with the runtime. The slightly looser `nullable: true` schema is
  // harmless and matches what we report on the summary.

  @ApiProperty({
    description:
      'True when the calling user follows this collection. False for the owner, anonymous viewers, and signed-in viewers who have not yet followed.',
  })
  viewer_is_following!: boolean;

  @ApiProperty({
    description:
      'True when the calling user owns this collection. The owner uses the dashboard CRUD surface rather than the follow CTA.',
  })
  viewer_is_owner!: boolean;
}

export class RouteCollectionListResponseDto {
  @ApiProperty({ type: [RouteCollectionSummaryDto] })
  items!: RouteCollectionSummaryDto[];

  @ApiProperty()
  total!: number;
}

/**
 * Library response — owned and followed collections in one payload so the
 * dashboard renders without two round trips. Each side is sorted independently
 * (owned by `updated_at` desc; followed by `followed_at` desc) and returned in
 * its own array so the UI can label them differently.
 */
export class RouteCollectionLibraryResponseDto {
  @ApiProperty({
    type: [RouteCollectionSummaryDto],
    description: 'Collections the caller owns.',
  })
  owned!: RouteCollectionSummaryDto[];

  @ApiProperty({
    type: [RouteCollectionSummaryDto],
    description:
      'Collections the caller follows. Excludes private collections — if a curator demotes a collection back to private after being followed, the row is filtered out here so the library never lists an inaccessible link.',
  })
  followed!: RouteCollectionSummaryDto[];
}

export class RouteCollectionFollowResponseDto {
  @ApiProperty()
  collection_id!: string;

  @ApiProperty()
  followed_at!: string;
}

/**
 * Preview entry for one item in a shared collection. Each entry carries the
 * polylines that should render on the map for that item:
 *  - rides contribute one polyline (the recorded `route_geom`).
 *  - trips contribute one polyline per `trip_days.route_geom` (a multi-day
 *    plan can have non-contiguous days, so we keep them as separate
 *    polylines instead of concatenating into one).
 *
 * Items whose underlying trip/ride has been deleted, or whose geometry is
 * missing, return an empty `lines` array — the client renders those items
 * without a map track but still preserves the position in the list. This is
 * the same "missing item" handling the dashboard detail page already uses.
 *
 * Geometries are simplified server-side via `ST_Simplify` to keep the
 * payload bounded for ~20+ item collections (target tolerance ~0.0005°,
 * roughly 50 m, which still gives a recognisable preview at typical zoom
 * levels).
 */
export class RouteCollectionPreviewItemDto {
  @ApiProperty({ description: 'ID of the route_collection_items row.' })
  item_id!: string;

  @ApiProperty({
    description: 'Position of the item in the collection (zero-based).',
  })
  position!: number;

  @ApiProperty({ enum: ['trip', 'ride'] })
  kind!: 'trip' | 'ride';

  @ApiProperty({
    nullable: true,
    description:
      'UUID a NON-owner can open this route at — combined with `kind` the ' +
      'client builds the detail link (`/community/trips/:id` or ' +
      '`/community/rides/:id`). `null` when the route is not openable by a ' +
      'non-owner, so the client must not link it: a missing/deleted trip or ' +
      'ride, or a ride that is not publicly shared (its detail page 404s a ' +
      'non-owner). A trip is openable whenever the collection owner can see ' +
      'it (collection-scoped access).',
  })
  target_id!: string | null;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'array',
      items: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
      },
    },
    description:
      'Array of polylines for this item. Each polyline is an array of [lng, lat] pairs (GeoJSON LineString coordinates). Empty array if the underlying trip/ride is missing or has no geometry.',
  })
  lines!: number[][][];

  // Per-item summary fields — let a non-owner (public shared page / member
  // discover view) render the route rows without the viewer's own trip/ride
  // cache. All `null` when the underlying trip/ride was deleted.

  @ApiProperty({
    nullable: true,
    description: 'Trip title or ride name. `null` for a deleted item.',
  })
  title!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Trip day count. `null` for rides (a ride is a single recorded day) and deleted items.',
  })
  num_days!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Total distance in km. Trips: sum of the day distances. Rides: the recorded distance. `null` when unknown.',
  })
  distance_km!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Trip status (planned / completed / …) or ride status (completed / active). `null` for a deleted item.',
  })
  status!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Average road quality (0–5). Trips: distance-weighted across days. Rides: the recorded average. `null` when unknown.',
  })
  quality_avg!: number | null;
}

export class RouteCollectionPreviewResponseDto {
  @ApiProperty({ type: [RouteCollectionPreviewItemDto] })
  routes!: RouteCollectionPreviewItemDto[];
}

export class RouteCollectionCardDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true })
  description!: string | null;

  @ApiProperty({ nullable: true })
  owner_id!: string | null;

  @ApiProperty({ nullable: true })
  owner_name!: string | null;

  @ApiProperty({ description: 'Total routes in the collection.' })
  item_count!: number;

  @ApiProperty({ description: 'How many riders follow this collection.' })
  follower_count!: number;

  @ApiProperty({
    description: 'Whether the authenticated viewer follows this collection.',
  })
  viewer_is_following!: boolean;

  @ApiProperty()
  updated_at!: string;
}

export class RouteCollectionDiscoverResponseDto {
  @ApiProperty({ type: [RouteCollectionCardDto] })
  items!: RouteCollectionCardDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  offset!: number;
}
