import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { LeaderboardsController } from './leaderboards.controller.js';
import { LeaderboardsService } from './leaderboards.service.js';

describe('LeaderboardsController', () => {
  let controller: LeaderboardsController;
  let service: jest.Mocked<LeaderboardsService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockResponse = {
    region: 'Beskydy',
    generated_at: '2026-05-01T00:00:00.000Z',
    total_distance_km: {
      dimension: 'total_distance_km' as const,
      unit: 'km',
      entries: [],
      me: null,
    },
    roads_discovered: {
      dimension: 'roads_discovered' as const,
      unit: 'roads',
      entries: [],
      me: null,
    },
    hazards_reported: {
      dimension: 'hazards_reported' as const,
      unit: 'reports',
      entries: [],
      me: null,
    },
  };

  beforeEach(async () => {
    const mockService = {
      getRegional: jest.fn().mockResolvedValue(mockResponse),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LeaderboardsController],
      providers: [
        { provide: LeaderboardsService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<LeaderboardsController>(LeaderboardsController);
    service = module.get(LeaderboardsService);
  });

  it('GET /leaderboards/regional forwards query params + currentUserId', async () => {
    const result = await controller.getRegional(mockReq, {
      region: 'Beskydy',
      limit: 10,
    });

    expect(service.getRegional).toHaveBeenCalledWith({
      region: 'Beskydy',
      limit: 10,
      currentUserId: 'user-1',
    });
    expect(result.region).toBe('Beskydy');
  });

  it('forwards undefined region/limit unchanged', async () => {
    await controller.getRegional(mockReq, {});

    expect(service.getRegional).toHaveBeenCalledWith({
      region: undefined,
      limit: undefined,
      currentUserId: 'user-1',
    });
  });
});
