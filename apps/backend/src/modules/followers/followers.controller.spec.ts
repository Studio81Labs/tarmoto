import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { FollowersController } from './followers.controller.js';
import { FollowersService } from './followers.service.js';

describe('FollowersController', () => {
  let controller: FollowersController;
  let service: jest.Mocked<FollowersService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockFollowResponse = {
    following_id: 'user-2',
    display_name: 'Jane Rider',
    followed_at: '2026-04-14T10:00:00.000Z',
  };

  const mockFollower = {
    user_id: 'user-3',
    display_name: 'Bob Rider',
    followed_at: '2026-04-14T10:00:00.000Z',
  };

  const mockFeedRide = {
    ride_id: 'ride-1',
    share_token: 'token123',
    rider_id: 'user-2',
    rider_name: 'Jane Rider',
    ride_type: 'free',
    started_at: '2026-04-14T09:00:00.000Z',
    distance_km: 42.5,
    avg_speed: 65.3,
    avg_road_quality: 4.2,
    duration_min: 90,
  };

  beforeEach(async () => {
    const mockService = {
      follow: jest.fn().mockResolvedValue(mockFollowResponse),
      unfollow: jest.fn().mockResolvedValue(undefined),
      listFollowers: jest.fn().mockResolvedValue([mockFollower]),
      listFollowing: jest.fn().mockResolvedValue([mockFollowResponse]),
      getFeed: jest.fn().mockResolvedValue([mockFeedRide]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FollowersController],
      providers: [
        { provide: FollowersService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<FollowersController>(FollowersController);
    service = module.get(FollowersService);
  });

  it('POST /users/:userId/follow should follow a user', async () => {
    const result = await controller.follow(mockReq, 'user-2');

    expect(service.follow).toHaveBeenCalledWith('user-1', 'user-2');
    expect(result.display_name).toBe('Jane Rider');
  });

  it('DELETE /users/:userId/follow should unfollow', async () => {
    await controller.unfollow(mockReq, 'user-2');

    expect(service.unfollow).toHaveBeenCalledWith('user-1', 'user-2');
  });

  it('GET /users/:userId/followers should list followers', async () => {
    const result = await controller.listFollowers('user-2');

    expect(service.listFollowers).toHaveBeenCalledWith('user-2');
    expect(result).toHaveLength(1);
  });

  it('GET /users/:userId/following should list following', async () => {
    const result = await controller.listFollowing('user-1');

    expect(service.listFollowing).toHaveBeenCalledWith('user-1');
    expect(result).toHaveLength(1);
  });

  it('GET /feed/rides should return feed with defaults', async () => {
    const result = await controller.getFeed(mockReq, {});

    expect(service.getFeed).toHaveBeenCalledWith(
      'user-1',
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(result).toHaveLength(1);
  });

  it('GET /feed/rides should pass location filter', async () => {
    await controller.getFeed(mockReq, {
      lat: 49.2,
      lng: 16.6,
      radius_km: 30,
      limit: 10,
    });

    expect(service.getFeed).toHaveBeenCalledWith('user-1', 49.2, 16.6, 30, 10);
  });
});
