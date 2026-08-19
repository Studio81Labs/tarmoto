import { getAdminAuditTarget } from '../admin/admin-audit-context.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { AdminFlagsController } from './admin-flags.controller.js';
import { AdminFlagsService } from './admin-flags.service.js';

describe('AdminFlagsController', () => {
  const service = {
    listFlags: jest.fn().mockResolvedValue({ flags: [] }),
    setGlobalState: jest.fn().mockResolvedValue({ feature: 'gpx_export' }),
    clearGlobalState: jest.fn().mockResolvedValue(undefined),
    listOverriddenUsers: jest
      .fn()
      .mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 }),
    getUserFlags: jest.fn().mockResolvedValue({ user_id: 'u1', flags: [] }),
    setOverride: jest.fn().mockResolvedValue({ user_id: 'u1', flags: [] }),
    removeOverride: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AdminFlagsService>;
  const controller = new AdminFlagsController(service);
  const adminReq = () =>
    ({ adminUser: { id: 'admin-1' } }) as unknown as AdminRequest;

  it('GET /admin/feature-flags lists the registry', async () => {
    await controller.list();

    expect(service.listFlags).toHaveBeenCalled();
  });

  it('PUT /admin/feature-flags/:feature/global sets state + audit target', async () => {
    const req = adminReq();
    await controller.setGlobal(req, 'gpx_export', {
      state: 'force_off',
      reason: 'x',
    });

    expect(service.setGlobalState).toHaveBeenCalledWith(
      'gpx_export',
      { state: 'force_off', reason: 'x' },
      'admin-1',
    );
    expect(getAdminAuditTarget(req)).toEqual({
      target_type: 'feature_flag',
      target_id: 'gpx_export',
    });
  });

  it('DELETE /admin/feature-flags/:feature/global clears + audit target', async () => {
    const req = adminReq();
    await controller.clearGlobal(req, 'gpx_export');

    expect(service.clearGlobalState).toHaveBeenCalledWith('gpx_export');
    expect(getAdminAuditTarget(req)).toEqual({
      target_type: 'feature_flag',
      target_id: 'gpx_export',
    });
  });

  it('GET /admin/feature-flags/:feature/users lists overrides', async () => {
    await controller.listOverriddenUsers('gpx_export', { page: 2 });

    expect(service.listOverriddenUsers).toHaveBeenCalledWith('gpx_export', {
      page: 2,
    });
  });

  it('GET /admin/users/:id/feature-flags resolves user flags', async () => {
    await controller.getUserFlags('u1');

    expect(service.getUserFlags).toHaveBeenCalledWith('u1');
  });

  it('PUT /admin/users/:id/feature-flags/:feature sets override + audit target', async () => {
    const req = adminReq();
    await controller.setOverride(req, 'u1', 'gpx_export', { enabled: true });

    expect(service.setOverride).toHaveBeenCalledWith('u1', 'gpx_export', {
      enabled: true,
    });
    expect(getAdminAuditTarget(req)).toEqual({
      target_type: 'user',
      target_id: 'u1',
    });
  });

  it('DELETE /admin/users/:id/feature-flags/:feature removes override', async () => {
    const req = adminReq();
    await controller.removeOverride(req, 'u1', 'gpx_export');

    expect(service.removeOverride).toHaveBeenCalledWith('u1', 'gpx_export');
    expect(getAdminAuditTarget(req)).toEqual({
      target_type: 'user',
      target_id: 'u1',
    });
  });
});
