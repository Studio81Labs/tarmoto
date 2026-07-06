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
});
