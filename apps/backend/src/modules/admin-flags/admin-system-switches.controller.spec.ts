import 'reflect-metadata';
import { ADMIN_ROLES_KEY } from '../admin-auth/admin-role.decorator.js';
import { getAdminAuditTarget } from '../admin/admin-audit-context.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { AdminSystemSwitchesController } from './admin-system-switches.controller.js';
import type { AdminSystemSwitchesService } from './admin-system-switches.service.js';

describe('AdminSystemSwitchesController', () => {
  const service = {
    listSwitches: jest.fn().mockResolvedValue({ switches: [] }),
    disableSwitch: jest.fn().mockResolvedValue({
      key: 'sys_weather_provider',
      enabled: false,
    }),
    enableSwitch: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AdminSystemSwitchesService>;
  const controller = new AdminSystemSwitchesController(service);
  const adminReq = () =>
    ({ adminUser: { id: 'admin-1' } }) as unknown as AdminRequest;

  // Call counts must not leak across tests that share this `service` mock.
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('role metadata', () => {
    it.each(['list'] as const)('requires support on %s', (method) => {
      expect(
        Reflect.getMetadata(
          ADMIN_ROLES_KEY,
          // eslint-disable-next-line @typescript-eslint/unbound-method -- prototype method used as a metadata key, never invoked
          AdminSystemSwitchesController.prototype[method],
        ),
      ).toEqual(['support']);
    });

    it.each(['disable', 'enable'] as const)(
      'requires admin on %s',
      (method) => {
        expect(
          Reflect.getMetadata(
            ADMIN_ROLES_KEY,
            // eslint-disable-next-line @typescript-eslint/unbound-method -- prototype method used as a metadata key, never invoked
            AdminSystemSwitchesController.prototype[method],
          ),
        ).toEqual(['admin']);
      },
    );
  });

  describe('behavior', () => {
    it('GET /admin/system-switches lists the registry', async () => {
      await controller.list();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.listSwitches).toHaveBeenCalled();
    });

    it('PUT /admin/system-switches/:key/disable disables + sets audit target', async () => {
      const req = adminReq();
      await controller.disable(req, 'sys_weather_provider', {
        reason: 'incident 123',
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.disableSwitch).toHaveBeenCalledWith(
        'sys_weather_provider',
        { reason: 'incident 123' },
        'admin-1',
      );
      expect(getAdminAuditTarget(req)).toEqual({
        target_type: 'system_switch',
        target_id: 'sys_weather_provider',
      });
    });

    it('DELETE /admin/system-switches/:key/disable enables + sets audit target', async () => {
      const req = adminReq();
      await controller.enable(req, 'sys_weather_provider');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.enableSwitch).toHaveBeenCalledWith('sys_weather_provider');
      expect(getAdminAuditTarget(req)).toEqual({
        target_type: 'system_switch',
        target_id: 'sys_weather_provider',
      });
    });
  });
});
