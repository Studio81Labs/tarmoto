import { DataSource, Repository } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';

/**
 * #1139 / #1142 — `purchase_account_token` minting, against a real database.
 *
 * ## Why this is an e2e test and not a unit test
 *
 * It exists because the unit tests were not enough, and demonstrably so. The
 * mint is an `UPDATE ... RETURNING`, which TypeORM returns as
 * `[rows, affectedCount]` — NOT `rows`. The original implementation read
 * `rows[0]?.purchase_account_token`, got `undefined`, and threw
 * `NotFoundException` for **every** caller. The unit tests passed throughout,
 * because they mocked `query` with the shape the code assumed rather than the
 * shape PostgreSQL produces.
 *
 * A mock that agrees with the code instead of with the database proves nothing.
 * These assertions run against the real driver.
 */
describe('purchase_account_token mint (#1139)', () => {
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let userId: string;

  beforeAll(async () => {
    dataSource = new DataSource(AppDataSource.options);
    await dataSource.initialize();
    userRepo = dataSource.getRepository(User);
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const saved = await userRepo.save(
      userRepo.create({
        email: `purchase-identity-${tag}@tarmoto.test`,
        password_hash: 'x',
        display_name: 'MintTest',
      }),
    );
    userId = saved.id;
  });

  afterEach(async () => {
    if (userId) await userRepo.delete(userId);
  });

  /** The exact statement the service issues. */
  async function mint(id: string, candidate: string): Promise<unknown> {
    return userRepo.query(
      `UPDATE users
          SET purchase_account_token = COALESCE(purchase_account_token, $1)
        WHERE id = $2 AND deleted_at IS NULL
    RETURNING purchase_account_token`,
      [candidate, id],
    );
  }

  it('returns [rows, affectedCount] — the shape that broke the first implementation', async () => {
    const res = (await mint(
      userId,
      '11111111-1111-4111-8111-111111111111',
    )) as unknown[];

    // Pinning the driver contract itself. If a TypeORM upgrade ever flattens
    // this, `firstReturnedRow` must be revisited rather than silently returning
    // the wrong thing again.
    expect(Array.isArray(res)).toBe(true);
    expect(Array.isArray(res[0])).toBe(true);
    expect(res[1]).toBe(1);
    expect(
      (res[0] as Array<{ purchase_account_token: string }>)[0]
        ?.purchase_account_token,
    ).toBe('11111111-1111-4111-8111-111111111111');
  }, 30_000);

  it('never rotates: a second mint with a different candidate returns the first token', async () => {
    await mint(userId, '11111111-1111-4111-8111-111111111111');
    const res = (await mint(
      userId,
      '22222222-2222-4222-8222-222222222222',
    )) as unknown[];

    // Rotation would orphan any purchase already bound under the old token.
    expect(
      (res[0] as Array<{ purchase_account_token: string }>)[0]
        ?.purchase_account_token,
    ).toBe('11111111-1111-4111-8111-111111111111');
  }, 30_000);

  it('refuses a soft-deleted rider', async () => {
    await userRepo.update(userId, { deleted_at: new Date() });
    const res = (await mint(
      userId,
      '33333333-3333-4333-8333-333333333333',
    )) as unknown[];

    // Zero rows: a locked-out rider must not be able to bind a fresh purchase
    // the deletion workflow does not cancel (#1140).
    expect((res[0] as unknown[]).length).toBe(0);
  }, 30_000);

  it('enforces uniqueness across riders', async () => {
    const other = await userRepo.save(
      userRepo.create({
        email: `purchase-identity-other-${Date.now()}@tarmoto.test`,
        password_hash: 'x',
        display_name: 'Other',
      }),
    );
    try {
      const shared = '44444444-4444-4444-8444-444444444444';
      await mint(userId, shared);
      // A duplicate must be rejected by `uq_users_purchase_account_token`:
      // ingestion maps this value back to a rider, so two owners would resolve
      // one token to two accounts.
      await expect(mint(other.id, shared)).rejects.toThrow(/duplicate key/i);
    } finally {
      await userRepo.delete(other.id);
    }
  }, 30_000);
});
