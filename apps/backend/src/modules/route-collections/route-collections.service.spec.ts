/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RouteCollection } from '../../entities/route-collection.entity.js';
import { RouteCollectionItem } from '../../entities/route-collection-item.entity.js';
import { RouteCollectionFollow } from '../../entities/route-collection-follow.entity.js';
import { RouteCollectionsService } from './route-collections.service.js';

describe('RouteCollectionsService', () => {
  let service: RouteCollectionsService;
  let collectionRepo: Partial<jest.Mocked<Repository<RouteCollection>>>;
  let itemRepo: Partial<jest.Mocked<Repository<RouteCollectionItem>>>;
  let followRepo: Partial<jest.Mocked<Repository<RouteCollectionFollow>>>;

  const ownerId = 'user-1';
  const otherId = 'user-2';
  const collectionId = '00000000-0000-0000-0000-000000000001';
  const tripId = '00000000-0000-0000-0000-000000000010';

  const baseCollection: RouteCollection = {
    id: collectionId,
    owner_id: ownerId,
    title: 'Beskydy Loops',
    description: null,
    visibility: 'private',
    slug: 'abcDEF12345',
    created_at: new Date('2026-04-20T10:00:00Z'),
    updated_at: new Date('2026-04-20T10:00:00Z'),
    items: [],
    owner: {
      display_name: 'Jane Rider',
      deleted_at: null,
    },
  } as unknown as RouteCollection;

  beforeEach(async () => {
    collectionRepo = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      // Mirror real TypeORM: `create()` builds an entity from input + sane
      // defaults (timestamps), but does NOT hydrate relations like `owner`.
      // Tests that need owner_name to surface stub the post-save `findOne`
      // separately (the create path re-finds with relations: ['owner']).
      create: jest.fn().mockImplementation((data) => ({
        id: collectionId,
        description: null,
        created_at: new Date('2026-04-20T10:00:00Z'),
        updated_at: new Date('2026-04-20T10:00:00Z'),
        items: [],
        ...data,
      })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(buildListQueryBuilder()),
    };

    itemRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((data) => ({
        id: 'item-new',
        created_at: new Date('2026-04-20T10:01:00Z'),
        ...data,
      })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ max: -1 }),
      }),
    };

    followRepo = {
      exists: jest.fn().mockResolvedValue(false),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((data) => ({
        id: 'follow-new',
        created_at: new Date('2026-04-20T11:00:00Z'),
        ...data,
      })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    // The service's `addItem` opens a transaction; mock it to invoke the
    // callback with a manager that returns the same mocks. Avoids needing a
    // real DataSource for unit tests.
    const dataSource: Partial<DataSource> = {
      transaction: jest
        .fn()
        .mockImplementation((cb: (mgr: unknown) => Promise<unknown>) =>
          cb({
            getRepository: (target: unknown) =>
              target === RouteCollection ? collectionRepo : itemRepo,
          }),
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RouteCollectionsService,
        {
          provide: getRepositoryToken(RouteCollection),
          useValue: collectionRepo,
        },
        {
          provide: getRepositoryToken(RouteCollectionItem),
          useValue: itemRepo,
        },
        {
          provide: getRepositoryToken(RouteCollectionFollow),
          useValue: followRepo,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<RouteCollectionsService>(RouteCollectionsService);
  });

  describe('listMine', () => {
    it('pairs item_count to entities by id, not array index', async () => {
      // Deliberately misalign raw and entity orderings — TypeORM's
      // `getRawAndEntities` doesn't guarantee positional alignment when
      // aggregation/ordering is involved, so the service must look up
      // counts by entity id (the `c_id` column from the alias `c`).
      const collectionA = {
        ...baseCollection,
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        title: 'Alpha',
      };
      const collectionB = {
        ...baseCollection,
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        title: 'Beta',
      };

      (collectionRepo.createQueryBuilder as jest.Mock).mockReturnValueOnce({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({
          entities: [collectionA, collectionB],
          raw: [
            // Reversed wrt entities: B first with 5, A second with 7.
            { c_id: collectionB.id, item_count: '5' },
            { c_id: collectionA.id, item_count: '7' },
          ],
        }),
      });

      const result = await service.listMine(ownerId);

      expect(result.items).toHaveLength(2);
      const byId = new Map(result.items.map((i) => [i.id, i.item_count]));
      // Without the id-keyed pairing this would attribute B's 5 to A.
      expect(byId.get(collectionA.id)).toBe(7);
      expect(byId.get(collectionB.id)).toBe(5);
    });

    it('falls back to 0 when a raw row is missing for an entity', async () => {
      (collectionRepo.createQueryBuilder as jest.Mock).mockReturnValueOnce({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({
          entities: [baseCollection],
          raw: [], // missing — the lookup must default cleanly to 0
        }),
      });

      const result = await service.listMine(ownerId);
      expect(result.items[0]?.item_count).toBe(0);
    });
  });

  describe('listLibrary', () => {
    it('returns owned collections from listMine plus joined follows', async () => {
      const ownedCol = { ...baseCollection };
      const followedCol = {
        ...baseCollection,
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        owner_id: otherId,
        visibility: 'public',
        title: 'Followed by me',
      };

      // listMine queries first, then listLibrary's followed query — return
      // distinct query builders in order.
      (collectionRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getRawAndEntities: jest.fn().mockResolvedValue({
            entities: [ownedCol],
            raw: [{ c_id: ownedCol.id, item_count: '2' }],
          }),
        })
        .mockReturnValueOnce({
          innerJoin: jest.fn().mockReturnThis(),
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          addGroupBy: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getRawAndEntities: jest.fn().mockResolvedValue({
            entities: [followedCol],
            raw: [{ c_id: followedCol.id, item_count: '4' }],
          }),
        });

      const result = await service.listLibrary(ownerId);
      expect(result.owned).toHaveLength(1);
      expect(result.owned[0]?.id).toBe(ownedCol.id);
      expect(result.followed).toHaveLength(1);
      expect(result.followed[0]?.id).toBe(followedCol.id);
      expect(result.followed[0]?.item_count).toBe(4);
    });
  });

  describe('create', () => {
    it('allocates a slug and persists the trimmed title', async () => {
      // Stub the post-save owner re-load so toDetailResponse can populate
      // owner_name (the create path re-finds with relations: ['owner']).
      // Reflects what TypeORM returns: the saved row hydrated with the
      // requested relation, not the pre-save baseCollection snapshot.
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        title: 'Beskydy Loops',
        visibility: 'unlisted',
      });

      const result = await service.create(ownerId, {
        title: '  Beskydy Loops  ',
        visibility: 'unlisted',
      });

      const createMock = collectionRepo.create as jest.Mock;
      const createArgs = createMock.mock
        .calls[0]?.[0] as Partial<RouteCollection>;
      expect(createArgs?.title).toBe('Beskydy Loops');
      expect(createArgs?.visibility).toBe('unlisted');
      expect(createArgs?.slug).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(result.visibility).toBe('unlisted');
      expect(result.items).toEqual([]);
      // Re-load uses relations: ['owner'] so the response carries owner_name
      // — without that, every POST /collections response was `owner_name: ''`.
      expect(result.owner_name).toBe('Jane Rider');
      // Owners always render with viewer_is_owner=true, viewer_is_following=false
      // so the create response never surfaces a stale follow flag.
      expect(result.viewer_is_owner).toBe(true);
      expect(result.viewer_is_following).toBe(false);
    });

    it('falls back to private visibility when none is supplied', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
      });

      await service.create(ownerId, { title: 'Untitled' });
      const createMock = collectionRepo.create as jest.Mock;
      const createArgs = createMock.mock
        .calls[0]?.[0] as Partial<RouteCollection>;
      expect(createArgs?.visibility).toBe('private');
    });

    it('still returns the detail when the post-save re-find yields nothing', async () => {
      // Defensive path: if the row is gone by the time we re-find (race with
      // a concurrent delete from another tab), fall back to the saved entity
      // and just send an empty owner_name rather than 500ing the create.
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(null);

      const result = await service.create(ownerId, { title: 'Edge case' });
      expect(result.id).toBe(baseCollection.id);
      expect(result.owner_name).toBe('');
    });
  });

  describe('getOwned', () => {
    it('returns the detail when the caller owns the collection', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      const result = await service.getOwned(ownerId, collectionId);
      expect(result.id).toBe(collectionId);
      expect(result.viewer_is_owner).toBe(true);
      expect(result.viewer_is_following).toBe(false);
    });

    it('404s for non-owners (no 403 — id existence is not a side channel)', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      await expect(service.getOwned(otherId, collectionId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s when the collection does not exist', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.getOwned(ownerId, collectionId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getBySlug (visibility gating + viewer flags)', () => {
    it('returns public collections to anyone', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      const result = await service.getBySlug('abcDEF12345', null);
      expect(result.visibility).toBe('public');
      expect(result.owner_name).toBe('Jane Rider');
      expect(result.viewer_is_owner).toBe(false);
      expect(result.viewer_is_following).toBe(false);
    });

    it('returns unlisted collections to anyone with the slug', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'unlisted',
      });
      const result = await service.getBySlug('abcDEF12345', null);
      expect(result.visibility).toBe('unlisted');
    });

    it('404s for private collections — slug is not dereferenceable', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'private',
      });
      await expect(service.getBySlug('abcDEF12345', null)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('hides public collections whose owner is in the deletion grace window', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
        owner: { display_name: 'Jane Rider', deleted_at: new Date() },
      });
      await expect(service.getBySlug('abcDEF12345', null)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s when the slug does not resolve', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.getBySlug('missing', null)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('flags viewer_is_owner when the signed-in viewer is the owner', async () => {
      // Owners viewing their own public/unlisted slug get viewer_is_owner=true
      // so the public page hides the follow CTA (they already have CRUD).
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      const result = await service.getBySlug('abcDEF12345', ownerId);
      expect(result.viewer_is_owner).toBe(true);
      expect(result.viewer_is_following).toBe(false);
      // Owner check skips the followRepo.exists call — there's no point
      // looking up a row we'd never write.
      expect(followRepo.exists).not.toHaveBeenCalled();
    });

    it('flags viewer_is_following when the signed-in viewer follows', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      (followRepo.exists as jest.Mock).mockResolvedValueOnce(true);
      const result = await service.getBySlug('abcDEF12345', otherId);
      expect(result.viewer_is_owner).toBe(false);
      expect(result.viewer_is_following).toBe(true);
      expect(followRepo.exists).toHaveBeenCalledWith({
        where: { user_id: otherId, collection_id: collectionId },
      });
    });
  });

  describe('update', () => {
    it('applies partial updates for the owner', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
      });
      const result = await service.update(ownerId, collectionId, {
        title: 'Renamed',
        visibility: 'public',
      });
      expect(result.title).toBe('Renamed');
      expect(result.visibility).toBe('public');
    });

    it('rejects empty titles', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
      });
      await expect(
        service.update(ownerId, collectionId, { title: '   ' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 403 for non-owners', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      await expect(
        service.update(otherId, collectionId, { title: 'Renamed' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws 404 when the collection is missing', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(
        service.update(ownerId, collectionId, { title: 'Renamed' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('removes the collection when the caller is the owner', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      await service.delete(ownerId, collectionId);
      expect(collectionRepo.remove).toHaveBeenCalledWith(baseCollection);
    });

    it('throws 403 when the caller is not the owner', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      await expect(service.delete(otherId, collectionId)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws 404 when the collection is missing', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.delete(ownerId, collectionId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('addItem', () => {
    it('rejects when neither trip_id nor ride_id is provided', async () => {
      await expect(service.addItem(ownerId, collectionId, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects when both trip_id and ride_id are provided', async () => {
      await expect(
        service.addItem(ownerId, collectionId, {
          trip_id: tripId,
          ride_id: '00000000-0000-0000-0000-000000000020',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns the existing row on duplicate add (idempotent)', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      const existing = {
        id: 'item-existing',
        collection_id: collectionId,
        trip_id: tripId,
        ride_id: null,
        position: 2,
        created_at: new Date('2026-04-19T10:00:00Z'),
      };
      (itemRepo.findOne as jest.Mock).mockResolvedValueOnce(existing);

      const result = await service.addItem(ownerId, collectionId, {
        trip_id: tripId,
      });
      expect(result.id).toBe('item-existing');
      expect(itemRepo.save).not.toHaveBeenCalled();
    });

    it('throws 403 when the caller is not the owner', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      await expect(
        service.addItem(otherId, collectionId, { trip_id: tripId }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('locks the parent row to serialise concurrent MAX(position)+1', async () => {
      // READ COMMITTED isolation does not prevent two concurrent
      // addItem transactions from reading the same MAX(position) and
      // writing duplicate position values. The fix is a pessimistic
      // write lock on the parent row inside the txn — assert here that
      // the lock option survives any future refactor.
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      (itemRepo.findOne as jest.Mock).mockResolvedValueOnce(null);

      await service.addItem(ownerId, collectionId, { trip_id: tripId });

      expect(collectionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: collectionId },
          lock: { mode: 'pessimistic_write' },
        }),
      );
    });
  });

  describe('removeItem', () => {
    it('removes the item for the owner', async () => {
      const item = {
        id: 'item-1',
        collection_id: collectionId,
        trip_id: tripId,
        ride_id: null,
        position: 0,
      };
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      (itemRepo.findOne as jest.Mock).mockResolvedValueOnce(item);

      await service.removeItem(ownerId, collectionId, 'item-1');
      expect(itemRepo.remove).toHaveBeenCalledWith(item);
    });

    it('throws 403 when the caller is not the owner', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      await expect(
        service.removeItem(otherId, collectionId, 'item-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws 404 when the item does not belong to the collection', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      (itemRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(
        service.removeItem(ownerId, collectionId, 'item-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('follow', () => {
    it('creates a follow row for a public collection', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        owner_id: ownerId,
        visibility: 'public',
      });

      const result = await service.follow(otherId, collectionId);

      expect(followRepo.create).toHaveBeenCalledWith({
        user_id: otherId,
        collection_id: collectionId,
      });
      expect(followRepo.save).toHaveBeenCalled();
      expect(result.collection_id).toBe(collectionId);
      expect(result.followed_at).toBe('2026-04-20T11:00:00.000Z');
    });

    it('falls back to the existing row on a unique-violation race (idempotent)', async () => {
      // Simulates two concurrent POSTs both passing the visibility check and
      // racing to insert. The losing call hits SQLSTATE 23505; the service
      // re-reads the canonical row instead of bubbling a 500.
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        owner_id: ownerId,
        visibility: 'public',
      });
      const uniqueViolation = Object.assign(new Error('duplicate'), {
        code: '23505',
      });
      (followRepo.save as jest.Mock).mockRejectedValueOnce(uniqueViolation);
      (followRepo.findOne as jest.Mock).mockResolvedValueOnce({
        id: 'follow-existing',
        user_id: otherId,
        collection_id: collectionId,
        created_at: new Date('2026-04-19T10:00:00Z'),
      });

      const result = await service.follow(otherId, collectionId);
      expect(result.followed_at).toBe('2026-04-19T10:00:00.000Z');
    });

    it('detects the unique violation when wrapped in a QueryFailedError shape', async () => {
      // TypeORM wraps the raw pg error; the `code` lives on `driverError`.
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        owner_id: ownerId,
        visibility: 'public',
      });
      const wrapped = Object.assign(new Error('query failed'), {
        driverError: { code: '23505' },
      });
      (followRepo.save as jest.Mock).mockRejectedValueOnce(wrapped);
      (followRepo.findOne as jest.Mock).mockResolvedValueOnce({
        id: 'follow-existing',
        user_id: otherId,
        collection_id: collectionId,
        created_at: new Date('2026-04-19T10:00:00Z'),
      });

      const result = await service.follow(otherId, collectionId);
      expect(result.followed_at).toBe('2026-04-19T10:00:00.000Z');
    });

    it('rethrows non-unique save errors so 500s are not swallowed', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        owner_id: ownerId,
        visibility: 'public',
      });
      const dbDown = Object.assign(new Error('connection lost'), {
        code: '08006',
      });
      (followRepo.save as jest.Mock).mockRejectedValueOnce(dbDown);

      await expect(service.follow(otherId, collectionId)).rejects.toThrow(
        'connection lost',
      );
    });

    it('rejects when the owner tries to follow their own collection', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      // Owners are surfaced with viewer_is_owner=true and have CRUD on
      // /collections/:id; following their own would create a no-op row in
      // the library. 400 (BadRequest) keeps it loud rather than silent.
      await expect(service.follow(ownerId, collectionId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('404s when the collection is private', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'private',
      });
      await expect(service.follow(otherId, collectionId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s when the owner is in the deletion grace window', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
        owner: { display_name: 'Jane Rider', deleted_at: new Date() },
      });
      await expect(service.follow(otherId, collectionId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s when the collection does not exist', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.follow(otherId, collectionId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('unfollow', () => {
    it('issues a delete keyed by the (user, collection) pair', async () => {
      await service.unfollow(otherId, collectionId);
      expect(followRepo.delete).toHaveBeenCalledWith({
        user_id: otherId,
        collection_id: collectionId,
      });
    });

    it('is idempotent — succeeds when no row exists', async () => {
      (followRepo.delete as jest.Mock).mockResolvedValueOnce({ affected: 0 });
      await expect(
        service.unfollow(otherId, collectionId),
      ).resolves.toBeUndefined();
    });
  });
});

function buildListQueryBuilder() {
  const qb = {
    leftJoin: jest.fn(),
    where: jest.fn(),
    select: jest.fn(),
    addSelect: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    getRawAndEntities: jest.fn().mockResolvedValue({ entities: [], raw: [] }),
  };
  qb.leftJoin.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  qb.select.mockReturnValue(qb);
  qb.addSelect.mockReturnValue(qb);
  qb.groupBy.mockReturnValue(qb);
  qb.orderBy.mockReturnValue(qb);
  return qb;
}
