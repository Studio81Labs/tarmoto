import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { AdminAdminsService } from './admin-admins.service.js';

type Actor = {
  id: string;
  role: 'read_only' | 'support' | 'admin' | 'super_admin';
};

function makeService(opts: {
  target?: object | null;
  superAdminCount?: number;
}) {
  const adminRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(opts.target ?? null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(opts.superAdminCount ?? 2),
    create: jest.fn().mockImplementation((v: unknown) => v),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const manager = { getRepository: jest.fn().mockReturnValue(adminRepo) };
  const dataSource = {
    getRepository: jest.fn().mockReturnValue(adminRepo),
    transaction: jest
      .fn()
      .mockImplementation((cb: (m: unknown) => unknown) => cb(manager)),
    manager,
  };
  const service = new AdminAdminsService(dataSource as never);
  return { service, adminRepo, dataSource };
}

const SUPER: Actor = { id: 'super1', role: 'super_admin' };
const ADMIN: Actor = { id: 'admin1', role: 'admin' };

describe('AdminAdminsService', () => {
  it('create: admin cannot create an admin-or-higher (rank gate)', async () => {
    const { service } = makeService({});
    await expect(
      service.create(ADMIN, {
        email: 'x@x.io',
        role: 'admin',
        mode: 'sso-only',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create: password mode requires a password', async () => {
    const { service } = makeService({});
    await expect(
      service.create(SUPER, {
        email: 'x@x.io',
        role: 'support',
        mode: 'password',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: super_admin may create a peer super_admin', async () => {
    const savedRow = {
      id: 'new-super',
      email: 'peer@x.io',
      role: 'super_admin' as const,
      status: 'active' as const,
      created_at: new Date(),
      last_login_at: null,
    };
    // findOne: first call returns null (runCreateAdmin existing-check → CREATE path),
    //          second call returns savedRow (service.create post-create lookup).
    const adminRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(savedRow),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(2),
      create: jest.fn().mockReturnValue(savedRow),
      save: jest.fn().mockResolvedValue(savedRow),
    };
    const manager = { getRepository: jest.fn().mockReturnValue(adminRepo) };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(adminRepo),
      transaction: jest
        .fn()
        .mockImplementation((cb: (m: unknown) => unknown) => cb(manager)),
      manager,
    };
    const service = new AdminAdminsService(dataSource as never);

    await expect(
      service.create(SUPER, {
        email: 'peer@x.io',
        role: 'super_admin',
        mode: 'sso-only',
      }),
    ).resolves.toMatchObject({ role: 'super_admin', email: 'peer@x.io' });
  });

  it('patch: cannot modify your own account', async () => {
    const { service } = makeService({
      target: { id: 'super1', role: 'super_admin', status: 'active' },
    });
    await expect(
      service.patch(SUPER, 'super1', { active: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('patch: cannot disable the last active super_admin', async () => {
    const { service } = makeService({
      target: { id: 'super2', role: 'super_admin', status: 'active' },
      superAdminCount: 1,
    });
    await expect(
      service.patch(SUPER, 'super2', { active: false }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('patch: admin cannot manage another admin (rank gate)', async () => {
    const { service } = makeService({
      target: { id: 'admin2', role: 'admin', status: 'active' },
    });
    await expect(
      service.patch(ADMIN, 'admin2', { role: 'support' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('patch: disabling an admin revokes their sessions', async () => {
    const { service, adminRepo } = makeService({
      // created_at required so toRow() can call .toISOString() without throwing
      target: {
        id: 'sup2',
        role: 'support',
        status: 'active',
        created_at: new Date(),
      },
      superAdminCount: 2,
    });
    await service.patch(SUPER, 'sup2', { active: false });
    // status updated to disabled
    expect(adminRepo.update).toHaveBeenCalledWith(
      { id: 'sup2' },
      expect.objectContaining({ status: 'disabled' }),
    );
    // sessions revoked (revokeAdminSessions issues a session update by admin_user_id)
    expect(adminRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ admin_user_id: 'sup2' }),
      expect.objectContaining({ revoked_at: expect.any(Date) as unknown }),
    );
  });

  it('patch: demoting an active admin (role lowered, status unchanged) revokes their sessions', async () => {
    const { service, adminRepo } = makeService({
      target: {
        id: 'admin2',
        role: 'admin',
        status: 'active',
        created_at: new Date(),
      },
      superAdminCount: 2,
    });
    await service.patch(SUPER, 'admin2', { role: 'support' });
    // role updated, status stays active
    expect(adminRepo.update).toHaveBeenCalledWith(
      { id: 'admin2' },
      expect.objectContaining({ role: 'support', status: 'active' }),
    );
    // sessions revoked on pure demotion even without disable
    expect(adminRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ admin_user_id: 'admin2' }),
      expect.objectContaining({ revoked_at: expect.anything() as unknown }),
    );
  });
});
