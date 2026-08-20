import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { featureGuardTestProviders } from '../features/feature-test-providers.js';
import { FeatureKillSwitchGuard } from '../features/feature-kill-switch.guard.js';
import { REQUIRED_FEATURE_KILL_SWITCH_KEY } from '../features/require-feature-kill-switch.decorator.js';
import { RouteCollectionsController } from './route-collections.controller.js';
import { RouteCollectionsService } from './route-collections.service.js';

describe('RouteCollectionsController', () => {
  let controller: RouteCollectionsController;
  let service: jest.Mocked<RouteCollectionsService>;

  const mockReq = { user: { userId: 'user-1' } } as never;
  const anonReq = {} as never;
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
    viewer_is_owner: true,
    viewer_is_following: false,
    created_at: '2026-04-20T10:00:00.000Z',
    updated_at: '2026-04-20T10:00:00.000Z',
  };

  beforeEach(async () => {
    const mockService = {
      listMine: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listLibrary: jest.fn().mockResolvedValue({ owned: [], followed: [] }),
      create: jest.fn().mockResolvedValue(detail),
      getOwned: jest.fn().mockResolvedValue(detail),
      getBySlug: jest.fn().mockResolvedValue(detail),
      getPreviewBySlug: jest.fn().mockResolvedValue({ routes: [] }),
      update: jest.fn().mockResolvedValue(detail),
      delete: jest.fn().mockResolvedValue(undefined),
      addItem: jest.fn().mockResolvedValue({
        id: itemId,
        ride_id: '00000000-0000-0000-0000-000000000020',
        position: 0,
        created_at: '2026-04-20T10:00:00.000Z',
      }),
      removeItem: jest.fn().mockResolvedValue(undefined),
      reorderItems: jest.fn().mockResolvedValue(detail),
      follow: jest.fn().mockResolvedValue({
        collection_id: collectionId,
        followed_at: '2026-04-20T11:00:00.000Z',
      }),
      unfollow: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RouteCollectionsController],
      providers: [
        { provide: RouteCollectionsService, useValue: mockService },
        ...authGuardTestProviders,
        ...featureGuardTestProviders,
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

  it('GET /collections/me/library delegates to listLibrary', async () => {
    const result = await controller.listLibrary(mockReq);
    expect(service.listLibrary).toHaveBeenCalledWith('user-1');
    expect(result.owned).toEqual([]);
    expect(result.followed).toEqual([]);
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

  it('GET /collections/by-slug/:slug forwards the slug + viewer userId', async () => {
    const result = await controller.getBySlug(mockReq, 'abcDEF12345');
    expect(service.getBySlug).toHaveBeenCalledWith('abcDEF12345', 'user-1');
    expect(result.slug).toBe('abcDEF12345');
  });

  it('GET /collections/by-slug/:slug passes null viewer when no token is present', async () => {
    // OptionalAuthGuard leaves req.user undefined when the caller is anonymous.
    // The controller must coerce that to `null` so the service path that gates
    // viewer_is_following stays branch-free (it does `viewerId != null`).
    await controller.getBySlug(anonReq, 'abcDEF12345');
    expect(service.getBySlug).toHaveBeenCalledWith('abcDEF12345', null);
  });

  it('GET /collections/by-slug/:slug/preview delegates to getPreviewBySlug', async () => {
    const result = await controller.getPreviewBySlug('abcDEF12345');
    expect(service.getPreviewBySlug).toHaveBeenCalledWith('abcDEF12345');
    expect(result.routes).toEqual([]);
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

  it('POST /collections/:id/items forwards ride_id', async () => {
    const result = await controller.addItem(mockReq, collectionId, {
      ride_id: '00000000-0000-0000-0000-000000000020',
    });
    expect(service.addItem).toHaveBeenCalledWith('user-1', collectionId, {
      ride_id: '00000000-0000-0000-0000-000000000020',
    });
    expect(result.ride_id).toBe('00000000-0000-0000-0000-000000000020');
  });

  it('PATCH /collections/:id/items/reorder forwards the ordered item_ids', async () => {
    const itemIds = [
      '00000000-0000-0000-0000-0000000000a1',
      '00000000-0000-0000-0000-0000000000a2',
    ];
    const result = await controller.reorderItems(mockReq, collectionId, {
      item_ids: itemIds,
    });
    expect(service.reorderItems).toHaveBeenCalledWith('user-1', collectionId, {
      item_ids: itemIds,
    });
    expect(result.id).toBe(collectionId);
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

  it('POST /collections/:id/follow delegates to follow', async () => {
    const result = await controller.follow(mockReq, collectionId);
    expect(service.follow).toHaveBeenCalledWith('user-1', collectionId);
    expect(result.collection_id).toBe(collectionId);
  });

  it('DELETE /collections/:id/follow delegates to unfollow', async () => {
    await expect(
      controller.unfollow(mockReq, collectionId),
    ).resolves.toBeUndefined();
    expect(service.unfollow).toHaveBeenCalledWith('user-1', collectionId);
  });

  describe('community_access kill switch on the public by-slug routes (#1207)', () => {
    const detailHandler = RouteCollectionsController.prototype.getBySlug;
    const previewHandler =
      RouteCollectionsController.prototype.getPreviewBySlug;

    // Run the REAL guard against the REAL handler metadata so these tests
    // exercise the declared key, not a copy of it.
    const runGuard = (handler: object, globalStates: Record<string, string>) =>
      new FeatureKillSwitchGuard(new Reflector(), {
        getGlobalStates: jest.fn().mockResolvedValue(globalStates),
      } as never).canActivate({
        getHandler: () => handler,
        getClass: () => RouteCollectionsController,
      } as unknown as ExecutionContext);

    it('GET by-slug/:slug wires the kill-switch guard BEFORE OptionalAuthGuard and declares community_access', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        detailHandler,
      ) as unknown[];
      // Kill switch first: a killed feature skips the optional bearer-token
      // verification (OptionalAuthGuard never rejects, so order changes no
      // outcome, only the work done).
      expect(guards[0]).toBe(FeatureKillSwitchGuard);
      expect(guards).toContain(OptionalAuthGuard);
      expect(
        Reflect.getMetadata(REQUIRED_FEATURE_KILL_SWITCH_KEY, detailHandler),
      ).toBe('community_access');
    });

    it('GET by-slug/:slug/preview wires FeatureKillSwitchGuard and declares community_access', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        previewHandler,
      ) as unknown[];
      expect(guards).toContain(FeatureKillSwitchGuard);
      expect(
        Reflect.getMetadata(REQUIRED_FEATURE_KILL_SWITCH_KEY, previewHandler),
      ).toBe('community_access');
    });

    it.each([
      ['by-slug/:slug', detailHandler],
      ['by-slug/:slug/preview', previewHandler],
    ])(
      'GET %s passes when community_access is live',
      async (_route, handler) => {
        await expect(runGuard(handler, {})).resolves.toBe(true);
      },
    );

    it.each([
      ['by-slug/:slug', detailHandler],
      ['by-slug/:slug/preview', previewHandler],
    ])(
      'GET %s 403s scope global when community_access is force_off',
      async (_route, handler) => {
        // ONLY community_access is killed — a route gated on any other flag
        // would resolve live here and fail this test.
        const err = await runGuard(handler, {
          community_access: 'force_off',
        }).then(
          () => {
            throw new Error('expected the guard to reject');
          },
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          statusCode: 403,
          feature: 'community_access',
          scope: 'global',
        });
      },
    );
  });
});
