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

  it('GET /admin/users forwards the query', async () => {
    await controller.list({ q: 'x' });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.list).toHaveBeenCalledWith({ q: 'x' });
  });

  it('GET /admin/users/:id forwards the id', async () => {
    await controller.getById('u1');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.getById).toHaveBeenCalledWith('u1');
  });

  it('DELETE /admin/users/:id soft-deletes', async () => {
    await controller.softDelete('u1');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.softDelete).toHaveBeenCalledWith('u1');
  });

  it('POST /admin/users/:id/restore restores', async () => {
    await controller.restore('u1');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.restore).toHaveBeenCalledWith('u1');
  });
});
