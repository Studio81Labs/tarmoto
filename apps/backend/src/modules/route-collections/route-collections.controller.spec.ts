/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { RouteCollectionsController } from './route-collections.controller.js';
import { RouteCollectionsService } from './route-collections.service.js';

describe('RouteCollectionsController', () => {
  let controller: RouteCollectionsController;
  let service: jest.Mocked<RouteCollectionsService>;

  const mockReq = { user: { userId: 'user-1' } } as never;
  const collectionId = '00000000-0000-0000-0000-000000000001';
  const itemId = '00000000-0000-0000-0000-000000000002';

  const detail = {
    id: collectionId,
    owner_id: 'user-1',
    title: 'Beskydy Loops',
    description: null,
    visibility: 'private' as const,
    slug: 'abcDEF12345',
    item_count: 0,
    items: [],
    owner_name: 'Jane Rider',
    created_at: '2026-04-20T10:00:00.000Z',
    updated_at: '2026-04-20T10:00:00.000Z',
  };

  beforeEach(async () => {
    const mockService = {
      listMine: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      create: jest.fn().mockResolvedValue(detail),
      getOwned: jest.fn().mockResolvedValue(detail),
      getBySlug: jest.fn().mockResolvedValue(detail),
      update: jest.fn().mockResolvedValue(detail),
      delete: jest.fn().mockResolvedValue(undefined),
      addItem: jest.fn().mockResolvedValue({
        id: itemId,
        trip_id: '00000000-0000-0000-0000-000000000010',
        ride_id: null,
        position: 0,
        created_at: '2026-04-20T10:00:00.000Z',
      }),
      removeItem: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RouteCollectionsController],
      providers: [
        { provide: RouteCollectionsService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<RouteCollectionsController>(
      RouteCollectionsController,
    );
    service = module.get(RouteCollectionsService);
  });

  it('GET /collections/me delegates to listMine with the caller userId', async () => {
    const result = await controller.listMine(mockReq);
    expect(service.listMine).toHaveBeenCalledWith('user-1');
    expect(result.total).toBe(0);
  });

  it('POST /collections forwards the dto to create', async () => {
    const result = await controller.create(mockReq, {
      title: 'Beskydy Loops',
      visibility: 'private',
    });
    expect(service.create).toHaveBeenCalledWith('user-1', {
      title: 'Beskydy Loops',
      visibility: 'private',
    });
    expect(result.id).toBe(collectionId);
  });

  it('GET /collections/by-slug/:slug skips auth and forwards the slug', async () => {
    const result = await controller.getBySlug('abcDEF12345');
    expect(service.getBySlug).toHaveBeenCalledWith('abcDEF12345');
    expect(result.slug).toBe('abcDEF12345');
  });

  it('GET /collections/:id delegates to getOwned', async () => {
    const result = await controller.getOwned(mockReq, collectionId);
    expect(service.getOwned).toHaveBeenCalledWith('user-1', collectionId);
    expect(result.id).toBe(collectionId);
  });

  it('PATCH /collections/:id forwards the partial dto', async () => {
    await controller.update(mockReq, collectionId, {
      title: 'Renamed',
      visibility: 'public',
    });
    expect(service.update).toHaveBeenCalledWith('user-1', collectionId, {
      title: 'Renamed',
      visibility: 'public',
    });
  });

  it('DELETE /collections/:id resolves to no content', async () => {
    await expect(
      controller.delete(mockReq, collectionId),
    ).resolves.toBeUndefined();
    expect(service.delete).toHaveBeenCalledWith('user-1', collectionId);
  });

  it('POST /collections/:id/items forwards trip_id', async () => {
    const result = await controller.addItem(mockReq, collectionId, {
      trip_id: '00000000-0000-0000-0000-000000000010',
    });
    expect(service.addItem).toHaveBeenCalledWith('user-1', collectionId, {
      trip_id: '00000000-0000-0000-0000-000000000010',
    });
    expect(result.trip_id).toBe('00000000-0000-0000-0000-000000000010');
  });

  it('DELETE /collections/:id/items/:itemId forwards both ids', async () => {
    await expect(
      controller.removeItem(mockReq, collectionId, itemId),
    ).resolves.toBeUndefined();
    expect(service.removeItem).toHaveBeenCalledWith(
      'user-1',
      collectionId,
      itemId,
    );
  });
});
