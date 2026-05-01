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
import {
  AddRouteCollectionItemDto,
  CreateRouteCollectionDto,
  RouteCollectionDetailDto,
  RouteCollectionItemResponseDto,
  RouteCollectionListResponseDto,
  RouteCollectionSummaryDto,
  UpdateRouteCollectionDto,
} from './dto/route-collection.dto.js';

const SLUG_LENGTH = 11;
const SLUG_ALLOC_RETRIES = 5;

@Injectable()
export class RouteCollectionsService {
  constructor(
    @InjectRepository(RouteCollection)
    private readonly collectionRepo: Repository<RouteCollection>,
    @InjectRepository(RouteCollectionItem)
    private readonly itemRepo: Repository<RouteCollectionItem>,
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
    return this.toDetailResponse(withOwner ?? created, []);
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
    return this.toDetailResponse(collection, items);
  }

  async getBySlug(slug: string): Promise<RouteCollectionDetailDto> {
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
    return this.toDetailResponse(collection, items);
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
    return this.toDetailResponse(collection, items);
  }

  async delete(userId: string, id: string): Promise<void> {
    const collection = await this.collectionRepo.findOne({ where: { id } });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    if (collection.owner_id !== userId) {
      throw new ForbiddenException('Not the owner of this collection');
    }
    // Items cascade-delete via the FK ON DELETE CASCADE constraint.
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
  ): RouteCollectionSummaryDto {
    return {
      id: c.id,
      owner_id: c.owner_id,
      title: c.title,
      description: c.description ?? null,
      visibility: c.visibility,
      slug: c.slug,
      item_count,
      created_at: c.created_at.toISOString(),
      updated_at: c.updated_at.toISOString(),
    };
  }

  private toDetailResponse(
    c: RouteCollection,
    items: RouteCollectionItem[],
  ): RouteCollectionDetailDto {
    return {
      ...this.toSummaryResponse(c, items.length),
      items: items.map((i) => this.toItemResponse(i)),
      owner_name: c.owner?.display_name ?? '',
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
