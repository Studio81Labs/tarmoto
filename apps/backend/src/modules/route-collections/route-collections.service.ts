import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RouteCollection } from '../../entities/route-collection.entity.js';
import { RouteCollectionItem } from '../../entities/route-collection-item.entity.js';
import { RouteCollectionFollow } from '../../entities/route-collection-follow.entity.js';
import {
  AddRouteCollectionItemDto,
  CreateRouteCollectionDto,
  ReorderRouteCollectionItemsDto,
  RouteCollectionDetailDto,
  RouteCollectionFollowResponseDto,
  RouteCollectionItemResponseDto,
  RouteCollectionLibraryResponseDto,
  RouteCollectionListResponseDto,
  RouteCollectionPreviewItemDto,
  RouteCollectionPreviewResponseDto,
  RouteCollectionSummaryDto,
  UpdateRouteCollectionDto,
} from './dto/route-collection.dto.js';

const SLUG_LENGTH = 11;
const SLUG_ALLOC_RETRIES = 5;

// ~50 m at mid-latitudes — same tolerance the rides tracks endpoint uses.
// Keeps the polyline recognisable at typical map zoom levels while bounding
// the payload for a 20+ item collection (the issue's perf target).
const PREVIEW_SIMPLIFY_TOLERANCE_DEG = 0.0005;

@Injectable()
export class RouteCollectionsService {
  constructor(
    @InjectRepository(RouteCollection)
    private readonly collectionRepo: Repository<RouteCollection>,
    @InjectRepository(RouteCollectionItem)
    private readonly itemRepo: Repository<RouteCollectionItem>,
    @InjectRepository(RouteCollectionFollow)
    private readonly followRepo: Repository<RouteCollectionFollow>,
    private readonly dataSource: DataSource,
  ) {}

  async listMine(userId: string): Promise<RouteCollectionListResponseDto> {
    const rows = await this.collectionRepo
      .createQueryBuilder('c')
      .leftJoin('c.items', 'i')
      .where('c.owner_id = :userId', { userId })
      .select([
        'c.id',
        'c.owner_id',
        'c.title',
        'c.description',
        'c.visibility',
        'c.slug',
        'c.created_at',
        'c.updated_at',
      ])
      .addSelect('COUNT(i.id)', 'item_count')
      .groupBy('c.id')
      .orderBy('c.updated_at', 'DESC')
      .getRawAndEntities();

    // TypeORM's `getRawAndEntities` does NOT guarantee positional alignment
    // between `entities` and `raw` — particularly with aggregation, ordering,
    // or hydration that drops rows. Key the raw `item_count` on the entity
    // id (TypeORM emits the PK as `c_id` for the alias `c`) so collections
    // can't pick up another collection's count.
    const countById = new Map<string, number>();
    for (const raw of rows.raw as { c_id?: string; item_count?: string }[]) {
      if (raw.c_id) countById.set(raw.c_id, Number(raw.item_count ?? 0));
    }

    const items = rows.entities.map((c) =>
      this.toSummaryResponse(c, countById.get(c.id) ?? 0),
    );
    return { items, total: items.length };
  }

  /**
   * Owned + followed collections in one payload. The dashboard library page
   * renders both lists from a single round trip; the previous shape (one call
   * per list) opened a flicker window where the two arrived out of order.
   *
   * Followed collections that have been demoted back to `private` since the
   * follow was created are filtered out — the slug is no longer dereferenceable
   * so showing them in the library would link to a 404. The follow row stays
   * in the table so re-promoting the collection re-surfaces it without the
   * viewer needing to re-follow.
   */
  async listLibrary(
    userId: string,
  ): Promise<RouteCollectionLibraryResponseDto> {
    const owned = (await this.listMine(userId)).items;

    // Followed: join through the follow table → collection → item count, with
    // the same id-keyed pairing trick as listMine. Filtered to non-private,
    // non-soft-deleted owners so the UI never links to a 404. Also pulls the
    // owner's display name so the dashboard can surface "by Jane Rider" on
    // the followed cards (otherwise the rider's curation context is lost).
    //
    // Wrapped in a try-catch so a missing follow table (pre-migration staging)
    // or a transient DB error doesn't break the whole library endpoint — the
    // owned list is the primary data; followed is additive.
    let followed: RouteCollectionSummaryDto[] = [];
    try {
      const rows = await this.collectionRepo
        .createQueryBuilder('c')
        .innerJoin(
          RouteCollectionFollow,
          'f',
          'f.collection_id = c.id AND f.user_id = :userId',
          { userId },
        )
        .leftJoin('c.items', 'i')
        .leftJoin('c.owner', 'owner')
        .where("c.visibility <> 'private'")
        .andWhere('owner.deleted_at IS NULL')
        .select([
          'c.id',
          'c.owner_id',
          'c.title',
          'c.description',
          'c.visibility',
          'c.slug',
          'c.created_at',
          'c.updated_at',
        ])
        .addSelect('COUNT(i.id)', 'item_count')
        .addSelect('f.created_at', 'followed_at')
        .addSelect('owner.display_name', 'owner_name')
        .groupBy('c.id')
        .addGroupBy('f.created_at')
        .addGroupBy('owner.display_name')
        .orderBy('f.created_at', 'DESC')
        .getRawAndEntities();

      const countById = new Map<string, number>();
      const ownerNameById = new Map<string, string | null>();
      for (const raw of rows.raw as {
        c_id?: string;
        item_count?: string;
        owner_name?: string | null;
      }[]) {
        if (raw.c_id) {
          countById.set(raw.c_id, Number(raw.item_count ?? 0));
          ownerNameById.set(raw.c_id, raw.owner_name ?? null);
        }
      }

      followed = rows.entities.map((c) =>
        this.toSummaryResponse(
          c,
          countById.get(c.id) ?? 0,
          ownerNameById.get(c.id) ?? null,
        ),
      );
    } catch {
      // Followed query failed — return owned only so the UI still works.
      // The most likely cause is a missing migration; follow data will
      // surface once the route_collection_follows table is created.
    }

    return { owned, followed };
  }

  async create(
    userId: string,
    dto: CreateRouteCollectionDto,
  ): Promise<RouteCollectionDetailDto> {
    const slug = await this.allocateSlug();
    const description = normaliseDescription(dto.description);
    const created = await this.collectionRepo.save(
      this.collectionRepo.create({
        owner_id: userId,
        title: dto.title.trim(),
        description,
        visibility: dto.visibility ?? 'private',
        slug,
      }),
    );
    // Re-read with the owner relation so the detail response carries
    // `owner_name`. `toDetailResponse` reads `c.owner?.display_name`, and
    // `save()` doesn't hydrate relations — without this round trip the POST
    // response would always send `owner_name: ''`, drifting from getOwned /
    // update / getBySlug which all populate it.
    const withOwner = await this.collectionRepo.findOne({
      where: { id: created.id },
      relations: ['owner'],
    });
    return this.toDetailResponse(withOwner ?? created, [], userId, false);
  }

  async getOwned(
    userId: string,
    id: string,
  ): Promise<RouteCollectionDetailDto> {
    const collection = await this.collectionRepo.findOne({
      where: { id },
      relations: ['owner'],
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    if (collection.owner_id !== userId) {
      // Owner-scoped lookup: non-owners must use `/collections/by-slug/:slug`
      // which gates on visibility. 404 (not 403) so id existence isn't a side
      // channel for unlisted collections.
      throw new NotFoundException('Collection not found');
    }
    const items = await this.loadItems(collection.id);
    // Owners are represented with viewer_is_owner=true and
    // viewer_is_following=false; the UI hides the follow CTA for owners.
    return this.toDetailResponse(collection, items, userId, false);
  }

  async getBySlug(
    slug: string,
    viewerId: string | null,
  ): Promise<RouteCollectionDetailDto> {
    const collection = await this.collectionRepo.findOne({
      where: { slug },
      relations: ['owner'],
    });
    // `private` slugs aren't dereferenceable via the public endpoint — the
    // owner can already see the collection through `/collections/:id`. We
    // also 404 (not 403) so a stranger can't use the response code to learn
    // that a slug exists but is private.
    if (!collection || collection.visibility === 'private') {
      throw new NotFoundException('Collection not found');
    }
    if (collection.owner?.deleted_at != null) {
      // Soft-deleted owners (US-62): treat as non-existent during the grace
      // window so the link can't surface their identity. Mirrors trip-shares.
      throw new NotFoundException('Collection not found');
    }
    const items = await this.loadItems(collection.id);
    const viewerIsFollowing =
      viewerId != null && viewerId !== collection.owner_id
        ? await this.followRepo.exists({
            where: { user_id: viewerId, collection_id: collection.id },
          })
        : false;
    return this.toDetailResponse(
      collection,
      items,
      viewerId,
      viewerIsFollowing,
    );
  }

  /**
   * Map preview geometries for the public/unlisted shared collection page.
   * Mirrors `getBySlug`'s visibility gating exactly so a preview never
   * leaks data the detail endpoint would 404 on (private slug, soft-
   * deleted owner).
   *
   * Geometries are simplified server-side via `ST_Simplify` (~50 m
   * tolerance) and pulled in two batched queries — one over `trip_days`
   * for the trip items and one over `rides` for the ride items — so a
   * 20+ item collection still resolves in a single round-trip per kind
   * regardless of item count. Items whose underlying trip/ride was
   * deleted (or whose geometry is missing) are returned with an empty
   * `lines` array; the client renders them in position order without a
   * track instead of dropping them silently.
   */
  async getPreviewBySlug(
    slug: string,
  ): Promise<RouteCollectionPreviewResponseDto> {
    const collection = await this.collectionRepo.findOne({
      where: { slug },
      relations: ['owner'],
    });
    if (
      !collection ||
      collection.visibility === 'private' ||
      collection.owner?.deleted_at != null
    ) {
      throw new NotFoundException('Collection not found');
    }

    const items = await this.loadItems(collection.id);
    if (items.length === 0) {
      return { routes: [] };
    }

    const tripIds = items
      .map((i) => i.trip_id)
      .filter((id): id is string => id != null);
    const rideIds = items
      .map((i) => i.ride_id)
      .filter((id): id is string => id != null);

    type TripDayRow = { trip_id: string; geometry: string | null };
    type RideRow = { id: string; geometry: string | null };

    // Batch each kind into a single SQL round-trip. Ordering at this layer
    // doesn't matter — the controller emits items in the collection's
    // canonical position order; we just need a lookup keyed by trip/ride id.
    const [tripRows, rideRows] = await Promise.all([
      tripIds.length === 0
        ? Promise.resolve<TripDayRow[]>([])
        : this.dataSource.query<TripDayRow[]>(
            `SELECT trip_id,
                    ST_AsGeoJSON(ST_SimplifyPreserveTopology(route_geom, $1)) AS geometry
             FROM trip_days
             WHERE trip_id = ANY($2::uuid[])
               AND route_geom IS NOT NULL
             ORDER BY trip_id, day_number`,
            [PREVIEW_SIMPLIFY_TOLERANCE_DEG, tripIds],
          ),
      rideIds.length === 0
        ? Promise.resolve<RideRow[]>([])
        : this.dataSource.query<RideRow[]>(
            `SELECT id,
                    ST_AsGeoJSON(ST_SimplifyPreserveTopology(route_geom, $1)) AS geometry
             FROM rides
             WHERE id = ANY($2::uuid[])
               AND route_geom IS NOT NULL`,
            [PREVIEW_SIMPLIFY_TOLERANCE_DEG, rideIds],
          ),
    ]);

    const linesByTripId = new Map<string, number[][][]>();
    for (const row of tripRows) {
      const coords = parseLineStringCoords(row.geometry);
      if (!coords) continue;
      const existing = linesByTripId.get(row.trip_id);
      if (existing) {
        existing.push(coords);
      } else {
        linesByTripId.set(row.trip_id, [coords]);
      }
    }

    const linesByRideId = new Map<string, number[][][]>();
    for (const row of rideRows) {
      const coords = parseLineStringCoords(row.geometry);
      if (!coords) continue;
      linesByRideId.set(row.id, [coords]);
    }

    const routes: RouteCollectionPreviewItemDto[] = items.map((item) => {
      const isRide = item.ride_id != null;
      const lines = isRide
        ? (linesByRideId.get(item.ride_id!) ?? [])
        : (linesByTripId.get(item.trip_id!) ?? []);
      return {
        item_id: item.id,
        position: item.position,
        kind: isRide ? 'ride' : 'trip',
        lines,
      };
    });

    return { routes };
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateRouteCollectionDto,
  ): Promise<RouteCollectionDetailDto> {
    const collection = await this.collectionRepo.findOne({
      where: { id },
      relations: ['owner'],
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    if (collection.owner_id !== userId) {
      throw new ForbiddenException('Not the owner of this collection');
    }

    if (dto.title !== undefined) {
      const trimmed = dto.title.trim();
      if (trimmed === '') {
        throw new BadRequestException('title must not be empty');
      }
      collection.title = trimmed;
    }
    if (dto.description !== undefined) {
      collection.description = normaliseDescription(dto.description);
    }
    if (dto.visibility !== undefined) {
      collection.visibility = dto.visibility;
    }

    await this.collectionRepo.save(collection);
    const items = await this.loadItems(collection.id);
    return this.toDetailResponse(collection, items, userId, false);
  }

  async delete(userId: string, id: string): Promise<void> {
    const collection = await this.collectionRepo.findOne({ where: { id } });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    if (collection.owner_id !== userId) {
      throw new ForbiddenException('Not the owner of this collection');
    }
    // Items + follows cascade-delete via the FK ON DELETE CASCADE constraint.
    await this.collectionRepo.remove(collection);
  }

  async addItem(
    userId: string,
    collectionId: string,
    dto: AddRouteCollectionItemDto,
  ): Promise<RouteCollectionItemResponseDto> {
    const tripProvided = !!dto.trip_id;
    const rideProvided = !!dto.ride_id;
    if (tripProvided === rideProvided) {
      // Both unset or both set — 400 instead of leaving the DB CHECK to fire,
      // so the validation message is friendlier than a constraint violation.
      throw new BadRequestException(
        'Exactly one of `trip_id` or `ride_id` must be provided',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const collectionRepo = manager.getRepository(RouteCollection);
      const itemRepo = manager.getRepository(RouteCollectionItem);

      // SELECT ... FOR UPDATE on the parent row. PostgreSQL's default
      // READ COMMITTED isolation does NOT prevent two concurrent
      // `MAX(position)+1` reads from returning the same value, so the
      // transaction alone isn't enough — we'd silently produce duplicate
      // positions for the same collection. Locking the parent row
      // serialises every concurrent `addItem` for the same collectionId
      // (different collections stay independent) and releases at txn end.
      const collection = await collectionRepo.findOne({
        where: { id: collectionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!collection) {
        throw new NotFoundException('Collection not found');
      }
      if (collection.owner_id !== userId) {
        throw new ForbiddenException('Not the owner of this collection');
      }

      // Treat a duplicate add as a no-op return of the existing row instead
      // of a 409 — the companion sometimes retries on flaky network and a
      // user-visible error here would be confusing.
      const existing = tripProvided
        ? await itemRepo.findOne({
            where: { collection_id: collectionId, trip_id: dto.trip_id! },
          })
        : await itemRepo.findOne({
            where: { collection_id: collectionId, ride_id: dto.ride_id! },
          });
      if (existing) {
        return this.toItemResponse(existing);
      }

      // Safe to compute MAX(position)+1 now: the parent row lock above
      // guarantees no other addItem for this collection is interleaving
      // between this read and the insert below.
      const maxRow = await itemRepo
        .createQueryBuilder('i')
        .select('COALESCE(MAX(i.position), -1)', 'max')
        .where('i.collection_id = :collectionId', { collectionId })
        .getRawOne<{ max: number | string }>();
      const nextPosition = Number(maxRow?.max ?? -1) + 1;

      const item = itemRepo.create({
        collection_id: collectionId,
        trip_id: tripProvided ? dto.trip_id! : null,
        ride_id: rideProvided ? dto.ride_id! : null,
        position: nextPosition,
      });
      const saved = await itemRepo.save(item);

      // Bump parent updated_at so the listing sort reflects the change.
      collection.updated_at = new Date();
      await collectionRepo.save(collection);

      return this.toItemResponse(saved);
    });
  }

  async reorderItems(
    userId: string,
    collectionId: string,
    dto: ReorderRouteCollectionItemsDto,
  ): Promise<RouteCollectionDetailDto> {
    // Catch duplicate ids before opening a transaction — saves a round trip
    // for an obvious client bug, and the set-equality check below would
    // otherwise mask the duplicate (a duplicate plus a missing id of the
    // same length would still match on size).
    const uniqueIds = new Set(dto.item_ids);
    if (uniqueIds.size !== dto.item_ids.length) {
      throw new BadRequestException('item_ids must not contain duplicates');
    }

    return this.dataSource.transaction(async (manager) => {
      const collectionRepo = manager.getRepository(RouteCollection);
      const itemRepo = manager.getRepository(RouteCollectionItem);

      // Pessimistic write lock on the parent row, mirroring `addItem`.
      // Without it a concurrent add/remove between our `find` and the bulk
      // `save` could produce an inconsistent renumber (e.g. a row added
      // mid-flight that's not in `item_ids` would keep its old position and
      // collide with a row we just renumbered to that value). Locking the
      // parent serialises every concurrent mutation for this collection.
      const collection = await collectionRepo.findOne({
        where: { id: collectionId },
        relations: ['owner'],
        lock: { mode: 'pessimistic_write' },
      });
      if (!collection) {
        throw new NotFoundException('Collection not found');
      }
      if (collection.owner_id !== userId) {
        throw new ForbiddenException('Not the owner of this collection');
      }

      const currentItems = await itemRepo.find({
        where: { collection_id: collectionId },
      });

      // Set equality: every existing item must be in the payload, and every
      // payload id must reference an item in this collection. We 400 on any
      // mismatch so a stale client (e.g. another tab added an item between
      // load and drag) can re-fetch instead of silently dropping a row.
      if (currentItems.length !== dto.item_ids.length) {
        throw new BadRequestException(
          'item_ids must include every current item exactly once',
        );
      }
      const currentById = new Map(currentItems.map((i) => [i.id, i]));
      for (const id of dto.item_ids) {
        if (!currentById.has(id)) {
          throw new BadRequestException(
            'item_ids references an item that is not in this collection',
          );
        }
      }

      // Renumber 0..N-1 in the requested order. We mutate-then-save the
      // existing entities (rather than building new ones) so audit columns
      // stay accurate and any future @BeforeUpdate hooks fire normally.
      const reordered: RouteCollectionItem[] = [];
      for (let i = 0; i < dto.item_ids.length; i += 1) {
        const item = currentById.get(dto.item_ids[i])!;
        item.position = i;
        reordered.push(item);
      }
      await itemRepo.save(reordered);

      // Bump parent updated_at so listing sort surfaces the change to other
      // tabs and the public-page cache.
      collection.updated_at = new Date();
      await collectionRepo.save(collection);

      // Return the canonical view — re-read so positions reflect the saved
      // state and the order matches `loadItems` (position ASC, created_at ASC).
      const items = await itemRepo.find({
        where: { collection_id: collectionId },
        order: { position: 'ASC', created_at: 'ASC' },
      });
      // Owner-only path: viewer is the owner, so viewer_is_following is
      // false by definition (the follow endpoint 400s on owner-self-follow).
      return this.toDetailResponse(collection, items, userId, false);
    });
  }

  async removeItem(
    userId: string,
    collectionId: string,
    itemId: string,
  ): Promise<void> {
    const collection = await this.collectionRepo.findOne({
      where: { id: collectionId },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    if (collection.owner_id !== userId) {
      throw new ForbiddenException('Not the owner of this collection');
    }
    const item = await this.itemRepo.findOne({
      where: { id: itemId, collection_id: collectionId },
    });
    if (!item) {
      throw new NotFoundException('Collection item not found');
    }
    await this.itemRepo.remove(item);
    collection.updated_at = new Date();
    await this.collectionRepo.save(collection);
  }

  /**
   * Follow a collection — adds it to the caller's library. Idempotent: a
   * duplicate POST returns the existing row instead of erroring, so a flaky
   * client retry doesn't surface as a confusing 409.
   *
   * Visibility gating mirrors `getBySlug`:
   *  - private collections 404 (not 403) so id existence isn't a side
   *    channel for unlisted ones the caller hasn't seen.
   *  - the owner cannot follow their own collection — it already lives in
   *    `owned` and the UI hides the CTA for owners; we 400 here as a
   *    structural guard rather than silently accepting a no-op row.
   *  - soft-deleted owners (US-62) hide their collections, so a follow
   *    against one of their slugs 404s during the grace window.
   */
  async follow(
    userId: string,
    collectionId: string,
  ): Promise<RouteCollectionFollowResponseDto> {
    const collection = await this.collectionRepo.findOne({
      where: { id: collectionId },
      relations: ['owner'],
    });
    if (
      !collection ||
      collection.visibility === 'private' ||
      collection.owner?.deleted_at != null
    ) {
      throw new NotFoundException('Collection not found');
    }
    if (collection.owner_id === userId) {
      throw new BadRequestException('You cannot follow your own collection');
    }

    // Insert directly and fall back to a re-find on the unique violation.
    // A check-then-insert pattern would race under concurrency: two parallel
    // POSTs can both pass the existence check and the second hits the
    // `uq_route_collection_follows_user_collection` constraint, which would
    // surface as a 500 and break the documented idempotency guarantee.
    try {
      const saved = await this.followRepo.save(
        this.followRepo.create({
          user_id: userId,
          collection_id: collectionId,
        }),
      );
      return {
        collection_id: collectionId,
        followed_at: saved.created_at.toISOString(),
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost the race — the row exists. Re-read it so we can return the
      // canonical `followed_at` from the winning insert.
      const existing = await this.followRepo.findOne({
        where: { user_id: userId, collection_id: collectionId },
      });
      if (!existing) {
        // Truly unreachable: the unique violation says a row exists, but a
        // parallel unfollow could have removed it between catch and re-read.
        // Re-throw so the client sees a real error instead of a stale ok.
        throw err;
      }
      return {
        collection_id: collectionId,
        followed_at: existing.created_at.toISOString(),
      };
    }
  }

  /**
   * Unfollow a collection. Idempotent — succeeds (204) whether or not a row
   * exists, so the client doesn't have to track follow state to call it
   * safely. We do NOT validate that the underlying collection still exists:
   * if the curator deleted the collection, the follow row was already
   * cascade-deleted, and the unfollow becomes a clean no-op.
   */
  async unfollow(userId: string, collectionId: string): Promise<void> {
    await this.followRepo.delete({
      user_id: userId,
      collection_id: collectionId,
    });
  }

  // ── private helpers ──

  private async loadItems(
    collectionId: string,
  ): Promise<RouteCollectionItem[]> {
    return this.itemRepo.find({
      where: { collection_id: collectionId },
      order: { position: 'ASC', created_at: 'ASC' },
    });
  }

  private async allocateSlug(): Promise<string> {
    // Random URL-safe slugs, retried on the (extremely unlikely) collision
    // with the unique index. 11 base64url chars is ~66 bits — collision
    // odds remain astronomical even with millions of collections, but we
    // guard anyway because hand-crafted SQL or a DB clone could create dupes.
    for (let attempt = 0; attempt < SLUG_ALLOC_RETRIES; attempt += 1) {
      const candidate = generateSlug();
      const exists = await this.collectionRepo.exists({
        where: { slug: candidate },
      });
      if (!exists) return candidate;
    }
    throw new Error('Failed to allocate a unique route collection slug');
  }

  private toSummaryResponse(
    c: RouteCollection,
    item_count: number,
    owner_name: string | null = null,
  ): RouteCollectionSummaryDto {
    return {
      id: c.id,
      owner_id: c.owner_id,
      title: c.title,
      description: c.description ?? null,
      visibility: c.visibility,
      slug: c.slug,
      item_count,
      owner_name,
      created_at: c.created_at.toISOString(),
      updated_at: c.updated_at.toISOString(),
    };
  }

  private toDetailResponse(
    c: RouteCollection,
    items: RouteCollectionItem[],
    viewerId: string | null,
    viewerIsFollowing: boolean,
  ): RouteCollectionDetailDto {
    const ownerName = c.owner?.display_name ?? '';
    return {
      ...this.toSummaryResponse(c, items.length, ownerName || null),
      items: items.map((i) => this.toItemResponse(i)),
      owner_name: ownerName,
      viewer_is_owner: viewerId != null && viewerId === c.owner_id,
      viewer_is_following: viewerIsFollowing,
    };
  }

  private toItemResponse(
    item: RouteCollectionItem,
  ): RouteCollectionItemResponseDto {
    return {
      id: item.id,
      trip_id: item.trip_id ?? null,
      ride_id: item.ride_id ?? null,
      position: item.position,
      created_at: item.created_at.toISOString(),
    };
  }
}

function normaliseDescription(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * PostgreSQL surfaces a `unique_violation` (SQLSTATE 23505) when a duplicate
 * INSERT hits a unique constraint. TypeORM wraps the raw pg error as a
 * `QueryFailedError`, but the `code` survives intact on the wrapped error
 * shape — checking it lets the caller treat the duplicate as the no-op
 * idempotent case instead of surfacing a 500.
 */
function isUniqueViolation(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  if ('code' in err && (err as { code?: unknown }).code === '23505') {
    return true;
  }
  const driver = (err as { driverError?: unknown }).driverError;
  if (
    driver != null &&
    typeof driver === 'object' &&
    'code' in driver &&
    (driver as { code?: unknown }).code === '23505'
  ) {
    return true;
  }
  return false;
}

/**
 * Parse the JSON string returned by `ST_AsGeoJSON` into a coordinate array.
 * Returns null when the input is missing, malformed, or has fewer than two
 * points (a degenerate geometry isn't useful for a polyline preview).
 */
function parseLineStringCoords(
  geojson: string | null | undefined,
): number[][] | null {
  if (!geojson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(geojson);
  } catch {
    return null;
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    !('coordinates' in parsed)
  ) {
    return null;
  }
  const coords = (parsed as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const out: number[][] = [];
  for (const c of coords) {
    if (
      Array.isArray(c) &&
      c.length >= 2 &&
      typeof c[0] === 'number' &&
      typeof c[1] === 'number'
    ) {
      out.push([c[0], c[1]]);
    }
  }
  return out.length >= 2 ? out : null;
}

function generateSlug(): string {
  // 8 random bytes → 11 base64url chars. `randomBytes` is cryptographically
  // strong; we don't need that for slugs but it's the cheapest way to avoid
  // bias in a custom alphabet.
  return randomBytes(8)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, SLUG_LENGTH);
}
