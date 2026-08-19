import 'reflect-metadata';
import { ADMIN_ROLES_KEY } from '../admin-auth/admin-role.decorator.js';
import { getAdminAuditTarget } from '../admin/admin-audit-context.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { AdminLimitsController } from './admin-limits.controller.js';
import type { AdminLimitsService } from './admin-limits.service.js';

describe('AdminLimitsController', () => {
  const service = {
    listLimits: jest.fn().mockResolvedValue({ limits: [] }),
    setGlobalValue: jest
      .fn()
      .mockResolvedValue({ feature: 'max_active_trips' }),
    clearGlobalValue: jest.fn().mockResolvedValue(undefined),
    getUserLimits: jest.fn().mockResolvedValue({ user_id: 'u1', limits: [] }),
    setOverride: jest.fn().mockResolvedValue({ user_id: 'u1', limits: [] }),
    removeOverride: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AdminLimitsService>;
  const controller = new AdminLimitsController(service);
  const adminReq = () =>
    ({ adminUser: { id: 'admin-1' } }) as unknown as AdminRequest;

  // Call counts must not leak across tests that share this `service` mock.
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('role metadata', () => {
    it.each(['list', 'getUserLimits'] as const)(
      'requires support on %s',
      (method) => {
        expect(
          Reflect.getMetadata(
            ADMIN_ROLES_KEY,
            // eslint-disable-next-line @typescript-eslint/unbound-method -- prototype method used as a metadata key, never invoked
            AdminLimitsController.prototype[method],
          ),
        ).toEqual(['support']);
      },
    );

    it.each([
      'setGlobal',
      'clearGlobal',
      'setOverride',
      'removeOverride',
    ] as const)('requires admin on %s', (method) => {
      expect(
        Reflect.getMetadata(
          ADMIN_ROLES_KEY,
          // eslint-disable-next-line @typescript-eslint/unbound-method -- prototype method used as a metadata key, never invoked
          AdminLimitsController.prototype[method],
        ),
      ).toEqual(['admin']);
    });
  });

  describe('behavior', () => {
    it('GET /admin/feature-limits lists the registry', async () => {
      await controller.list();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.listLimits).toHaveBeenCalled();
    });

    it('PUT /admin/feature-limits/:feature/global sets value + audit target', async () => {
      const req = adminReq();
      await controller.setGlobal(req, 'max_active_trips', {
        value: 3,
        reason: 'promo',
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.setGlobalValue).toHaveBeenCalledWith(
        'max_active_trips',
        { value: 3, reason: 'promo' },
        'admin-1',
      );
      expect(getAdminAuditTarget(req)).toEqual({
        target_type: 'feature_limit',
        target_id: 'max_active_trips',
      });
    });

    it('DELETE /admin/feature-limits/:feature/global clears + audit target', async () => {
      const req = adminReq();
      await controller.clearGlobal(req, 'max_active_trips');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.clearGlobalValue).toHaveBeenCalledWith('max_active_trips');
      expect(getAdminAuditTarget(req)).toEqual({
        target_type: 'feature_limit',
        target_id: 'max_active_trips',
      });
    });

    it('GET /admin/users/:id/feature-limits resolves user limits', async () => {
      await controller.getUserLimits('u1');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.getUserLimits).toHaveBeenCalledWith('u1');
    });

    it('PUT /admin/users/:id/feature-limits/:feature sets override + audit target', async () => {
      const req = adminReq();
      await controller.setOverride(req, 'u1', 'max_active_trips', {
        value: 5,
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.setOverride).toHaveBeenCalledWith(
        'u1',
        'max_active_trips',
        { value: 5 },
      );
      expect(getAdminAuditTarget(req)).toEqual({
        target_type: 'user',
        target_id: 'u1',
      });
    });

    it('DELETE /admin/users/:id/feature-limits/:feature removes override', async () => {
      const req = adminReq();
      await controller.removeOverride(req, 'u1', 'max_active_trips');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.removeOverride).toHaveBeenCalledWith(
        'u1',
        'max_active_trips',
      );
      expect(getAdminAuditTarget(req)).toEqual({
        target_type: 'user',
        target_id: 'u1',
      });
    });
  });
});
