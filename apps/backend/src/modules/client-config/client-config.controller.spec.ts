import { ClientConfigController } from './client-config.controller.js';
import { ClientConfigService } from './client-config.service.js';

describe('ClientConfigController', () => {
  it('GET /config/flags returns the global-states map', async () => {
    const service = {
      featureStates: jest.fn().mockResolvedValue({ group_rides: 'force_on' }),
    } as unknown as jest.Mocked<ClientConfigService>;
    const controller = new ClientConfigController(service);
    await expect(controller.flags()).resolves.toEqual({
      group_rides: 'force_on',
    });
  });

  it('GET /config/limits returns the global-limits map', async () => {
    const service = {
      limitOverrides: jest
        .fn()
        .mockResolvedValue({ max_active_trips: 5, max_waypoints: null }),
    } as unknown as jest.Mocked<ClientConfigService>;
    const controller = new ClientConfigController(service);
    await expect(controller.limits()).resolves.toEqual({
      max_active_trips: 5,
      max_waypoints: null,
    });
  });
});
