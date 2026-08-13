import { BILLED_TIER_SQL } from '../account/entitlement.js';
import { NotFoundException } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { AdminUsersService } from './admin-users.service.js';

function makeQb(result: [unknown[], number] = [[SAMPLE_USER], 1]) {
  const qb = {
    addSelect: jest.fn().mockReturnThis(),
    // getById() now builds its query too, so the mock must answer `where` and
    // `getOne` as well as the list chain.
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result[0][0] ?? null),
    orderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    andWhere: jest.fn(),
    getManyAndCount: jest.fn().mockResolvedValue(result),
  };
  // make chainable
  qb.orderBy.mockReturnValue(qb);
  qb.skip.mockReturnValue(qb);
  qb.take.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  return qb;
}

function repo<T extends object>(over: Partial<T> = {}): T {
  return {
    createQueryBuilder: jest.fn().mockReturnValue(makeQb()),
    findOne: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    update: jest.fn(),
    ...over,
  } as unknown as T;
}

const SAMPLE_USER = {
  id: 'u1',
  email: 'rider@x.io',
  display_name: 'Rider',
  subscription_tier: 'free',
  subscription_status: 'canceled',
  subscription_current_period_end: null,
  subscription_cancel_at_period_end: false,
  home_region: 'CZ',
  email_verified_at: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  deleted_at: null,
  deletion_scheduled_at: null,
  deletion_reason: null,
};

function make(over: { users?: object } = {}) {
  const qb = makeQb();
  const users =
    over.users ??
    repo({
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn().mockResolvedValue(SAMPLE_USER),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    });
  const activity = () => repo({ count: jest.fn().mockResolvedValue(3) });
  const notificationPrefs = {
    get: jest.fn().mockResolvedValue({ email_digest: 'weekly' }),
    update: jest.fn().mockResolvedValue({ email_digest: 'never' }),
  };
  const accountDeletion = {
    restoreAccount: jest.fn().mockResolvedValue(true),
  };
  const chainsQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const chains = repo({
    createQueryBuilder: jest.fn(() => chainsQb),
  });
  const service = new AdminUsersService(
    users as never,
    activity() as never, // rides
    activity() as never, // hazards
    activity() as never, // reviews
    activity() as never, // trips
    activity() as never, // commutes
    notificationPrefs as never,
    accountDeletion as never,
    // Only the overlap fallback window is read; the default matches the
    // service's own so the filter's cutoff stays the documented one.
    { get: (_k: string, d: number) => d } as never,
    chains as never,
  );
  return {
    service,
    users,
    qb,
    chains,
    chainsQb,
    notificationPrefs,
    accountDeletion,
  };
}

describe('AdminUsersService', () => {
  it('list() returns paginated rows + total', async () => {
    const { service, users } = make();
    const res = await service.list({ page: 1, pageSize: 25 });
    expect(res).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(res.rows[0]).toMatchObject({ id: 'u1', email: 'rider@x.io' });
    expect(users.createQueryBuilder).toHaveBeenCalledWith('u');
  });

  it('projects status from the ELECTED chain, not the Stripe column', async () => {
    // A store-only rider keeps `canceled` on the users row, so projecting the
    // column beside a chain-aware tier showed them as "paid but canceled" — a
    // contradiction an operator cannot act on.
    const { service, chainsQb } = make();
    chainsQb.getMany.mockResolvedValueOnce([
      {
        user_id: 'u1',
        provider: 'google',
        target_key: 'GPA.1',
        tier: 'premium',
        status: 'active',
        current_period_end: new Date(Date.now() + 86_400_000),
        cancel_at_period_end: false,
      },
    ]);

    const res = await service.list({ page: 1, pageSize: 25 });

    expect(res.rows[0]?.subscription_status).toBe('active');
  });

  it('elects across BOTH providers, matching the rider-facing snapshot', async () => {
    // Stripe Premium beside an Apple Pro chain. The election is over the whole
    // set, so Stripe wins on tier — and the admin row must therefore show
    // Stripe's status, not the chain's. An admin page that disagrees with the
    // rider's own screen about who is billing them is the failure the shared
    // election exists to prevent.
    const { service, chainsQb } = make({
      users: repo({
        createQueryBuilder: jest.fn().mockReturnValue(
          makeQb([
            [
              {
                ...SAMPLE_USER,
                subscription_tier: 'premium',
                subscription_status: 'active',
                subscription_current_period_end: new Date(
                  Date.now() + 86_400_000,
                ),
                subscription_cancel_at_period_end: false,
                // Evidence of a REAL Stripe subscription. Without it the source
                // is (correctly) not admitted — this fixture was relying on the
                // fabrication the grant fix removed.
                stripe_subscription_id: 'sub_1',
              },
            ],
            1,
          ]),
        ),
      }),
    });
    chainsQb.getMany.mockResolvedValueOnce([
      {
        user_id: SAMPLE_USER.id,
        provider: 'apple',
        target_key: 'otid.1',
        tier: 'pro',
        status: 'past_due',
        current_period_end: new Date(Date.now() + 86_400_000),
        cancel_at_period_end: false,
      },
    ]);

    const res = await service.list({ page: 1, pageSize: 25 });

    expect(res.rows[0]?.subscription_status).toBe('active');
  });

  it('does NOT fabricate a Stripe source for a GRANT-only rider', async () => {
    // Registration dual-writes grants into subscription_tier, so a founder
    // carries a paid tier with every Stripe identifier null. Electing that
    // invented source would show the users row's `canceled` status against an
    // active chain — the admin page contradicting the rider's own screen.
    const { service, chainsQb } = make({
      users: repo({
        createQueryBuilder: jest.fn().mockReturnValue(
          makeQb([
            [
              {
                ...SAMPLE_USER,
                subscription_tier: 'premium',
                subscription_status: 'canceled',
                subscription_current_period_end: null,
                stripe_subscription_id: null,
                grant_tier: 'premium',
                grant_source: 'founder',
              },
            ],
            1,
          ]),
        ),
      }),
    });
    chainsQb.getMany.mockResolvedValueOnce([
      {
        user_id: SAMPLE_USER.id,
        provider: 'apple',
        target_key: 'otid.1',
        tier: 'pro',
        status: 'active',
        current_period_end: new Date(Date.now() + 86_400_000),
        cancel_at_period_end: false,
      },
    ]);

    const res = await service.list({ page: 1, pageSize: 25 });

    // The chain is the only real billing source, so it represents the plan.
    expect(res.rows[0]?.subscription_status).toBe('active');
  });

  it('elects for the whole page in ONE query', async () => {
    // A per-row read would turn a 25-row page into 26 round trips for a display
    // field.
    const { service, chains } = make();
    await service.list({ page: 1, pageSize: 25 });
    expect(chains.createQueryBuilder).toHaveBeenCalledTimes(1);
  });

  it('getById() includes activity counts', async () => {
    const { service } = make();
    const detail = await service.getById('u1');
    expect(detail.activity).toEqual({
      rides: 3,
      hazardReports: 3,
      roadReviews: 3,
      trips: 3,
      commuteRoutes: 3,
    });
  });

  it('getById() throws NotFound for unknown id', async () => {
    const { service } = make({
      // getById() builds a query now, so the empty case is an empty qb result —
      // findOne alone no longer reaches it.
      users: repo({
        findOne: jest.fn().mockResolvedValue(null),
        createQueryBuilder: jest.fn().mockReturnValue(makeQb([[], 0])),
      }),
    });
    await expect(service.getById('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('softDelete() sets deleted_at + reason with conditional update on deleted_at IS NULL', async () => {
    const { service, users } = make();
    await service.softDelete('u1');

    const [criteria, payload] = (users.update as jest.Mock).mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(criteria).toMatchObject({ id: 'u1' });
    expect(criteria).toHaveProperty('deleted_at');
    expect(criteria.deleted_at).toEqual(IsNull());

    expect(payload).toMatchObject({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      deleted_at: expect.any(Date),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      deletion_reason: expect.any(String),
    });
    expect(payload).not.toHaveProperty('deletion_scheduled_at');
  });

  it('softDelete() is idempotent — does NOT call update when user is already deleted', async () => {
    const alreadyDeleted = {
      ...SAMPLE_USER,
      deleted_at: new Date('2026-03-01T00:00:00Z'),
      deletion_reason: 'Soft-deleted by admin',
    };
    const { service, users } = make({
      users: repo({
        findOne: jest.fn().mockResolvedValue(alreadyDeleted),
        update: jest.fn(),
      }),
    });
    await service.softDelete('u1');
    // update must NOT have been called — the original deleted_at must be preserved.
    expect(users.update).not.toHaveBeenCalled();
  });

  it('restore() delegates to the reversal path (re-enables Stripe renewal + resolves reconciliation under the lock) instead of a direct column clear', async () => {
    const { service, users, accountDeletion } = make();
    await service.restore('u1');
    // No direct column UPDATE — the restore now goes through
    // AccountDeletionService.restoreAccount so a restored subscriber's
    // cancel_at_period_end is flipped back and the deletion_cancel_failed
    // reconciliation is resolved under the per-rider advisory lock.
    expect(accountDeletion.restoreAccount).toHaveBeenCalledWith('u1');
    expect(users.update).not.toHaveBeenCalled();
  });

  it('restore() throws NotFound for an unknown id (and never calls the reversal path)', async () => {
    const { service, accountDeletion } = make({
      users: repo({ findOne: jest.fn().mockResolvedValue(null) }),
    });
    await expect(service.restore('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(accountDeletion.restoreAccount).not.toHaveBeenCalled();
  });

  it('list() applies deleted filter to each search clause', async () => {
    const qb = makeQb();
    const users = repo({
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn().mockResolvedValue(SAMPLE_USER),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    });
    const activity = () => repo({ count: jest.fn().mockResolvedValue(3) });
    const service = new AdminUsersService(
      users as never,
      activity() as never,
      activity() as never,
      activity() as never,
      activity() as never,
      activity() as never,
      { get: jest.fn(), update: jest.fn() } as never,
      { restoreAccount: jest.fn() } as never,
      { get: (_k: string, d: number) => d } as never,
      repo({
        createQueryBuilder: jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        })),
      }),
    );

    await service.list({ q: 'foo', deleted: 'active', page: 1, pageSize: 25 });

    // deleted filter clause applied
    expect(qb.andWhere).toHaveBeenCalledWith('u.deleted_at IS NULL');
    // q search clause applied (both email and display_name via OR)
    expect(qb.andWhere).toHaveBeenCalledWith(
      '(u.email ILIKE :q OR u.display_name ILIKE :q)',
      { q: '%foo%' },
    );
  });

  it('list() filters by subscription_tier OR subscription_status when subscription is set', async () => {
    const qb = makeQb();
    const users = repo({
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn().mockResolvedValue(SAMPLE_USER),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    });
    const activity = () => repo({ count: jest.fn().mockResolvedValue(0) });
    const service = new AdminUsersService(
      users as never,
      activity() as never,
      activity() as never,
      activity() as never,
      activity() as never,
      activity() as never,
      { get: jest.fn(), update: jest.fn() } as never,
      { restoreAccount: jest.fn() } as never,
      { get: (_k: string, d: number) => d } as never,
      repo({
        createQueryBuilder: jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        })),
      }),
    );

    await service.list({ subscription: 'past_due' });

    // Asserted through the shared constant rather than a copy of the SQL: the
    // filter and resolveBilledTier are the same rule expressed twice, and a
    // hardcoded string here would let the query drift from the projection
    // without any test noticing.
    // Asserted through the shared constant plus the clauses that must be there,
    // rather than a copy of the whole predicate: a hardcoded string would let
    // the query drift from resolveBilledTier with no test noticing, and would
    // also have to be rewritten every time a clause is added.
    const [predicate, params] = qb.andWhere.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    expect(predicate).toContain(BILLED_TIER_SQL('u'));
    expect(predicate).toContain('u.subscription_status = :sub');
    // Status has no rollup column, so a store-only rider is only reachable
    // through the chains themselves.
    expect(predicate).toContain('FROM store_subscriptions sc');
    expect(params).toEqual(
      expect.objectContaining({
        sub: 'past_due',
        billedNow: expect.any(Date) as Date,
      }),
    );
  });

  describe('notification preferences', () => {
    it('returns a user notification prefs after confirming the user exists', async () => {
      const { service, notificationPrefs } = make();
      const res = await service.getNotificationPreferences('u1');
      expect(res).toMatchObject({ email_digest: 'weekly' });
      expect(notificationPrefs.get).toHaveBeenCalledWith('u1');
    });

    it('throws NotFound (and never reads prefs) for an unknown user', async () => {
      const { service, notificationPrefs } = make({
        users: repo({ findOne: jest.fn().mockResolvedValue(null) }),
      });
      await expect(service.getNotificationPreferences('nope')).rejects.toThrow(
        NotFoundException,
      );
      expect(notificationPrefs.get).not.toHaveBeenCalled();
    });

    it('delegates the update to NotificationPreferencesService', async () => {
      const { service, notificationPrefs } = make();
      const res = await service.updateNotificationPreferences('u1', {
        email_digest: 'never',
      });
      expect(res).toMatchObject({ email_digest: 'never' });
      expect(notificationPrefs.update).toHaveBeenCalledWith('u1', {
        email_digest: 'never',
      });
    });

    it('throws NotFound (and never writes) for an unknown user', async () => {
      const { service, notificationPrefs } = make({
        users: repo({ findOne: jest.fn().mockResolvedValue(null) }),
      });
      await expect(
        service.updateNotificationPreferences('nope', {
          email_digest: 'never',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(notificationPrefs.update).not.toHaveBeenCalled();
    });
  });
});
