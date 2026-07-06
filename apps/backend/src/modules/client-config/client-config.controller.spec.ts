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
});
