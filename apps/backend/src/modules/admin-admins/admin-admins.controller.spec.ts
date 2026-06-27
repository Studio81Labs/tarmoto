import type { AdminRequest } from '../admin/internal.guard.js';
import { AdminAdminsController } from './admin-admins.controller.js';
import { AdminAdminsService } from './admin-admins.service.js';

describe('AdminAdminsController', () => {
  const service = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'a1' }),
    patch: jest.fn().mockResolvedValue({ id: 'a1' }),
  } as unknown as jest.Mocked<AdminAdminsService>;
  const controller = new AdminAdminsController(service);
  const req = {
    adminUser: { id: 'super1', role: 'super_admin' },
  } as unknown as AdminRequest;

  it('GET /admin/admins lists', async () => {
    await controller.list();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.list).toHaveBeenCalled();
  });

  it('POST /admin/admins passes the acting admin + dto', async () => {
    const dto = {
      email: 'x@x.io',
      role: 'support' as const,
      mode: 'sso-only' as const,
    };
    await controller.create(req, dto);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.create).toHaveBeenCalledWith(
      { id: 'super1', role: 'super_admin' },
      dto,
    );
  });

  it('PATCH /admin/admins/:id passes actor, id, dto', async () => {
    await controller.patch(req, 'a1', { active: false });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.patch).toHaveBeenCalledWith(
      { id: 'super1', role: 'super_admin' },
      'a1',
      { active: false },
    );
  });
});
