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
    // findOne call order with the create-only guard in place:
    //   1st → null   (dup check — no existing admin with this email)
    //   2nd → null   (runCreateAdmin existing-check → CREATE path)
    //   3rd → savedRow (service.create post-create lookup)
    const adminRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
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

  it('create: escalation guard — existing email throws ConflictException; runCreateAdmin not called', async () => {
    // Regression test for the privilege-escalation hole: without the explicit
    // 409 guard, an admin could POST { email: <existing super_admin>, role: 'support' }
    // and the upsert path in runCreateAdmin would demote the super_admin, bypassing
    // all of patch()'s per-target rank checks and safety rails.
    const existingSuper = {
      id: 'super99',
      email: 'victim@x.io',
      role: 'super_admin' as const,
      status: 'active' as const,
      created_at: new Date(),
      last_login_at: null,
    };
    const adminRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(existingSuper), // dup check finds existing row
      update: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };
    const manager = { getRepository: jest.fn().mockReturnValue(adminRepo) };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(adminRepo),
      transaction: jest.fn(), // must NOT be called
      manager,
    };
    const service = new AdminAdminsService(dataSource as never);

    // An admin POSTs the super_admin's email with a lower role — role gate would
    // pass (support < admin), but the dup check must reject it.
    await expect(
      service.create(ADMIN, {
        email: 'victim@x.io',
        role: 'support',
        mode: 'sso-only',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Critical regression assertion: runCreateAdmin was never invoked.
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('create: new email (no existing row) succeeds for an allowed role', async () => {
    const savedRow = {
      id: 'new1',
      email: 'new@x.io',
      role: 'support' as const,
      status: 'active' as const,
      created_at: new Date(),
      last_login_at: null,
    };
    const adminRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null) // dup check → no existing admin
        .mockResolvedValueOnce(null) // runCreateAdmin existing-check → CREATE path
        .mockResolvedValueOnce(savedRow), // post-create lookup
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
      service.create(ADMIN, {
        email: 'new@x.io',
        role: 'support',
        mode: 'sso-only',
      }),
    ).resolves.toMatchObject({ role: 'support', email: 'new@x.io' });
  });

  it('create: duplicate email (any existing row) throws ConflictException regardless of role', async () => {
    // The 409 guard must fire even when the actor role would have permitted the
    // operation — the point is that create() must never mutate an existing row.
    const { service } = makeService({
      target: {
        id: 'any1',
        email: 'dupe@x.io',
        role: 'read_only' as const,
        status: 'active' as const,
        created_at: new Date(),
      },
    });
    await expect(
      service.create(SUPER, {
        email: 'dupe@x.io',
        role: 'read_only',
        mode: 'sso-only',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
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
