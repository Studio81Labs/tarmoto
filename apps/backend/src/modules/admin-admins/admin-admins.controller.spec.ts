import type { Request } from 'express';
import type { AdminRequest } from '../admin/internal.guard.js';
import { getAdminAuditTarget } from '../admin/admin-audit-context.js';
import { AdminAdminsController } from './admin-admins.controller.js';
import { AdminAdminsService } from './admin-admins.service.js';

describe('AdminAdminsController', () => {
  const service = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'a1' }),
    patch: jest.fn().mockResolvedValue({ id: 'a1' }),
  } as unknown as jest.Mocked<AdminAdminsService>;
  const controller = new AdminAdminsController(service);

  function makeReq(): AdminRequest {
    return {
      adminUser: { id: 'super1', role: 'super_admin' },
    } as unknown as AdminRequest;
  }

  it('GET /admin/admins lists', async () => {
    await controller.list();

    expect(service.list).toHaveBeenCalled();
  });

  it('POST /admin/admins passes the acting admin + dto', async () => {
    const req = makeReq();
    const dto = {
      email: 'x@x.io',
      role: 'support' as const,
      mode: 'sso-only' as const,
    };
    await controller.create(req, dto);

    expect(service.create).toHaveBeenCalledWith(
      { id: 'super1', role: 'super_admin' },
      dto,
    );
  });

  it('POST /admin/admins sets audit target to the created admin id', async () => {
    const req = makeReq();
    await controller.create(req, {
      email: 'x@x.io',
      role: 'support' as const,
      mode: 'sso-only' as const,
    });
    expect(getAdminAuditTarget(req as unknown as Request)).toEqual({
      target_type: 'admin_user',
      target_id: 'a1',
    });
  });

  it('PATCH /admin/admins/:id passes actor, id, dto', async () => {
    const req = makeReq();
    await controller.patch(req, 'a1', { active: false });

    expect(service.patch).toHaveBeenCalledWith(
      { id: 'super1', role: 'super_admin' },
      'a1',
      { active: false },
    );
  });

  it('PATCH /admin/admins/:id sets audit target to the patched admin id', async () => {
    const req = makeReq();
    await controller.patch(req, 'a1', { active: false });
    expect(getAdminAuditTarget(req as unknown as Request)).toEqual({
      target_type: 'admin_user',
      target_id: 'a1',
    });
  });
});
