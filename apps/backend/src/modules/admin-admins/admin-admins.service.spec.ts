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

function makeAudit() {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

function makeService(opts: {
  target?: object | null;
  superAdminCount?: number;
}) {
  const count = opts.superAdminCount ?? 2;
  const qb = {
    select: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest
      .fn()
      .mockResolvedValue(
        Array.from({ length: count }, (_, i) => ({ id: `super${i}` })),
      ),
  };
  const adminRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(opts.target ?? null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(opts.superAdminCount ?? 2),
    create: jest.fn().mockImplementation((v: unknown) => v),
    save: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };
  const manager = { getRepository: jest.fn().mockReturnValue(adminRepo) };
  const dataSource = {
    getRepository: jest.fn().mockReturnValue(adminRepo),
    transaction: jest
      .fn()
      .mockImplementation((cb: (m: unknown) => unknown) => cb(manager)),
    manager,
  };
  const audit = makeAudit();
  const service = new AdminAdminsService(dataSource as never, audit as never);
  return { service, adminRepo, dataSource, audit, qb };
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
      createQueryBuilder: jest.fn(),
    };
    const manager = { getRepository: jest.fn().mockReturnValue(adminRepo) };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(adminRepo),
      transaction: jest
        .fn()
        .mockImplementation((cb: (m: unknown) => unknown) => cb(manager)),
      manager,
    };
    const audit = makeAudit();
    const service = new AdminAdminsService(dataSource as never, audit as never);

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
      createQueryBuilder: jest.fn(),
    };
    const manager = { getRepository: jest.fn().mockReturnValue(adminRepo) };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(adminRepo),
      transaction: jest.fn(), // must NOT be called
      manager,
    };
    const audit = makeAudit();
    const service = new AdminAdminsService(dataSource as never, audit as never);

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
      createQueryBuilder: jest.fn(),
    };
    const manager = { getRepository: jest.fn().mockReturnValue(adminRepo) };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(adminRepo),
      transaction: jest
        .fn()
        .mockImplementation((cb: (m: unknown) => unknown) => cb(manager)),
      manager,
    };
    const audit = makeAudit();
    const service = new AdminAdminsService(dataSource as never, audit as never);

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

  // Fix 4: race backstop — unique-violation (Postgres code 23505) → ConflictException
  it('create: unique-violation race (code 23505) → ConflictException, not a 500', async () => {
    const dbError = Object.assign(new Error('unique violation'), {
      code: '23505',
    });
    const adminRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null), // pre-check passes (race)
      update: jest.fn(),
      count: jest.fn(),
      create: jest.fn().mockImplementation((v: unknown) => v),
      save: jest.fn().mockRejectedValue(dbError),
      createQueryBuilder: jest.fn(),
    };
    const manager = { getRepository: jest.fn().mockReturnValue(adminRepo) };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(adminRepo),
      transaction: jest
        .fn()
        .mockImplementation((cb: (m: unknown) => unknown) => cb(manager)),
      manager,
    };
    const audit = makeAudit();
    const service = new AdminAdminsService(dataSource as never, audit as never);

    await expect(
      service.create(SUPER, {
        email: 'new@x.io',
        role: 'support',
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

  // Fix 2: disabled super_admin can be demoted when an active super_admin exists
  it('patch: demoting a DISABLED super_admin succeeds even when active count would be 1', async () => {
    // A disabled super_admin being demoted does NOT reduce the active count,
    // so the last-super-admin rail must NOT fire.
    const { service } = makeService({
      target: {
        id: 'super2',
        role: 'super_admin',
        status: 'disabled',
        created_at: new Date(),
      },
      superAdminCount: 1, // only 1 active super_admin; target is disabled
    });
    // Must succeed — should not throw ConflictException.
    await expect(
      service.patch(SUPER, 'super2', { role: 'admin' }),
    ).resolves.toBeDefined();
  });

  it('patch: disabling the last ACTIVE super_admin still throws ConflictException', async () => {
    const { service } = makeService({
      target: {
        id: 'super2',
        role: 'super_admin',
        status: 'active',
        created_at: new Date(),
      },
      superAdminCount: 1,
    });
    await expect(
      service.patch(SUPER, 'super2', { active: false }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // Fix 3: in-tx reload reveals target was promoted → re-validation throws Forbidden
  it('patch: in-tx fresh target has a higher role (race-promoted) → ForbiddenException for lower-rank actor', async () => {
    // Pre-read says target is 'support'; in-tx locked reload reveals 'admin'.
    // An 'admin' actor can manage 'support' but NOT 'admin', so re-validation
    // inside the transaction must reject the patch.
    const preReadTarget = {
      id: 'sup1',
      role: 'support',
      status: 'active',
      created_at: new Date(),
    };
    const freshTarget = {
      id: 'sup1',
      role: 'admin',
      status: 'active',
      created_at: new Date(),
    };
    const qb = {
      select: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest
        .fn()
        .mockResolvedValue([{ id: 'super0' }, { id: 'super1' }]),
    };
    const adminRepo = {
      find: jest.fn().mockResolvedValue([]),
      // 1st call: pre-tx read → preReadTarget
      // 2nd call: in-tx locked reload → freshTarget (role promoted by concurrent tx)
      findOne: jest
        .fn()
        .mockResolvedValueOnce(preReadTarget)
        .mockResolvedValueOnce(freshTarget),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(2),
      create: jest.fn().mockImplementation((v: unknown) => v),
      save: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    const manager = { getRepository: jest.fn().mockReturnValue(adminRepo) };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(adminRepo),
      transaction: jest
        .fn()
        .mockImplementation((cb: (m: unknown) => unknown) => cb(manager)),
      manager,
    };
    const audit = makeAudit();
    const service = new AdminAdminsService(dataSource as never, audit as never);

    // ADMIN actor passes the pre-tx rank gate (sees 'support') but fails the
    // in-tx re-validation (fresh role is 'admin' — peer, not below).
    await expect(
      service.patch(ADMIN, 'sup1', { role: 'read_only' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // Fix 5: denial audit rows are recorded for every lifecycle/permission rejection

  it('patch: self-lockout records a denied audit row with reason=self_lockout', async () => {
    const { service, audit } = makeService({
      target: { id: 'super1', role: 'super_admin', status: 'active' },
    });
    await expect(
      service.patch(SUPER, 'super1', { active: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'denied',
        metadata: { reason: 'self_lockout' },
      }),
    );
  });

  it('patch: rank-gate denial records a denied audit row with reason=insufficient_role', async () => {
    const { service, audit } = makeService({
      target: { id: 'admin2', role: 'admin', status: 'active' },
    });
    await expect(
      service.patch(ADMIN, 'admin2', { role: 'support' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'denied',
        metadata: { reason: 'insufficient_role' },
      }),
    );
  });

  it('patch: last-super-admin denial records a denied audit row with reason=last_super_admin', async () => {
    const { service, audit } = makeService({
      target: { id: 'super2', role: 'super_admin', status: 'active' },
      superAdminCount: 1,
    });
    await expect(
      service.patch(SUPER, 'super2', { active: false }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'denied',
        metadata: { reason: 'last_super_admin' },
      }),
    );
  });

  it('create: duplicate-email denial records a denied audit row with reason=duplicate_email', async () => {
    const { service, audit } = makeService({
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
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'denied',
        metadata: { reason: 'duplicate_email' },
      }),
    );
  });

  it('create: rank-gate denial records a denied audit row with reason=insufficient_role', async () => {
    const { service, audit } = makeService({});
    await expect(
      service.create(ADMIN, {
        email: 'x@x.io',
        role: 'admin',
        mode: 'sso-only',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'denied',
        metadata: { reason: 'insufficient_role' },
      }),
    );
  });
});
