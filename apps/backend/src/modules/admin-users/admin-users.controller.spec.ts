import type { Request } from 'express';
import type { AdminRequest } from '../admin/internal.guard.js';
import { getAdminAuditTarget } from '../admin/admin-audit-context.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';

describe('AdminUsersController', () => {
  const service = {
    list: jest
      .fn()
      .mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 }),
    getById: jest.fn().mockResolvedValue({ id: 'u1' }),
    softDelete: jest.fn().mockResolvedValue(undefined),
    restore: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AdminUsersService>;
  const controller = new AdminUsersController(service);

  function makeReq(): AdminRequest {
    return {} as AdminRequest;
  }

  it('GET /admin/users forwards the query', async () => {
    await controller.list({ q: 'x' });

    expect(service.list).toHaveBeenCalledWith({ q: 'x' });
  });

  it('GET /admin/users/:id forwards the id', async () => {
    await controller.getById('u1');

    expect(service.getById).toHaveBeenCalledWith('u1');
  });

  it('DELETE /admin/users/:id soft-deletes', async () => {
    const req = makeReq();
    await controller.softDelete(req, 'u1');

    expect(service.softDelete).toHaveBeenCalledWith('u1');
  });

  it('DELETE /admin/users/:id sets audit target', async () => {
    const req = makeReq();
    await controller.softDelete(req, 'u1');
    expect(getAdminAuditTarget(req as unknown as Request)).toEqual({
      target_type: 'user',
      target_id: 'u1',
    });
  });

  it('POST /admin/users/:id/restore restores', async () => {
    const req = makeReq();
    await controller.restore(req, 'u1');

    expect(service.restore).toHaveBeenCalledWith('u1');
  });

  it('POST /admin/users/:id/restore sets audit target', async () => {
    const req = makeReq();
    await controller.restore(req, 'u1');
    expect(getAdminAuditTarget(req as unknown as Request)).toEqual({
      target_type: 'user',
      target_id: 'u1',
    });
  });
});
