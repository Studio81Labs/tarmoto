import { AdminMetricsController } from './admin-metrics.controller.js';
import { AdminMetricsService } from './admin-metrics.service.js';

describe('AdminMetricsController', () => {
  it('returns the metrics snapshot from the service', async () => {
    const snapshot = {
      users: 42,
      activeRides: 3,
      featureFlags: 0,
      closures: 5,
    };
    const service = {
      snapshot: jest.fn().mockResolvedValue(snapshot),
    } as unknown as AdminMetricsService;
    const controller = new AdminMetricsController(service);
    await expect(controller.metrics()).resolves.toEqual(snapshot);

    expect(service.snapshot).toHaveBeenCalledTimes(1);
  });
});
