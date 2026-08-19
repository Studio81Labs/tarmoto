import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { featureGuardTestProviders } from '../features/feature-test-providers.js';
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
});
