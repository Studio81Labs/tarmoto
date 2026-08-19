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
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { RouteCollectionsService } from './route-collections.service.js';

describe('RouteCollectionsService', () => {
  let service: RouteCollectionsService;
  let collectionRepo: Partial<jest.Mocked<Repository<RouteCollection>>>;
  let itemRepo: Partial<jest.Mocked<Repository<RouteCollectionItem>>>;
  let followRepo: Partial<jest.Mocked<Repository<RouteCollectionFollow>>>;
  let privacy: { loadPrivateUserIds: jest.Mock };
  let featureResolver: { isSystemSwitchEnabled: jest.Mock };
  let privateUserIds: Set<string>;
  let queryMock: jest.Mock;

  const ownerId = 'user-1';
  const otherId = 'user-2';
  const collectionId = '00000000-0000-0000-0000-000000000001';
  const rideId = '00000000-0000-0000-0000-000000000020';

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
      // `toDetailResponse` counts followers for the detail-page stats; default
      // to 0 so the many detail-returning paths don't need per-test wiring.
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation((data) => ({
        id: 'follow-new',
        created_at: new Date('2026-04-20T11:00:00Z'),
        ...data,
      })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    privateUserIds = new Set();
    privacy = {
      loadPrivateUserIds: jest
        .fn()
        .mockImplementation(() => Promise.resolve(new Set(privateUserIds))),
    };

    featureResolver = {
      isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
    };

    // The service's `addItem` opens a transaction; mock it to invoke the
    // callback with a manager that returns the same mocks. Avoids needing a
    // real DataSource for unit tests. `query` is mocked to return [] by
    // default — `getPreviewBySlug` tests override per-call via mockReturnValueOnce.
    queryMock = jest.fn().mockResolvedValue([]);
    const dataSource: Partial<DataSource> = {
      transaction: jest
        .fn()
        .mockImplementation((cb: (mgr: unknown) => Promise<unknown>) =>
          cb({
            getRepository: (target: unknown) =>
              target === RouteCollection ? collectionRepo : itemRepo,
          }),
        ),
      query: queryMock,
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
        { provide: PrivacyPreferencesService, useValue: privacy },
        { provide: DataSource, useValue: dataSource },
        { provide: FeatureResolver, useValue: featureResolver },
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

    it('masks owner_name on followed cards when the curator is private (#279 / #501)', async () => {
      const followedCol = {
        ...baseCollection,
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        owner_id: otherId,
        visibility: 'public',
        title: 'Followed by me',
      };
      (collectionRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getRawAndEntities: jest
            .fn()
            .mockResolvedValue({ entities: [], raw: [] }),
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
            raw: [
              {
                c_id: followedCol.id,
                item_count: '4',
                owner_name: 'Jane Rider',
              },
            ],
          }),
        });

      privateUserIds = new Set([otherId]);

      const result = await service.listLibrary(ownerId);

      expect(result.followed).toHaveLength(1);
      expect(result.followed[0]?.owner_name).toBeNull();
      // #279 / #501 — also mask owner_id so it can't be cross-
      // referenced to recover the rider's identity (Cursor Bugbot
      // review on PR #513).
      expect(result.followed[0]?.owner_id).toBeNull();
    });

    it('keeps owner_name on followed cards when the curator is not private (#279 / #501)', async () => {
      const followedCol = {
        ...baseCollection,
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        owner_id: otherId,
        visibility: 'public',
        title: 'Followed by me',
      };
      (collectionRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getRawAndEntities: jest
            .fn()
            .mockResolvedValue({ entities: [], raw: [] }),
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
            raw: [
              {
                c_id: followedCol.id,
                item_count: '4',
                owner_name: 'Jane Rider',
              },
            ],
          }),
        });

      privateUserIds = new Set();

      const result = await service.listLibrary(ownerId);

      expect(result.followed).toHaveLength(1);
      expect(result.followed[0]?.owner_name).toBe('Jane Rider');
    });

    it('returns owned list with empty followed when follow table is missing (42P01)', async () => {
      const ownedCol = { ...baseCollection };
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
            raw: [{ c_id: ownedCol.id, item_count: '1' }],
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
          getRawAndEntities: jest.fn().mockRejectedValue(
            Object.assign(new Error('relation does not exist'), {
              code: '42P01',
            }),
          ),
        });

      const result = await service.listLibrary(ownerId);
      expect(result.owned).toHaveLength(1);
      expect(result.owned[0]?.id).toBe(ownedCol.id);
      expect(result.followed).toEqual([]);
    });

    it('rethrows non-42P01 errors from the followed query so they are not silently swallowed', async () => {
      const ownedCol = { ...baseCollection };
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
            raw: [{ c_id: ownedCol.id, item_count: '1' }],
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
          getRawAndEntities: jest.fn().mockRejectedValue(
            Object.assign(new Error('connection lost'), {
              code: '08006',
            }),
          ),
        });

      await expect(service.listLibrary(ownerId)).rejects.toThrow(
        'connection lost',
      );
    });
  });

  describe('listDiscover', () => {
    // The discover query is built via a `base()` helper called twice (rows +
    // count); a single capturing qb mock collects every `andWhere` clause so
    // we can assert the owner-exclusion filter is (or isn't) applied.
    function mockDiscoverQb(andWhereClauses: string[]) {
      // `andWhere` is declared separately so its capturing implementation can
      // reference `qb` without a circular initializer (TS7022).
      const andWhere = jest.fn();
      const qb = {
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere,
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
        getCount: jest.fn().mockResolvedValue(0),
      };
      andWhere.mockImplementation((clause: string) => {
        andWhereClauses.push(clause);
        return qb;
      });
      return qb;
    }

    it('returns an empty page when sys_community_collections is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      const result = await service.listDiscover(ownerId, undefined, 12, 0);
      expect(result).toEqual({ items: [], total: 0, limit: 12, offset: 0 });
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_community_collections',
      );
      // Scope guard: the discover query was NOT run
      expect(collectionRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('does NOT gate the personal library (listMine) on sys_community_collections', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      (collectionRepo.createQueryBuilder as jest.Mock).mockReturnValueOnce({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawAndEntities: jest
          .fn()
          .mockResolvedValue({ entities: [], raw: [] }),
      });
      await service.listMine(ownerId);
      // listMine ran its query normally (should not consult the switch)
      expect(collectionRepo.createQueryBuilder).toHaveBeenCalled();
      expect(featureResolver.isSystemSwitchEnabled).not.toHaveBeenCalled();
    });

    it("excludes the viewer's own collections so Discover stays other members'", async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(true);
      const clauses: string[] = [];
      (collectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        mockDiscoverQb(clauses),
      );

      await service.listDiscover(ownerId, undefined);

      expect(clauses).toContain('c.owner_id <> :viewerId');
    });

    it('does not apply the owner filter for anonymous viewers', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(true);
      const clauses: string[] = [];
      (collectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        mockDiscoverQb(clauses),
      );

      await service.listDiscover(null, undefined);

      expect(clauses).not.toContain('c.owner_id <> :viewerId');
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

    it('includes the follower count from the follow repo', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      (followRepo.count as jest.Mock).mockResolvedValueOnce(7);
      const result = await service.getOwned(ownerId, collectionId);
      expect(result.follower_count).toBe(7);
      expect(followRepo.count).toHaveBeenCalledWith({
        where: { collection_id: collectionId },
      });
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

  describe('getPreviewOwned', () => {
    it("returns item previews for the owner's own collection (any visibility)", async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'private',
      });
      // Empty collection → no geometry queries, `routes` is [].
      (itemRepo.find as jest.Mock).mockResolvedValueOnce([]);
      const result = await service.getPreviewOwned(ownerId, collectionId);
      expect(result.routes).toEqual([]);
    });

    it('404s for a non-owner (no 403 — id existence is not a side channel)', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      await expect(
        service.getPreviewOwned(otherId, collectionId),
      ).rejects.toThrow(NotFoundException);
    });

    it('404s when the collection does not exist', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(
        service.getPreviewOwned(ownerId, collectionId),
      ).rejects.toThrow(NotFoundException);
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

    it('masks owner_name for non-owner viewers when owner is private (#279 / #501)', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      privateUserIds = new Set([ownerId]);

      const result = await service.getBySlug('abcDEF12345', otherId);

      // `null` matches `listLibrary`'s followed-card shape so a client
      // can use the same `owner_name === null` check on every surface
      // (Cursor Bugbot review on PR #513).
      expect(result.owner_name).toBeNull();
      // owner_id is masked alongside the name (Cursor Bugbot review
      // on PR #513) — exposing the id alone would let a caller
      // recover the rider's identity via `/users/:id/profile`.
      expect(result.owner_id).toBeNull();
    });

    it('keeps owner_name for the owner viewing their own private profile slug (#279 / #501)', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      // The self-view branch skips the privacy lookup entirely —
      // the owner always sees their own name on their own
      // collection. Even seeding `privateUserIds` with the owner
      // here must NOT mask, because we never call the helper.
      privateUserIds = new Set([ownerId]);

      const result = await service.getBySlug('abcDEF12345', ownerId);

      expect(result.owner_name).toBe('Jane Rider');
      // Self-view also keeps `owner_id` populated — the mask only
      // applies to non-owner viewers.
      expect(result.owner_id).toBe(ownerId);
      expect(privacy.loadPrivateUserIds).not.toHaveBeenCalled();
    });

    it('keeps owner_name for non-owner viewers when owner is not private (#279 / #501)', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      privateUserIds = new Set();

      const result = await service.getBySlug('abcDEF12345', otherId);

      expect(result.owner_name).toBe('Jane Rider');
    });
  });

  describe('getPreviewBySlug (map preview geometries)', () => {
    const rideA = '00000000-0000-0000-0000-000000000020';
    const rideB = '00000000-0000-0000-0000-000000000021';

    function lineStringJson(coords: number[][]): string {
      return JSON.stringify({ type: 'LineString', coordinates: coords });
    }

    it('404s for private slugs (matches getBySlug gating)', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'private',
      });
      await expect(service.getPreviewBySlug('abcDEF12345')).rejects.toThrow(
        NotFoundException,
      );
      // No geometry queries should fire when the gate trips.
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('404s when the owner is in the deletion grace window', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
        owner: { display_name: 'Jane Rider', deleted_at: new Date() },
      });
      await expect(service.getPreviewBySlug('abcDEF12345')).rejects.toThrow(
        NotFoundException,
      );
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('404s when the slug does not resolve', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.getPreviewBySlug('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns an empty routes array for an empty collection without hitting geometry tables', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      (itemRepo.find as jest.Mock).mockResolvedValueOnce([]);
      const result = await service.getPreviewBySlug('abcDEF12345');
      expect(result).toEqual({ routes: [] });
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('pairs ride geometry + summary by id in collection order', async () => {
      const items = [
        {
          id: 'item-ride-a',
          collection_id: collectionId,
          ride_id: rideA,
          position: 0,
          created_at: new Date(),
        },
        {
          id: 'item-ride-b',
          collection_id: collectionId,
          ride_id: rideB,
          position: 1,
          created_at: new Date(),
        },
      ];

      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      (itemRepo.find as jest.Mock).mockResolvedValueOnce(items);

      // Two batched queries: ride geometry first, then ride metadata. Order is
      // determined by Promise.all argument position.
      queryMock
        .mockResolvedValueOnce([
          {
            id: rideA,
            geometry: lineStringJson([
              [14, 50],
              [14.1, 50.1],
              [14.2, 50.15],
            ]),
          },
          {
            id: rideB,
            geometry: lineStringJson([
              [20, 49],
              [21, 49.1],
            ]),
          },
        ])
        // Ride metadata. `is_public: true` → the ride is deep-linkable.
        .mockResolvedValueOnce([
          {
            id: rideA,
            name: 'Ride A',
            status: 'completed',
            distance_km: 45,
            avg_road_quality: 3.5,
            is_public: true,
          },
          {
            id: rideB,
            name: 'Ride B',
            status: 'active',
            distance_km: 60,
            avg_road_quality: null,
            is_public: true,
          },
        ]);

      const result = await service.getPreviewBySlug('abcDEF12345');
      expect(result.routes).toHaveLength(2);

      // Items remain in collection (position) order, carrying the per-item
      // summary fields a non-owner viewer renders.
      expect(result.routes[0]).toMatchObject({
        item_id: 'item-ride-a',
        // `target_id` is the underlying ride id the client deep-links to.
        target_id: rideA,
        position: 0,
        title: 'Ride A',
        distance_km: 45,
        status: 'completed',
        quality_avg: 3.5,
      });
      expect(result.routes[0]?.lines).toHaveLength(1);
      expect(result.routes[1]).toMatchObject({
        item_id: 'item-ride-b',
        target_id: rideB,
        position: 1,
        title: 'Ride B',
        distance_km: 60,
        status: 'active',
        quality_avg: null,
      });
      expect(result.routes[1]?.lines).toHaveLength(1);
      // Trips are never surfaced — the row shape carries no `kind`/`num_days`.
      expect(result.routes[0]).not.toHaveProperty('kind');
      expect(result.routes[0]).not.toHaveProperty('num_days');

      // Two queries: geometry + metadata, both over `rides`.
      expect(queryMock).toHaveBeenCalledTimes(2);
      // Use the SQL text rather than positional args so refactors that re-order
      // params don't silently invalidate the assertion.
      const calls = queryMock.mock.calls.map((c) => c[0] as string);
      expect(calls.every((sql) => /FROM\s+rides/i.test(sql))).toBe(true);
      // No trip tables must be touched.
      expect(calls.some((sql) => /trip_days|FROM\s+trips/i.test(sql))).toBe(
        false,
      );
      // The geometry query must apply the simplification — that's the perf
      // lever for 20+ item collections (the issue's acceptance criterion).
      expect(
        calls
          .filter((sql) => /ST_AsGeoJSON/.test(sql))
          .every((sql) => /ST_SimplifyPreserveTopology/.test(sql)),
      ).toBe(true);
      // Owner-scoped so a ride the owner can't access can't leak — rides scope
      // via `user_id` (no ride sharing).
      expect(calls.every((sql) => /user_id\s*=/.test(sql))).toBe(true);
      // The owner id is threaded into each query's params.
      expect(
        queryMock.mock.calls.every((c) =>
          (c[1] as unknown[]).includes(ownerId),
        ),
      ).toBe(true);
    });

    it('leaves target_id null for a ride that is not publicly shared (non-clickable)', async () => {
      const items = [
        {
          id: 'item-ride-private',
          collection_id: collectionId,
          ride_id: rideA,
          position: 0,
          created_at: new Date(),
        },
      ];

      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      (itemRepo.find as jest.Mock).mockResolvedValueOnce(items);
      // Ride geometry, then ride metadata with `is_public: false`.
      queryMock
        .mockResolvedValueOnce([
          {
            id: rideA,
            geometry: lineStringJson([
              [14, 50],
              [14.1, 50.1],
            ]),
          },
        ])
        .mockResolvedValueOnce([
          {
            id: rideA,
            name: 'Private Ride',
            status: 'completed',
            distance_km: 30,
            avg_road_quality: 3.0,
            is_public: false,
          },
        ]);

      const result = await service.getPreviewBySlug('abcDEF12345');
      expect(result.routes).toHaveLength(1);
      // The row still renders (title + geometry) but must not be deep-linked —
      // `/community/rides/:id` would 404 a non-owner for a non-public ride.
      expect(result.routes[0]).toMatchObject({
        item_id: 'item-ride-private',
        title: 'Private Ride',
        target_id: null,
      });
      expect(result.routes[0]?.lines).toHaveLength(1);
    });

    it('leaves target_id null for a public ride when the owner keeps a private profile (non-clickable)', async () => {
      const items = [
        {
          id: 'item-ride-pub',
          collection_id: collectionId,
          ride_id: rideA,
          position: 0,
          created_at: new Date(),
        },
      ];

      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      (itemRepo.find as jest.Mock).mockResolvedValueOnce(items);
      // Even a publicly-shared ride must not be linked when its owner is
      // private — `RidesService.getDetail` 404s every non-owner in that case.
      privateUserIds = new Set([ownerId]);
      queryMock
        .mockResolvedValueOnce([
          {
            id: rideA,
            geometry: lineStringJson([
              [14, 50],
              [14.1, 50.1],
            ]),
          },
        ])
        .mockResolvedValueOnce([
          {
            id: rideA,
            name: 'Public Ride',
            status: 'completed',
            distance_km: 30,
            avg_road_quality: 3.0,
            is_public: true,
          },
        ]);

      const result = await service.getPreviewBySlug('abcDEF12345');
      expect(result.routes[0]).toMatchObject({
        item_id: 'item-ride-pub',
        target_id: null,
      });
    });

    it('returns empty lines for items whose underlying ride has been deleted', async () => {
      const items = [
        {
          id: 'item-orphan-a',
          collection_id: collectionId,
          ride_id: rideA,
          position: 0,
          created_at: new Date(),
        },
        {
          id: 'item-orphan-b',
          collection_id: collectionId,
          ride_id: rideB,
          position: 1,
          created_at: new Date(),
        },
      ];

      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      (itemRepo.find as jest.Mock).mockResolvedValueOnce(items);
      // Both batched queries return no rows — simulates rides rows being
      // deleted while the collection item rows still reference the original ids.
      queryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await service.getPreviewBySlug('abcDEF12345');
      expect(result.routes).toHaveLength(2);
      // The order/position is preserved so the client can keep the list
      // aligned with the detail response; missing items just have no
      // polylines to draw.
      expect(result.routes[0]?.lines).toEqual([]);
      expect(result.routes[1]?.lines).toEqual([]);
    });

    it('drops degenerate geometries (fewer than 2 valid points)', async () => {
      const items = [
        {
          id: 'item-ride-a',
          collection_id: collectionId,
          ride_id: rideA,
          position: 0,
          created_at: new Date(),
        },
      ];
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      (itemRepo.find as jest.Mock).mockResolvedValueOnce(items);
      queryMock
        .mockResolvedValueOnce([
          // ST_SimplifyPreserveTopology can theoretically return a point
          // with only one coord, or even null. The helper must drop those
          // rather than passing them through as a malformed LineString.
          { id: rideA, geometry: lineStringJson([[10, 50]]) },
          { id: rideA, geometry: null },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getPreviewBySlug('abcDEF12345');
      expect(result.routes[0]?.lines).toEqual([]);
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
    it('persists a new ride item at the next position', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      (itemRepo.findOne as jest.Mock).mockResolvedValueOnce(null);

      const result = await service.addItem(ownerId, collectionId, {
        ride_id: rideId,
      });

      expect(itemRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          collection_id: collectionId,
          ride_id: rideId,
          position: 0,
        }),
      );
      expect(itemRepo.save).toHaveBeenCalledTimes(1);
      expect(result.ride_id).toBe(rideId);
    });

    it('returns the existing row on duplicate add (idempotent)', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      const existing = {
        id: 'item-existing',
        collection_id: collectionId,
        ride_id: rideId,
        position: 2,
        created_at: new Date('2026-04-19T10:00:00Z'),
      };
      (itemRepo.findOne as jest.Mock).mockResolvedValueOnce(existing);

      const result = await service.addItem(ownerId, collectionId, {
        ride_id: rideId,
      });
      expect(result.id).toBe('item-existing');
      expect(itemRepo.save).not.toHaveBeenCalled();
    });

    it('throws 403 when the caller is not the owner', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      await expect(
        service.addItem(otherId, collectionId, { ride_id: rideId }),
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

      await service.addItem(ownerId, collectionId, { ride_id: rideId });

      expect(collectionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: collectionId },
          lock: { mode: 'pessimistic_write' },
        }),
      );
    });
  });

  describe('reorderItems', () => {
    const itemA = {
      id: '00000000-0000-0000-0000-0000000000a1',
      collection_id: collectionId,
      ride_id: rideId,
      position: 0,
      created_at: new Date('2026-04-20T10:00:00Z'),
    } as RouteCollectionItem;
    const itemB = {
      id: '00000000-0000-0000-0000-0000000000a2',
      collection_id: collectionId,
      ride_id: '00000000-0000-0000-0000-000000000021',
      position: 1,
      created_at: new Date('2026-04-20T10:01:00Z'),
    } as RouteCollectionItem;
    const itemC = {
      id: '00000000-0000-0000-0000-0000000000a3',
      collection_id: collectionId,
      ride_id: '00000000-0000-0000-0000-000000000022',
      position: 2,
      created_at: new Date('2026-04-20T10:02:00Z'),
    } as RouteCollectionItem;

    it('rejects duplicate ids in item_ids before opening the transaction', async () => {
      // Set-equality on size + membership would silently accept a duplicate
      // paired with a missing id of the same length. Catch it explicitly so
      // the client gets a precise 400 instead of a confusing "missing item".
      await expect(
        service.reorderItems(ownerId, collectionId, {
          item_ids: [itemA.id, itemA.id, itemC.id],
        }),
      ).rejects.toThrow(BadRequestException);
      // Pre-flight rejects must not even open the txn.
      expect(itemRepo.find).not.toHaveBeenCalled();
    });

    it('rejects when item_ids size differs from the current item count', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      (itemRepo.find as jest.Mock).mockResolvedValueOnce([itemA, itemB, itemC]);
      await expect(
        service.reorderItems(ownerId, collectionId, {
          item_ids: [itemA.id, itemB.id],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(itemRepo.save).not.toHaveBeenCalled();
    });

    it('rejects when item_ids references an id that is not in the collection', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      (itemRepo.find as jest.Mock).mockResolvedValueOnce([itemA, itemB]);
      await expect(
        service.reorderItems(ownerId, collectionId, {
          item_ids: [itemA.id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(itemRepo.save).not.toHaveBeenCalled();
    });

    it('throws 403 when the caller is not the owner', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      await expect(
        service.reorderItems(otherId, collectionId, {
          item_ids: [itemA.id, itemB.id],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws 404 when the collection does not exist', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(
        service.reorderItems(ownerId, collectionId, {
          item_ids: [itemA.id, itemB.id],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('renumbers positions 0..N-1 in the requested order and bumps updated_at', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        // Mutable copy so the updated_at bump is observable across calls.
        updated_at: new Date('2026-04-20T10:00:00Z'),
      });
      (itemRepo.find as jest.Mock)
        .mockResolvedValueOnce([itemA, itemB, itemC])
        // Final re-read after save returns the renumbered rows in the
        // ORDER BY position output the helper would deliver.
        .mockResolvedValueOnce([
          { ...itemC, position: 0 },
          { ...itemA, position: 1 },
          { ...itemB, position: 2 },
        ]);

      const result = await service.reorderItems(ownerId, collectionId, {
        item_ids: [itemC.id, itemA.id, itemB.id],
      });

      // Single bulk save — assert the entities passed to save() carry the
      // new positions in the requested order. Renumbering 0..N-1 keeps the
      // ordering scheme dense and lets a future "insert at position 2"
      // editor stay simple.
      expect(itemRepo.save).toHaveBeenCalledTimes(1);
      const savedArg = (itemRepo.save as jest.Mock).mock.calls[0]![0] as
        RouteCollectionItem[] | RouteCollectionItem;
      const saved = Array.isArray(savedArg) ? savedArg : [savedArg];
      expect(saved.map((i) => [i.id, i.position])).toEqual([
        [itemC.id, 0],
        [itemA.id, 1],
        [itemB.id, 2],
      ]);
      // Items in the response come from the ORDER BY re-read, so they're
      // 0..N-1 monotonically — same shape as the rest of the API.
      expect(result.items.map((i) => i.position)).toEqual([0, 1, 2]);
      expect(result.items.map((i) => i.id)).toEqual([
        itemC.id,
        itemA.id,
        itemB.id,
      ]);
      // Bumping updated_at keeps the listing sort and the public-page cache
      // honest — without it a reorder would look like a non-event.
      expect(collectionRepo.save).toHaveBeenCalled();
    });

    it('locks the parent row to serialise concurrent reorders / adds', async () => {
      // Same hazard as addItem — without a parent-row write lock a
      // concurrent add could insert a row mid-renumber that ends up with a
      // colliding position. The lock survives any future refactor only if
      // we assert it here.
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseCollection,
      );
      (itemRepo.find as jest.Mock).mockResolvedValueOnce([itemA, itemB]);

      await service.reorderItems(ownerId, collectionId, {
        item_ids: [itemB.id, itemA.id],
      });

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
        ride_id: rideId,
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
