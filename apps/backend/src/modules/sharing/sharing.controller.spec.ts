import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { SharingController } from './sharing.controller.js';
import { SharingService } from './sharing.service.js';

describe('SharingController', () => {
  let controller: SharingController;
  let service: jest.Mocked<SharingService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockShareResponse = {
    share_token: 'abc123def456abc123def456abc12345',
    is_public: true,
    share_url: '/rides/shared/abc123def456abc123def456abc12345',
  };

  const mockDetail = {
    id: 'ride-1',
    rider_name: 'John Rider',
    ride_type: 'free',
    started_at: '2026-04-14T09:00:00.000Z',
    ended_at: '2026-04-14T10:30:00.000Z',
    distance_km: 42.5,
    avg_speed: 65.3,
    max_speed: 120.0,
    avg_road_quality: 4.2,
    duration_min: 90,
    view_count: 7,
    route_geometry: [{ lat: 49.2, lng: 16.6 }],
  };

  const mockCommunityRide = {
    id: 'ride-1',
    share_token: 'abc123def456abc123def456abc12345',
    rider_id: 'user-1',
    rider_name: 'John Rider',
    rider_avatar_url: null,
    ride_type: 'free',
    started_at: '2026-04-14T09:00:00.000Z',
    distance_km: 42.5,
    avg_speed: 65.3,
    avg_road_quality: 4.2,
    avg_curviness: 3.1,
    duration_min: 90,
    view_count: 7,
    route_geometry: [{ lat: 49.2, lng: 16.6 }],
  };

  const mockCommunityResponse = {
    items: [mockCommunityRide],
    total: 1,
    limit: 20,
    offset: 0,
  };

  beforeEach(async () => {
    const mockService = {
      toggleShare: jest.fn().mockResolvedValue(mockShareResponse),
      unshare: jest.fn().mockResolvedValue(undefined),
      getByToken: jest.fn().mockResolvedValue(mockDetail),
      listCommunityRides: jest.fn().mockResolvedValue(mockCommunityResponse),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SharingController],
      providers: [
        { provide: SharingService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<SharingController>(SharingController);
    service = module.get(SharingService);
  });

  it('POST /rides/:rideId/share should toggle sharing', async () => {
    const result = await controller.toggleShare(mockReq, 'ride-1', {
      is_public: true,
    });

    expect(service.toggleShare).toHaveBeenCalledWith('user-1', 'ride-1', true);
    expect(result.share_token).toBe('abc123def456abc123def456abc12345');
  });

  it('DELETE /rides/:rideId/share should unshare', async () => {
    await controller.unshare(mockReq, 'ride-1');

    expect(service.unshare).toHaveBeenCalledWith('user-1', 'ride-1');
  });

  it('GET /rides/shared/:token should return shared ride', async () => {
    const result = await controller.getSharedRide('abc123');

    expect(service.getByToken).toHaveBeenCalledWith('abc123');
    expect(result.rider_name).toBe('John Rider');
  });

  it('GET /rides/community should forward the full query + viewer through to the service', async () => {
    const result = await controller.listCommunityRides(mockReq, {
      lat: 49.2,
      lng: 16.6,
      radius_km: 25,
      limit: 20,
    });

    expect(service.listCommunityRides).toHaveBeenCalledWith(
      {
        lat: 49.2,
        lng: 16.6,
        radius_km: 25,
        limit: 20,
      },
      'user-1',
    );
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('GET /rides/community should accept an empty query (global feed)', async () => {
    const result = await controller.listCommunityRides(mockReq, {});

    expect(service.listCommunityRides).toHaveBeenCalledWith({}, 'user-1');
    expect(result.items).toHaveLength(1);
  });

  it('GET /rides/community works anonymously (no viewer id)', async () => {
    await controller.listCommunityRides({ user: undefined } as never, {});
    expect(service.listCommunityRides).toHaveBeenCalledWith({}, undefined);
  });

  it('GET /rides/community should forward filter / sort / pagination params', async () => {
    await controller.listCommunityRides(mockReq, {
      min_distance_km: 50,
      max_distance_km: 300,
      min_quality: 3.5,
      min_popularity: 250,
      ride_type: 'trip',
      sort: 'highest_quality',
      offset: 40,
      limit: 10,
    });

    expect(service.listCommunityRides).toHaveBeenCalledWith(
      {
        min_distance_km: 50,
        max_distance_km: 300,
        min_quality: 3.5,
        min_popularity: 250,
        ride_type: 'trip',
        sort: 'highest_quality',
        offset: 40,
        limit: 10,
      },
      'user-1',
    );
  });

  it('GET /rides/community should forward curviness filter + curviest sort', async () => {
    await controller.listCommunityRides(mockReq, {
      min_curviness: 2.5,
      max_curviness: 4,
      sort: 'curviest',
    });

    expect(service.listCommunityRides).toHaveBeenCalledWith(
      {
        min_curviness: 2.5,
        max_curviness: 4,
        sort: 'curviest',
      },
      'user-1',
    );
  });
});
