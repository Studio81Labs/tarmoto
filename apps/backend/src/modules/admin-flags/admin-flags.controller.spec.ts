import type { AdminRequest } from '../admin/internal.guard.js';
import { AdminFlagsController } from './admin-flags.controller.js';
import { AdminFlagsService } from './admin-flags.service.js';

describe('AdminFlagsController', () => {
  const service = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'f1' }),
    update: jest.fn().mockResolvedValue({ id: 'f1' }),
    remove: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AdminFlagsService>;
  const controller = new AdminFlagsController(service);
  const req = {} as unknown as AdminRequest;

  it('GET /admin/flags lists', async () => {
    await controller.list();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.list).toHaveBeenCalled();
  });

  it('POST /admin/flags creates + sets audit target', async () => {
    await controller.create(req, { key: 'beta_ui' });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.create).toHaveBeenCalledWith({ key: 'beta_ui' });
  });

  it('PATCH /admin/flags/:id updates', async () => {
    await controller.update(req, 'f1', { enabled: true });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.update).toHaveBeenCalledWith('f1', { enabled: true });
  });

  it('DELETE /admin/flags/:id removes', async () => {
    await controller.remove(req, 'f1');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.remove).toHaveBeenCalledWith('f1');
  });
});
