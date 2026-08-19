import { AdminMetricsService } from './admin-metrics.service.js';
import type { Repository } from 'typeorm';
import type { User } from '../../entities/user.entity.js';
import type { RoadClosure } from '../../entities/road-closure.entity.js';
import type { Ride } from '../../entities/ride.entity.js';
import type { FeatureState } from '../../entities/feature-state.entity.js';
import type { HazardReport } from '../../entities/hazard-report.entity.js';
import type { RoadReview } from '../../entities/road-review.entity.js';
import type { TripMessage } from '../../entities/trip-message.entity.js';

function repoMock<T extends object>(
  overrides: Partial<Repository<T>> = {},
): Repository<T> {
  return {
    count: jest.fn(),
    ...overrides,
  } as unknown as Repository<T>;
}

describe('AdminMetricsService.snapshot', () => {
  it('queries active ride count and returns it in the snapshot', async () => {
    const users = repoMock<User>({ count: jest.fn().mockResolvedValue(100) });
    const closures = repoMock<RoadClosure>({
      count: jest.fn().mockResolvedValue(5),
    });
    const rides = repoMock<Ride>({ count: jest.fn().mockResolvedValue(7) });
    const flags = repoMock<FeatureState>({
      count: jest.fn().mockResolvedValue(3),
    });
    const hazards = repoMock<HazardReport>({
      count: jest.fn().mockResolvedValue(0),
    });
    const reviews = repoMock<RoadReview>({
      count: jest.fn().mockResolvedValue(0),
    });
    const messages = repoMock<TripMessage>({
      count: jest.fn().mockResolvedValue(0),
    });

    const service = new AdminMetricsService(
      users,
      closures,
      rides,
      flags,
      hazards,
      reviews,
      messages,
    );

    const result = await service.snapshot();

    expect(rides.count).toHaveBeenCalledWith({ where: { status: 'active' } });
    expect(result.activeRides).toBe(7);
    expect(result.users).toBe(100);
    expect(result.closures).toBe(5);
    expect(result.featureFlags).toBe(3);
  });

  it('returns activeRides: 0 when no rides are active', async () => {
    const users = repoMock<User>({ count: jest.fn().mockResolvedValue(10) });
    const closures = repoMock<RoadClosure>({
      count: jest.fn().mockResolvedValue(2),
    });
    const rides = repoMock<Ride>({ count: jest.fn().mockResolvedValue(0) });
    const flags = repoMock<FeatureState>({
      count: jest.fn().mockResolvedValue(0),
    });
    const hazards = repoMock<HazardReport>({
      count: jest.fn().mockResolvedValue(0),
    });
    const reviews = repoMock<RoadReview>({
      count: jest.fn().mockResolvedValue(0),
    });
    const messages = repoMock<TripMessage>({
      count: jest.fn().mockResolvedValue(0),
    });

    const service = new AdminMetricsService(
      users,
      closures,
      rides,
      flags,
      hazards,
      reviews,
      messages,
    );

    const result = await service.snapshot();

    expect(result.activeRides).toBe(0);
  });

  it('snapshot() includes hiddenContent summed across content tables', async () => {
    const users = repoMock<User>({ count: jest.fn().mockResolvedValue(10) });
    const closures = repoMock<RoadClosure>({
      count: jest.fn().mockResolvedValue(0),
    });
    const rides = repoMock<Ride>({ count: jest.fn().mockResolvedValue(0) });
    const flags = repoMock<FeatureState>({
      count: jest.fn().mockResolvedValue(0),
    });
    const hazards = repoMock<HazardReport>({
      count: jest.fn().mockResolvedValue(2),
    });
    const reviews = repoMock<RoadReview>({
      count: jest.fn().mockResolvedValue(1),
    });
    const messages = repoMock<TripMessage>({
      count: jest.fn().mockResolvedValue(3),
    });

    const service = new AdminMetricsService(
      users,
      closures,
      rides,
      flags,
      hazards,
      reviews,
      messages,
    );

    const result = await service.snapshot();

    expect(result.hiddenContent).toBe(6);
  });
});
