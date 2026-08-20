import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { featureGuardTestProviders } from '../features/feature-test-providers.js';
import { FeatureKillSwitchGuard } from '../features/feature-kill-switch.guard.js';
import { REQUIRED_FEATURE_KILL_SWITCH_KEY } from '../features/require-feature-kill-switch.decorator.js';
import { TripSharesController } from './trip-shares.controller.js';
import { TripSharesService } from './trip-shares.service.js';

describe('TripSharesController', () => {
  let controller: TripSharesController;
  let service: jest.Mocked<TripSharesService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockCreated = {
    id: 'share-1',
    share_token: 'a'.repeat(32),
    share_url: `/trips/shared/${'a'.repeat(32)}`,
    trip_id: 'trip-1',
    title: 'Pyrenees Loop',
    view_count: 0,
    created_at: '2026-04-20T10:00:00.000Z',
    updated_at: '2026-04-20T10:00:00.000Z',
  };

  const mockPublic = {
    share_token: 'a'.repeat(32),
    trip_id: 'trip-1',
    join_url: `/trips/shared/${'a'.repeat(32)}`,
    title: 'Pyrenees Loop',
    owner_name: 'Jane Rider',
    snapshot: { days: [] },
    view_count: 4,
    created_at: '2026-04-20T10:00:00.000Z',
    updated_at: '2026-04-20T10:00:00.000Z',
  };

  const mockListed = {
    items: [
      {
        id: 'share-1',
        share_token: 'a'.repeat(32),
        share_url: `/trips/shared/${'a'.repeat(32)}`,
        trip_id: 'trip-1',
        title: 'Pyrenees Loop',
        view_count: 4,
        created_at: '2026-04-20T10:00:00.000Z',
        updated_at: '2026-04-20T10:00:00.000Z',
      },
    ],
    total: 1,
  };

  beforeEach(async () => {
    const mockService = {
      create: jest.fn().mockResolvedValue(mockCreated),
      getByToken: jest.fn().mockResolvedValue(mockPublic),
      joinByToken: jest.fn().mockResolvedValue({
        trip_id: 'trip-1',
        planner_url: '/trips/planner?tripId=trip-1',
      }),
      listMine: jest.fn().mockResolvedValue(mockListed),
      revoke: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TripSharesController],
      providers: [
        { provide: TripSharesService, useValue: mockService },
        ...authGuardTestProviders,
        ...featureGuardTestProviders,
      ],
    }).compile();

    controller = module.get<TripSharesController>(TripSharesController);
    service = module.get(TripSharesService);
  });

  it('POST /trip-shares creates a share for the authenticated caller', async () => {
    const result = await controller.create(mockReq, {
      title: 'Pyrenees Loop',
      snapshot: { days: [] },
      trip_id: 'trip-1',
    });

    expect(service.create).toHaveBeenCalledWith('user-1', {
      title: 'Pyrenees Loop',
      snapshot: { days: [] },
      trip_id: 'trip-1',
    });
    expect(result.share_token).toBe('a'.repeat(32));
  });

  it("GET /trip-shares/mine lists only the caller's shares", async () => {
    const result = await controller.listMine(mockReq);

    expect(service.listMine).toHaveBeenCalledWith('user-1');
    expect(result.total).toBe(1);
  });

  it('GET /trip-shares/:token returns the public trip snapshot', async () => {
    const result = await controller.getByToken('a'.repeat(32));

    expect(service.getByToken).toHaveBeenCalledWith('a'.repeat(32));
    expect(result.owner_name).toBe('Jane Rider');
    expect(result.snapshot).toEqual({ days: [] });
  });

  it('POST /trip-shares/:token/join accepts the shared trip for the authenticated caller', async () => {
    const result = await controller.joinByToken(mockReq, 'a'.repeat(32));

    expect(service.joinByToken).toHaveBeenCalledWith('user-1', 'a'.repeat(32));
    expect(result).toEqual({
      trip_id: 'trip-1',
      planner_url: '/trips/planner?tripId=trip-1',
    });
  });

  it('DELETE /trip-shares/:id revokes the share for the owner', async () => {
    await controller.revoke(mockReq, '00000000-0000-0000-0000-000000000001');

    expect(service.revoke).toHaveBeenCalledWith(
      'user-1',
      '00000000-0000-0000-0000-000000000001',
    );
  });

  // `collaborative_trips` is enforced in `TripSharesService.create` (only for a
  // persisted `trip_id`), NOT by a controller guard — see the service spec's
  // create gate tests. A snapshot-only share stays open to all tiers.

  describe('community_access kill switch on GET /trip-shares/:token (#1207)', () => {
    const handler = TripSharesController.prototype.getByToken;

    // Run the REAL guard against the REAL handler metadata so these tests
    // exercise the declared key, not a copy of it.
    const runGuard = (globalStates: Record<string, string>) =>
      new FeatureKillSwitchGuard(new Reflector(), {
        getGlobalStates: jest.fn().mockResolvedValue(globalStates),
      } as never).canActivate({
        getHandler: () => handler,
        getClass: () => TripSharesController,
      } as unknown as ExecutionContext);

    it('wires FeatureKillSwitchGuard and declares community_access', () => {
      const guards = Reflect.getMetadata('__guards__', handler) as unknown[];
      expect(guards).toContain(FeatureKillSwitchGuard);
      expect(
        Reflect.getMetadata(REQUIRED_FEATURE_KILL_SWITCH_KEY, handler),
      ).toBe('community_access');
    });

    it('leaves the authenticated join flow ungated (invite acceptance is collaboration)', () => {
      expect(
        Reflect.getMetadata(
          REQUIRED_FEATURE_KILL_SWITCH_KEY,
          TripSharesController.prototype.joinByToken,
        ),
      ).toBeUndefined();
    });

    it('passes when community_access is live', async () => {
      await expect(runGuard({})).resolves.toBe(true);
    });

    it('403s scope global when community_access is force_off', async () => {
      // ONLY community_access is killed — a route gated on any other flag
      // would resolve live here and fail this test.
      const err = await runGuard({ community_access: 'force_off' }).then(
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
    });
  });
});
