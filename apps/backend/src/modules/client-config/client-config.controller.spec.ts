import 'reflect-metadata';
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

  it('GET /config/flags carries Cache-Control: public, max-age=60 header metadata', () => {
    const headers = Reflect.getMetadata(
      '__headers__',
      ClientConfigController.prototype.flags,
    ) as Array<{ name: string; value: string }> | undefined;
    expect(headers).toBeDefined();
    expect(headers).toContainEqual({
      name: 'Cache-Control',
      value: 'public, max-age=60',
    });
  });

  it('GET /config/limits carries Cache-Control: public, max-age=60 header metadata', () => {
    const headers = Reflect.getMetadata(
      '__headers__',
      ClientConfigController.prototype.limits,
    ) as Array<{ name: string; value: string }> | undefined;
    expect(headers).toBeDefined();
    expect(headers).toContainEqual({
      name: 'Cache-Control',
      value: 'public, max-age=60',
    });
  });
});
