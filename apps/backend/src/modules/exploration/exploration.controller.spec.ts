/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
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
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExplorationController],
      providers: [
        { provide: ExplorationService, useValue: mockService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
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
});
