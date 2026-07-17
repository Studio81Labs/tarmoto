import { ClientConfigService } from './client-config.service.js';

describe('ClientConfigService', () => {
  it('featureStates() passes through the resolver global-states map', async () => {
    const resolver = {
      getGlobalStates: jest.fn().mockResolvedValue({
        group_rides: 'force_on',
        gpx_export: 'force_off',
      }),
    };
    const svc = new ClientConfigService(resolver as never);
    await expect(svc.featureStates()).resolves.toEqual({
      group_rides: 'force_on',
      gpx_export: 'force_off',
    });
  });

  it('limitOverrides() passes through the resolver global-limit-overrides map', async () => {
    const resolver = {
      getGlobalLimitOverrides: jest.fn().mockResolvedValue({
        max_active_trips: 5,
        max_waypoints: null,
      }),
    };
    const svc = new ClientConfigService(resolver as never);
    await expect(svc.limitOverrides()).resolves.toEqual({
      max_active_trips: 5,
      max_waypoints: null,
    });
  });
});
