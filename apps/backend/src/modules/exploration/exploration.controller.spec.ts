import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { ExplorationController } from './exploration.controller.js';
import { ExplorationService } from './exploration.service.js';

describe('ExplorationController', () => {
  let controller: ExplorationController;
  let service: jest.Mocked<ExplorationService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  beforeEach(async () => {
    const mockService = {
      getStats: jest.fn().mockResolvedValue({
        ridden_segments: 15,
        total_segments: 100,
        percent_explored: 15,
        total_distance_km: 350.5,
      }),
      getNearbyUnridden: jest.fn().mockResolvedValue([
        {
          id: 'seg-10',
          road_name: 'Mountain Pass',
          length_m: 2500,
          quality_score: 4.2,
          surface_type: 'asphalt',
          distance_m: 1235,
        },
      ]),
      getRiddenIds: jest.fn().mockResolvedValue({
        segment_ids: ['seg-1', 'seg-2'],
      }),
      getRiddenSegments: jest.fn().mockResolvedValue({
        segments: [
          {
            id: 'seg-1',
            last_ridden_at: '2026-04-01T08:30:00.000Z',
            last_quality_score: 4.2,
            ride_count: 3,
          },
        ],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExplorationController],
      providers: [
        { provide: ExplorationService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<ExplorationController>(ExplorationController);
    service = module.get(ExplorationService);
  });

  it('GET /exploration/stats should return stats', async () => {
    const result = await controller.getStats(mockReq);

    expect(service.getStats).toHaveBeenCalledWith('user-1');
    expect(result.percent_explored).toBe(15);
  });

  it('GET /exploration/nearby-unridden should return segments', async () => {
    const result = await controller.getNearbyUnridden(mockReq, {
      lat: 49.2,
      lng: 16.6,
      radius_km: 10,
      limit: 20,
    });

    expect(service.getNearbyUnridden).toHaveBeenCalledWith(
      'user-1',
      49.2,
      16.6,
      10,
      20,
    );
    expect(result).toHaveLength(1);
  });

  it('GET /exploration/nearby-unridden should use defaults', async () => {
    await controller.getNearbyUnridden(mockReq, {
      lat: 49.2,
      lng: 16.6,
    });

    expect(service.getNearbyUnridden).toHaveBeenCalledWith(
      'user-1',
      49.2,
      16.6,
      10,
      20,
    );
  });

  it('GET /exploration/ridden-ids should return segment IDs', async () => {
    const result = await controller.getRiddenIds(mockReq);

    expect(service.getRiddenIds).toHaveBeenCalledWith('user-1');
    expect(result.segment_ids).toHaveLength(2);
  });

  it('GET /exploration/ridden-segments should return segments with ride metadata', async () => {
    const result = await controller.getRiddenSegments(mockReq);

    expect(service.getRiddenSegments).toHaveBeenCalledWith('user-1');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({
      id: 'seg-1',
      last_ridden_at: '2026-04-01T08:30:00.000Z',
      last_quality_score: 4.2,
      ride_count: 3,
    });
  });
});
