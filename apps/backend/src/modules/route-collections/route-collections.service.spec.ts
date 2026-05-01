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
import { RouteCollectionsService } from './route-collections.service.js';

describe('RouteCollectionsService', () => {
  let service: RouteCollectionsService;
  let collectionRepo: Partial<jest.Mocked<Repository<RouteCollection>>>;
  let itemRepo: Partial<jest.Mocked<Repository<RouteCollectionItem>>>;

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
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<RouteCollectionsService>(RouteCollectionsService);
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

  describe('getBySlug (visibility gating)', () => {
    it('returns public collections to anyone', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
      });
      const result = await service.getBySlug('abcDEF12345');
      expect(result.visibility).toBe('public');
      expect(result.owner_name).toBe('Jane Rider');
    });

    it('returns unlisted collections to anyone with the slug', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'unlisted',
      });
      const result = await service.getBySlug('abcDEF12345');
      expect(result.visibility).toBe('unlisted');
    });

    it('404s for private collections — slug is not dereferenceable', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'private',
      });
      await expect(service.getBySlug('abcDEF12345')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('hides public collections whose owner is in the deletion grace window', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce({
        ...baseCollection,
        visibility: 'public',
        owner: { display_name: 'Jane Rider', deleted_at: new Date() },
      });
      await expect(service.getBySlug('abcDEF12345')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s when the slug does not resolve', async () => {
      (collectionRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.getBySlug('missing')).rejects.toThrow(
        NotFoundException,
      );
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
