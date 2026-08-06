# RevenueCat Step 4 — Google Provider Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the Google store-identity column to reflect what RevenueCat actually provides, then add `claimForGoogle` / `clearGoogleTerminal` to `ProviderClaimService`, scoped to what the RevenueCat webhook consumer needs.

**Architecture:** Backend-only, all in `apps/backend/src`. A pure rename migration (the column has no writer and is NULL everywhere), then two methods on the existing `ProviderClaimService` following `claimForStripe` / `clearStripeTerminal` — **not** the much larger `claimForApple`.

**Tech Stack:** NestJS 11, TypeORM, TypeScript strict, Jest 30, PostgreSQL 16.

## Global Constraints

- TypeScript strict. No `any`, **no non-null assertions added**.
- No broad `try/catch`, no silent fallbacks, no behavior that hides failures.
- Jest 30 footgun in this repo: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=X` with an explicit `--` **silently runs the whole suite**. Use `pnpm --filter @tarmoto/backend test --testPathPatterns=X` (no `--`) or `cd apps/backend && npx jest --testPathPatterns=X`. Always check the reported suite count.
- Full suite runs with `cd apps/backend && npx jest --runInBand` (expect **245 suites**). There is a known parallel-worker flake; `--runInBand` avoids it.
- `pnpm --filter @tarmoto/backend lint` must be 0 errors. 10 pre-existing `no-floating-promises` warnings in `events.gateway.ts` are expected and out of scope.
- Every new migration MUST be registered in **both** `apps/backend/src/data-source.ts` **and** `apps/backend/src/modules/database/database.module.ts` — `migration-registry.spec.ts` enforces this and will fail otherwise.
- Conventional commits, scope `backend`.
- No HTTP contract changes in this step, so **no** `openapi:gen` / `postman:gen`. Verify empirically (run `openapi:gen`, confirm zero artifact diff) rather than assuming.
- Source spec: `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md` §1 (rename correction), §3 (scope correction), §4.

## Context an implementer needs

`ProviderClaimService` centralises guarded single-statement UPDATEs that make a provider's ownership of a `users` row race-safe. Every guarded UPDATE stamps and gates on `subscription_lock_fence` so a flow whose Redis lease was lost mid-section cannot clobber a newer flow's state.

**Follow `claimForStripe` (53 lines), not `claimForApple` (194).** Spec §3 carries a scope correction explaining why: nearly all of `claimForApple`'s extra machinery — five return values, a compare-and-swap baseline, two WHERE branches, a disambiguating re-read — exists for `IapValidateService`, which is being deleted. Do not port it speculatively.

**Ordering key semantics differ from Apple, deliberately.** Apple's `signedDate` versions the _state_. RevenueCat's `request_date_ms` versions the _read_. Both are written to `subscription_store_signed_date`, and the `<=` guard still correctly orders concurrent consumers, but it is **not** a state-monotonicity guarantee. Spec §4 step 3 explains why correctness holds anyway (the consumer always applies freshly re-queried authoritative state under the per-rider lock). Do not write a comment claiming state monotonicity.

## File Structure

| File                                                                          | Responsibility                                                           | Task |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---- |
| `apps/backend/src/migrations/1830000000000-RenameGoogleStoreTransactionId.ts` | Create: rename both columns + the partial unique index                   | 1    |
| `apps/backend/src/data-source.ts`                                             | Modify: register the migration                                           | 1    |
| `apps/backend/src/modules/database/database.module.ts`                        | Modify: register the migration                                           | 1    |
| `apps/backend/src/entities/user.entity.ts`                                    | Modify: rename the property                                              | 1    |
| `apps/backend/src/entities/store-billing-reconciliation.entity.ts`            | Modify: rename the property                                              | 1    |
| `apps/backend/src/modules/account/store-reconciliation.service.ts`            | Modify: rename the field it writes                                       | 1    |
| `apps/backend/src/modules/account/provider-claim.service.ts`                  | Modify: add `GoogleClaimFields`, `claimForGoogle`, `clearGoogleTerminal` | 2, 3 |
| `apps/backend/src/modules/account/provider-claim.service.spec.ts`             | Modify: cover both new methods                                           | 2, 3 |

---

### Task 1: Rename the Google store-identity column

**Why:** RevenueCat exposes **no Play purchase token** — not in the webhook body, not in the subscriber API. The identifier it gives for a Play subscription is `store_transaction_id`. Storing that in a column named `google_purchase_token` would make the schema lie. The rename is free: the column has **no writer anywhere in the backend**, so it is NULL in every environment.

**Files:**

- Create: `apps/backend/src/migrations/1830000000000-RenameGoogleStoreTransactionId.ts`
- Modify: `apps/backend/src/data-source.ts`, `apps/backend/src/modules/database/database.module.ts`
- Modify: `apps/backend/src/entities/user.entity.ts:84`, `apps/backend/src/entities/store-billing-reconciliation.entity.ts:45`
- Modify: `apps/backend/src/modules/account/store-reconciliation.service.ts:259`

**Interfaces:**

- Consumes: nothing.
- Produces: `users.google_store_transaction_id` and `store_billing_reconciliations.google_store_transaction_id` (both `varchar`, nullable). Tasks 2 and 3 write and guard on the `users` one.

- [ ] **Step 1: Confirm the column really is unwritten before renaming**

```bash
cd /Users/akadlec/.superset/worktrees/97409800-fba5-47c2-a3d2-456e3b402110/narrow-payment-scope
grep -rn "google_purchase_token" apps/backend/src | grep -v "migrations/"
```

Expected: exactly three hits — the two entity declarations and `store-reconciliation.service.ts:259` (which writes `params.googlePurchaseToken ?? null` and is only reached from the Apple path). If you find any other writer, **stop and report** — the "pure rename, zero data risk" premise is wrong and this plan needs revising.

- [ ] **Step 2: Write the migration**

Create `apps/backend/src/migrations/1830000000000-RenameGoogleStoreTransactionId.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Renames the Google store-identity columns to match what RevenueCat actually
 * provides.
 *
 * RevenueCat exposes NO Play purchase token — neither in the webhook event body
 * nor in the subscriber API. What it gives for a Play subscription is
 * `store_transaction_id`, its own transaction identifier. Keeping the old
 * `google_purchase_token` name would mean the column asserts something about its
 * contents that is false, and a future reader would reasonably assume they could
 * hand the value to the Play Developer API.
 *
 * Pure rename, no data movement: the column has no writer anywhere in the
 * backend (Google IAP was never implemented), so it is NULL in every
 * environment. `ALTER TABLE ... RENAME COLUMN` carries the partial unique index
 * with it automatically; the index is renamed separately only so its NAME stays
 * honest too.
 */
export class RenameGoogleStoreTransactionId1830000000000 implements MigrationInterface {
  name = "RenameGoogleStoreTransactionId1830000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users
         RENAME COLUMN google_purchase_token TO google_store_transaction_id;`,
    );
    await queryRunner.query(
      `ALTER INDEX uq_users_google_purchase_token
         RENAME TO uq_users_google_store_transaction_id;`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         RENAME COLUMN google_purchase_token TO google_store_transaction_id;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         RENAME COLUMN google_store_transaction_id TO google_purchase_token;`,
    );
    await queryRunner.query(
      `ALTER INDEX uq_users_google_store_transaction_id
         RENAME TO uq_users_google_purchase_token;`,
    );
    await queryRunner.query(
      `ALTER TABLE users
         RENAME COLUMN google_store_transaction_id TO google_purchase_token;`,
    );
  }
}
```

- [ ] **Step 3: Register the migration in both places**

In `apps/backend/src/data-source.ts`, add the import next to the `1829000000000` one (~line 154) and the class to the migrations array (~line 324):

```ts
import { RenameGoogleStoreTransactionId1830000000000 } from "./migrations/1830000000000-RenameGoogleStoreTransactionId.js";
```

In `apps/backend/src/modules/database/database.module.ts`, the same two additions (~lines 99 and 357):

```ts
import { RenameGoogleStoreTransactionId1830000000000 } from "../../migrations/1830000000000-RenameGoogleStoreTransactionId.js";
```

- [ ] **Step 4: Run the registry test to confirm both registrations**

```bash
cd apps/backend && npx jest --testPathPatterns=migration-registry
```

Expected: PASS. If it fails, one of the two registration points was missed — that is exactly what this test exists to catch.

- [ ] **Step 5: Rename the entity properties and the one writer**

`apps/backend/src/entities/user.entity.ts` — rename the property (keep the decorator unchanged):

```ts
  @Column({ type: 'varchar', length: 1024, nullable: true })
  google_store_transaction_id!: string | null;
```

`apps/backend/src/entities/store-billing-reconciliation.entity.ts` — same rename on its property.

`apps/backend/src/modules/account/store-reconciliation.service.ts:259` — rename the field being written. Rename the incoming param too if it is named `googlePurchaseToken`, so the whole path reads consistently; check its call sites and the interface it comes from.

- [ ] **Step 6: Verify nothing still references the old name**

```bash
cd /Users/akadlec/.superset/worktrees/97409800-fba5-47c2-a3d2-456e3b402110/narrow-payment-scope
grep -rn "google_purchase_token\|googlePurchaseToken" apps/backend/src packages | grep -v "1822000000000\|1830000000000"
```

Expected: no output. Hits in migration `1822` are correct (it created the original column) and in `1830` (it performs the rename).

- [ ] **Step 7: Build, lint and run the full suite**

```bash
pnpm --filter @tarmoto/backend build
pnpm --filter @tarmoto/backend lint
cd apps/backend && npx jest --runInBand
```

Expected: build clean, lint 0 errors, 245 suites passing.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/migrations/1830000000000-RenameGoogleStoreTransactionId.ts \
        apps/backend/src/data-source.ts \
        apps/backend/src/modules/database/database.module.ts \
        apps/backend/src/entities/user.entity.ts \
        apps/backend/src/entities/store-billing-reconciliation.entity.ts \
        apps/backend/src/modules/account/store-reconciliation.service.ts
git commit -m "refactor(backend): rename the Google store-identity column

RevenueCat exposes no Play purchase token, in either the webhook body or
the subscriber API — the identifier it gives for a Play subscription is
\`store_transaction_id\`. Keeping the \`google_purchase_token\` name would
make the schema assert something false about its own contents.

Pure rename with zero data risk: the column had no writer anywhere in the
backend (Google IAP was never built), so it is NULL in every environment.
The partial unique index is renamed alongside it."
```

---

### Task 2: `claimForGoogle`

**Why:** The RevenueCat webhook consumer (spec §4) needs to atomically claim the rider's single cross-provider subscription slot for a Play subscription, exactly as `claimForStripe` does for Stripe.

**Files:**

- Modify: `apps/backend/src/modules/account/provider-claim.service.ts` — add `GoogleClaimFields` beside the existing `StripeClaimFields` / `AppleClaimFields`, and `claimForGoogle` beside `claimForStripe`
- Test: `apps/backend/src/modules/account/provider-claim.service.spec.ts`

**Interfaces:**

- Consumes: `users.google_store_transaction_id` from Task 1.
- Produces:

  ```ts
  export interface GoogleClaimFields {
    tier: SubscriptionTier;
    status: 'active' | 'trialing' | 'past_due' | 'canceled';
    currentPeriodEnd: Date | null;
    observedAt: Date;
    cancelAtPeriodEnd: boolean;
    markTrialUsed?: boolean;
    fenceToken: number;
  }

  async claimForGoogle(
    userId: string,
    storeTransactionId: string,
    fields: GoogleClaimFields,
    options?: { manager?: EntityManager },
  ): Promise<'claimed' | 'conflict'>
  ```

  Spec §4 step 6 opens a reconciliation row on `'conflict'`, so that value must stay distinguishable.

- [ ] **Step 1: Write the failing tests**

Add to `apps/backend/src/modules/account/provider-claim.service.spec.ts`, following the existing `describe('claimForStripe')` block's fixture style:

```ts
describe("claimForGoogle", () => {
  it("claims an unowned slot and stamps the ordering key and fence", async () => {
    queryBuilder.execute.mockResolvedValueOnce({ affected: 1 });

    const result = await service.claimForGoogle("user-1", "gp-txn-1", {
      tier: "pro",
      status: "active",
      currentPeriodEnd: new Date("2027-01-01T00:00:00Z"),
      observedAt: new Date("2026-08-06T12:00:00Z"),
      cancelAtPeriodEnd: false,
      fenceToken: 7,
    });

    expect(result).toBe("claimed");
    expect(queryBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_provider: "google",
        google_store_transaction_id: "gp-txn-1",
        subscription_tier: "pro",
        plan_source: "subscription",
        subscription_store_signed_date: new Date("2026-08-06T12:00:00Z"),
        subscription_lock_fence: 7,
      }),
    );
  });

  it("returns 'conflict' when the guard matches no row", async () => {
    queryBuilder.execute.mockResolvedValueOnce({ affected: 0 });

    const result = await service.claimForGoogle("user-1", "gp-txn-1", {
      tier: "pro",
      status: "active",
      currentPeriodEnd: null,
      observedAt: new Date("2026-08-06T12:00:00Z"),
      cancelAtPeriodEnd: false,
      fenceToken: 7,
    });

    expect(result).toBe("conflict");
  });

  it("folds the once-per-rider trial stamp into the same statement when markTrialUsed is set", async () => {
    queryBuilder.execute.mockResolvedValueOnce({ affected: 1 });

    await service.claimForGoogle("user-1", "gp-txn-1", {
      tier: "pro",
      status: "trialing",
      currentPeriodEnd: null,
      observedAt: new Date("2026-08-06T12:00:00Z"),
      cancelAtPeriodEnd: false,
      markTrialUsed: true,
      fenceToken: 7,
    });

    const setArg = queryBuilder.set.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    // Folded into the SAME UPDATE, as a raw COALESCE expression — a separate
    // follow-up statement would leave a window where a concurrent claim on
    // another provider could consume the trial marker a second time.
    expect(typeof setArg["billing_trial_used_at"]).toBe("function");
  });

  it("omits the trial stamp entirely when markTrialUsed is not set", async () => {
    queryBuilder.execute.mockResolvedValueOnce({ affected: 1 });

    await service.claimForGoogle("user-1", "gp-txn-1", {
      tier: "pro",
      status: "active",
      currentPeriodEnd: null,
      observedAt: new Date("2026-08-06T12:00:00Z"),
      cancelAtPeriodEnd: false,
      fenceToken: 7,
    });

    const setArg = queryBuilder.set.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(setArg).not.toHaveProperty("billing_trial_used_at");
  });
});
```

Read the top of the spec file first and reuse its existing `service` / `userRepo` / `queryBuilder` fixture rather than inventing a new one. If the shared `queryBuilder.set` mock makes `mock.calls.at(-1)` ambiguous, note it and assert accordingly — the account spec hit exactly this and documents it.

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/backend && npx jest --testPathPatterns=provider-claim.service.spec -t "claimForGoogle"
```

Expected: FAIL with `service.claimForGoogle is not a function`.

- [ ] **Step 3: Add `GoogleClaimFields`**

In `apps/backend/src/modules/account/provider-claim.service.ts`, after `AppleClaimFields`:

```ts
export interface GoogleClaimFields {
  tier: SubscriptionTier;
  status: "active" | "trialing" | "past_due" | "canceled";
  currentPeriodEnd: Date | null;
  /**
   * Ordering key, written to `subscription_store_signed_date`. This is
   * RevenueCat's `request_date_ms` from the authoritative subscriber re-query.
   *
   * NOTE the semantics differ from Apple's `signedDate`, which versions the
   * STATE. `request_date_ms` versions the READ: it says when we asked, not when
   * the subscription last changed. The `<=` guard therefore orders two
   * concurrent consumers correctly (a read that started earlier cannot overwrite
   * what a later read already committed) but carries NO claim that the state it
   * carries is newer. Correctness rests on the consumer always applying freshly
   * re-queried authoritative state under the per-rider lock — see spec §4 step 3.
   */
  observedAt: Date;
  cancelAtPeriodEnd: boolean;
  /**
   * Folds `billing_trial_used_at = COALESCE(billing_trial_used_at, NOW())` into
   * the SAME guarded UPDATE that grants the tier, so the grant and the
   * once-per-rider trial stamp commit atomically. `COALESCE` preserves an
   * already-set stamp, so this is idempotent and never re-dates an earlier trial.
   */
  markTrialUsed?: boolean;
  /** Per-acquisition fencing token from the subscription-mutation lock. */
  fenceToken: number;
}
```

- [ ] **Step 4: Implement `claimForGoogle`**

Add directly after `claimForStripe`:

```ts
  /**
   * Atomically claims (or re-confirms) Google ownership of a user's subscription
   * row. The WHERE clause only allows the write when the row is unclaimed by
   * another provider (`subscription_provider IS NULL OR = 'google'`) and the
   * stored store-transaction id is either unset or already matches — so a Google
   * event can never clobber a Stripe/Apple-owned row, and a stale event for a
   * superseded Google subscription loses instead of overwriting the current one.
   *
   * Returns `'claimed'` when the guard passed, `'conflict'` otherwise. The
   * caller opens a `store_billing_reconciliations` row on `'conflict'` — a
   * purchase that keeps billing with no entitlement must not be silently
   * acknowledged.
   *
   * Deliberately follows `claimForStripe` rather than `claimForApple`: see the
   * scope correction in spec §3.
   */
  async claimForGoogle(
    userId: string,
    storeTransactionId: string,
    fields: GoogleClaimFields,
    options?: { manager?: EntityManager },
  ): Promise<'claimed' | 'conflict'> {
    const result = await this.repoFor(options?.manager)
      .createQueryBuilder()
      .update(User)
      .set({
        subscription_provider: 'google',
        google_store_transaction_id: storeTransactionId,
        subscription_tier: fields.tier,
        subscription_status: fields.status,
        subscription_current_period_end: fields.currentPeriodEnd,
        subscription_store_signed_date: fields.observedAt,
        subscription_cancel_at_period_end: fields.cancelAtPeriodEnd,
        plan_source: 'subscription',
        subscription_lock_fence: fields.fenceToken,
        ...(fields.markTrialUsed
          ? {
              billing_trial_used_at: () =>
                'COALESCE(billing_trial_used_at, NOW())',
            }
          : {}),
      })
      .where('id = :id', { id: userId })
      .andWhere(
        "(subscription_provider IS NULL OR subscription_provider = 'google')",
      )
      .andWhere(
        '(google_store_transaction_id IS NULL OR google_store_transaction_id = :txn)',
        { txn: storeTransactionId },
      )
      // Ordering: a read that started earlier cannot overwrite what a later read
      // already committed. NOT a state-monotonicity guarantee — see
      // `GoogleClaimFields.observedAt`.
      .andWhere(
        '(subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :observedAt)',
        { observedAt: fields.observedAt },
      )
      // Fence: a lease-lost stale flow can't clobber a row a newer acquisition
      // already advanced.
      .andWhere('subscription_lock_fence <= :fence', {
        fence: fields.fenceToken,
      })
      .execute();

    return (result.affected ?? 0) > 0 ? 'claimed' : 'conflict';
  }
```

- [ ] **Step 5: Run the tests**

```bash
cd apps/backend && npx jest --testPathPatterns=provider-claim.service.spec -t "claimForGoogle"
```

Expected: PASS, all four.

- [ ] **Step 6: Full suite, lint, build**

```bash
cd apps/backend && npx jest --runInBand
cd /Users/akadlec/.superset/worktrees/97409800-fba5-47c2-a3d2-456e3b402110/narrow-payment-scope
pnpm --filter @tarmoto/backend lint && pnpm --filter @tarmoto/backend build
```

Expected: 245 suites passing, lint 0 errors, build clean.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/account/provider-claim.service.ts \
        apps/backend/src/modules/account/provider-claim.service.spec.ts
git commit -m "feat(backend): add claimForGoogle to ProviderClaimService

Atomic guarded claim of the rider's single cross-provider subscription
slot for a Play subscription, following claimForStripe's shape rather
than claimForApple's — see the scope correction in the RevenueCat design
spec section 3. The trial stamp folds into the same UPDATE so the grant
and the once-per-rider marker commit atomically.

The ordering key is RevenueCat's request_date_ms, which versions the READ
rather than the state; the guard orders concurrent consumers but is not a
state-monotonicity claim, and that is documented at the field."
```

---

### Task 3: `clearGoogleTerminal`

**Why:** Spec §4 step 5 routes terminal states (expiry, refund, revoke, billing-issue exhaustion) through an identity-guarded clear rather than an unconditional one, so a delayed terminal event for a superseded subscription cannot wipe a newer valid entitlement.

**Files:**

- Modify: `apps/backend/src/modules/account/provider-claim.service.ts` — add `clearGoogleTerminal` after `clearStripeTerminal`
- Test: `apps/backend/src/modules/account/provider-claim.service.spec.ts`

**Interfaces:**

- Consumes: `GoogleClaimFields` conventions and the column from Tasks 1-2.
- Produces:
  ```ts
  async clearGoogleTerminal(
    userId: string,
    storeTransactionId: string,
    observedAt: Date,
    fenceToken: number,
    options?: { preserveGrant?: boolean; manager?: EntityManager },
  ): Promise<boolean>
  ```

**Two behavioural differences from `clearStripeTerminal` — get these right:**

1. **The identity is RETAINED, not nulled.** `clearStripeTerminal` nulls `stripe_subscription_id`; `clearGoogleTerminal` must **keep** `google_store_transaction_id`, matching `clearAppleTerminal`'s retained-OTID behaviour. A later reactivation arrives referencing that same id, and clearing it would leave the reactivation unable to resolve the rider — stranding them on `free`.
2. **It carries `preserveGrant`.** `clearStripeTerminal` gained this so a terminal event cannot revoke a founder/promo/admin grant that merely shares the row. Grants are provider-independent, so the Google clear needs the identical carve-out. Read `clearStripeTerminal`'s current implementation and mirror the option's exact semantics.

- [ ] **Step 1: Write the failing tests**

```ts
describe("clearGoogleTerminal", () => {
  it("clears ownership and tier but RETAINS the store transaction id", async () => {
    queryBuilder.execute.mockResolvedValueOnce({ affected: 1 });

    const result = await service.clearGoogleTerminal(
      "user-1",
      "gp-txn-1",
      new Date("2026-08-06T12:00:00Z"),
      7,
    );

    expect(result).toBe(true);
    const setArg = queryBuilder.set.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(setArg).toMatchObject({
      subscription_provider: null,
      subscription_tier: "free",
      plan_source: null,
    });
    // Retained as a historical binding so a later reactivation can still
    // resolve this rider by it.
    expect(setArg).not.toHaveProperty("google_store_transaction_id");
  });

  it("preserves a non-subscription grant when preserveGrant is set", async () => {
    queryBuilder.execute.mockResolvedValueOnce({ affected: 1 });

    await service.clearGoogleTerminal(
      "user-1",
      "gp-txn-1",
      new Date("2026-08-06T12:00:00Z"),
      7,
      { preserveGrant: true },
    );

    const setArg = queryBuilder.set.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(setArg).not.toHaveProperty("subscription_tier");
    expect(setArg).not.toHaveProperty("plan_source");
    expect(setArg).toMatchObject({ subscription_provider: null });
  });

  it("returns false when the identity guard matches nothing and the fence is current", async () => {
    queryBuilder.execute.mockResolvedValueOnce({ affected: 0 });
    // Fence check finds our token still current → a genuine stale/superseded
    // terminal, not lease loss.
    userRepo.findOne.mockResolvedValueOnce({ subscription_lock_fence: 7 });

    const result = await service.clearGoogleTerminal(
      "user-1",
      "gp-txn-old",
      new Date("2026-08-06T12:00:00Z"),
      7,
    );

    expect(result).toBe(false);
  });
});
```

Mirror whatever `describe('clearStripeTerminal')` / `describe('clearAppleTerminal')` already do for the stale-fence assertion — read them first; `assertSubscriptionFenceCurrent` reads the row, so the third test's mock must match the shape those tests already use.

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/backend && npx jest --testPathPatterns=provider-claim.service.spec -t "clearGoogleTerminal"
```

Expected: FAIL with `service.clearGoogleTerminal is not a function`.

- [ ] **Step 3: Implement it**

Add after `clearStripeTerminal`:

```ts
  /**
   * Identity-guarded terminal clear for a Google subscription. Fires only when
   * the row is still Google-owned AND holds this exact store transaction id, so
   * a delayed terminal for a subscription the rider has since replaced is a
   * no-op rather than wiping the current, still-active one.
   *
   * `google_store_transaction_id` is deliberately RETAINED (unlike
   * `clearStripeTerminal`, which nulls the subscription id): a later
   * reactivation arrives referencing that same id, and clearing it would leave
   * the reactivation unable to resolve the rider, stranding them on `free`.
   * This matches `clearAppleTerminal`'s retained-OTID behaviour.
   *
   * `preserveGrant` omits the tier/provenance reset so a terminal event cannot
   * revoke a founder/promo/admin grant that merely shares the row — grants are
   * provider-independent, so the same carve-out that applies to Stripe applies
   * here.
   */
  async clearGoogleTerminal(
    userId: string,
    storeTransactionId: string,
    observedAt: Date,
    fenceToken: number,
    options?: { preserveGrant?: boolean; manager?: EntityManager },
  ): Promise<boolean> {
    const manager = options?.manager;
    const result = await this.repoFor(manager)
      .createQueryBuilder()
      .update(User)
      .set({
        subscription_provider: null,
        // google_store_transaction_id is intentionally RETAINED (see doc).
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
        subscription_store_signed_date: observedAt,
        subscription_lock_fence: fenceToken,
        ...(options?.preserveGrant
          ? {}
          : { subscription_tier: 'free' as const, plan_source: null }),
      })
      .where('id = :id', { id: userId })
      .andWhere("subscription_provider = 'google'")
      .andWhere('google_store_transaction_id = :txn', {
        txn: storeTransactionId,
      })
      .andWhere(
        '(subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :observedAt)',
        { observedAt },
      )
      .andWhere('subscription_lock_fence <= :fence', { fence: fenceToken })
      .execute();

    if ((result.affected ?? 0) > 0) return true;
    // 0 rows is either a genuine stale/superseded terminal (return false, the
    // caller completes the inbox row) or OUR fence being stale because a newer
    // holder advanced past us. The second must NOT be acked as a no-op, or a
    // real refund/expiry is lost — throw a retryable 503 so it is redelivered.
    await assertSubscriptionFenceCurrent(
      this.repoFor(manager),
      userId,
      fenceToken,
    );
    return false;
  }
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/backend && npx jest --testPathPatterns=provider-claim.service.spec -t "clearGoogleTerminal"
```

Expected: PASS, all three.

- [ ] **Step 5: Full suite, lint, build, and confirm no contract drift**

```bash
cd apps/backend && npx jest --runInBand
cd /Users/akadlec/.superset/worktrees/97409800-fba5-47c2-a3d2-456e3b402110/narrow-payment-scope
pnpm --filter @tarmoto/backend lint && pnpm --filter @tarmoto/backend build
pnpm openapi:gen && git status --porcelain packages/openapi-client packages/openapi
```

Expected: 245 suites passing, lint 0 errors, build clean, and **no** artifact diff — this step changes no HTTP contract. If the artifacts do change, stop and report: something in the entity rename leaked into the published contract, which would need `postman:gen` too.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/account/provider-claim.service.ts \
        apps/backend/src/modules/account/provider-claim.service.spec.ts
git commit -m "feat(backend): add clearGoogleTerminal to ProviderClaimService

Identity-guarded terminal clear so a delayed terminal event for a
superseded Google subscription cannot wipe a newer valid entitlement.

Two deliberate differences from clearStripeTerminal: the store
transaction id is RETAINED as a historical binding, because a later
reactivation resolves the rider by it and clearing it would strand them
on free; and preserveGrant carries over, because grants are
provider-independent and a terminal event must not revoke one that
merely shares the row."
```

---

## Self-Review

**Spec coverage.** Spec §1's rename correction → Task 1. Spec §3's `claimForGoogle` (as scoped by its correction) → Task 2. Spec §3's `clearGoogleTerminal` plus §4 step 5's identity-guarded routing → Task 3. Spec §4's consumer is **not** in this plan — it is delivery step 5 and gets its own.

**Type consistency.** `GoogleClaimFields` is defined in Task 2 step 3 and used in Task 2 steps 1/4. `google_store_transaction_id` is produced in Task 1 and consumed in Tasks 2-3. `claimForGoogle` returns `'claimed' | 'conflict'` in the interface block, the tests, and the implementation. `clearGoogleTerminal` returns `Promise<boolean>` throughout and mirrors `clearStripeTerminal`'s `options` shape.

**Ordering.** Task 1 must land first — Tasks 2 and 3 reference the renamed column and will not compile against the old name. Tasks 2 and 3 both edit `provider-claim.service.ts`, so they are sequential.

**Known gap, deliberately not addressed.** `assertSubscriptionFenceCurrent`'s exact call signature and the spec's stale-fence test fixtures were not read while writing this plan; Task 3 step 1 tells the implementer to read the existing `clearStripeTerminal` / `clearAppleTerminal` tests and mirror them rather than trusting the sketch. If that assertion helper takes different arguments than shown, follow the existing callers.
