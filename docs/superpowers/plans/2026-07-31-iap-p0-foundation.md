# IAP Subscriptions — P0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the store-agnostic foundation for native IAP — shared provider/product vocabulary, the `users`/inbox/reconciliation schema, the atomic provider-claim applied to the existing Stripe flow (identity-guarded terminal clear + two-session refund), a provider-gated `GET /account/subscription`, reversible request-time Stripe cancellation with a restoration-safe reconciliation retry worker, and the companion "manage in store" seam — all with **no** Apple/Google integration yet (P1–P3).

**Architecture:** Extend the single `apps/backend/src/modules/account` billing module. Add three DB objects (columns on `users`, `processed_store_notifications`, `store_billing_reconciliations`). Introduce a `ProviderClaimService` used by the existing Stripe webhook and (later) the store validate paths. Rework deletion-time Stripe cancellation from immediate-at-purge to reversible-at-request (`cancel_at_period_end`) plus a BullMQ retry worker serialized against restoration under a per-rider advisory lock. Extend the subscription snapshot + companion normalizer to be provider-aware.

**Tech Stack:** NestJS 11, TypeORM (raw-SQL migrations, VARCHAR+CHECK enums), PostgreSQL 16, BullMQ (existing jobs module), `@tarmoto/shared`, `@tarmoto/openapi` (generated client), Next.js companion, Vitest (companion) / Jest (backend/shared).

## Global Constraints

- **Metric/units:** N/A here (billing), but keep all money in minor units + currency as the existing snapshot does.
- **Migration numbering:** next prefix is **`1822000000000`**; class name `class <Name>1822000000000 implements MigrationInterface` with a matching `name` field. Enums are `VARCHAR(n)` + a named `CHECK (col IN (...))`, never Postgres `CREATE TYPE`. Every new migration MUST be registered in BOTH `apps/backend/src/data-source.ts` (`migrations: [...]`) AND `apps/backend/src/modules/database/database.module.ts` (`migrations: [...]`), or `migration-registry.spec.ts` fails.
- **New entities** must be added to `apps/backend/src/entities/index.ts` (barrel), `data-source.ts` `entities: [...]`, and `database.module.ts`'s entity list. New COLUMNS on `users` need only `user.entity.ts`.
- **Shared build ordering:** any new `@tarmoto/shared` export requires `pnpm shared:build` before the backend can see it; run `pnpm openapi:gen` after any DTO/description change (it also rebuilds shared). The tracked artifact is `packages/openapi-client/src/generated/schema.d.ts` (the `openapi.yaml` is gitignored).
- **commitlint:** conventional commits, subject **lowercase** after the type, header ≤ 100 chars. Scopes: `backend`, `companion`, `shared`, `openapi`, `cross`. End commit messages with the `Co-Authored-By` trailer.
- **CI is blocked** by the account's GitHub Actions billing issue — validate everything LOCALLY (Jest/Vitest + `tsc --noEmit` + eslint + `pnpm openapi:gen`) and state that CI did not run in the PR.
- **Tier naming:** Pro = €29.99 mid, Premium = €49.99 top (already in `SUBSCRIPTION_PRICING`).
- **Spec is authoritative:** `docs/superpowers/specs/2026-07-30-mobile-iap-subscriptions-design.md`. Where this plan and the spec disagree, the spec governs — raise the conflict.

---

## File Structure

**Shared (`packages/shared/src/`)**

- Modify `constants.ts` — add `SUBSCRIPTION_PROVIDERS`/`SubscriptionProvider`, `SUBSCRIPTION_MANAGED_BY`/`SubscriptionManagedBy`, `IAP_PRODUCTS` + `IapTierProducts` type. (colocated `constants.spec.ts` gets the new assertions.)

**Backend (`apps/backend/src/`)**

- Create `migrations/1822000000000-AddIapFoundation.ts` — users columns + two tables.
- Create `entities/processed-store-notification.entity.ts`, `entities/store-billing-reconciliation.entity.ts`; modify `entities/index.ts`, `entities/user.entity.ts`.
- Modify `data-source.ts`, `modules/database/database.module.ts` (register migration + entities).
- Create `modules/account/provider-claim.service.ts` (+ `.spec.ts`) — the atomic claim + terminal-clear helpers.
- Create `modules/account/store-reconciliation.service.ts` (+ `.spec.ts`) — open/resolve reconciliation rows.
- Modify `modules/account/stripe-billing.client.ts` — add `setCancelAtPeriodEnd`, `refundOrVoidLatestInvoice`.
- Modify `modules/account/account.service.ts` — identity-guard + provider-claim in `handleSubscriptionUpdated`; provider-gated `getSubscription`/`buildSubscriptionSnapshot`; two-session reconciliation.
- Modify `modules/account/account-deletion.service.ts` — request-time reversible cancel, restoration reversal, `deletion_cancel_failed` reconciliation.
- Create `modules/jobs/processors/store-reconciliation.processor.ts` (+ `.spec.ts`) — the restoration-safe retry worker; wire in `modules/jobs`.
- Modify `modules/account/dto/subscription-response.dto.ts` — add `provider`, `managed_by`, `trial_eligible`.
- Modify `modules/account/account.module.ts` — register new providers + entities + exports.

**Companion (`apps/companion/src/`)**

- Modify `lib/subscription.ts` — read `provider`/`managed_by`, add `StoreManaged` branch to the snapshot type + normalizer.
- Modify `app/(dashboard)/settings/subscription/page.tsx` — render a "manage in store" panel for store-managed providers.
- Modify `i18n/locales/en/settings.ts` — new strings.
- Update `lib/subscription.test.ts` / `.../subscription/page.test.tsx`.

---

## Task 1: Shared provider + product vocabulary

**Files:**

- Modify: `packages/shared/src/constants.ts` (after `SUBSCRIPTION_PRICING`)
- Test: `packages/shared/src/constants.spec.ts`

**Interfaces:**

- Produces: `SUBSCRIPTION_PROVIDERS: readonly ['stripe','apple','google']`, `type SubscriptionProvider`; `SUBSCRIPTION_MANAGED_BY: readonly ['stripe_portal','app_store','play_store']`, `type SubscriptionManagedBy`; `IAP_PRODUCTS: Record<Exclude<SubscriptionTier,'free'>, IapTierProducts>` where `IapTierProducts = { apple: { trial: string; noTrial: string }; google: { productId: string; trialOffer: string; noTrialBasePlan: string } }`; helper `managedByForProvider(provider: SubscriptionProvider): SubscriptionManagedBy`.

- [ ] **Step 1: Write the failing test** in `constants.spec.ts`:

```ts
import {
  SUBSCRIPTION_PROVIDERS,
  IAP_PRODUCTS,
  managedByForProvider,
} from "./constants";

describe("subscription providers", () => {
  it("lists the three billing providers", () => {
    expect(SUBSCRIPTION_PROVIDERS).toEqual(["stripe", "apple", "google"]);
  });
  it("maps each paid tier to trial + no-trial store products", () => {
    for (const tier of ["pro", "premium"] as const) {
      expect(IAP_PRODUCTS[tier].apple.trial).toMatch(/\.trial$/);
      expect(IAP_PRODUCTS[tier].apple.noTrial).not.toMatch(/\.trial$/);
      expect(IAP_PRODUCTS[tier].google.productId).toContain(tier);
    }
  });
  it("maps providers to their managed-by surface", () => {
    expect(managedByForProvider("stripe")).toBe("stripe_portal");
    expect(managedByForProvider("apple")).toBe("app_store");
    expect(managedByForProvider("google")).toBe("play_store");
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `pnpm --filter @tarmoto/shared test constants` → FAIL (undefined exports).

- [ ] **Step 3: Implement** in `constants.ts`:

```ts
export const SUBSCRIPTION_PROVIDERS = ["stripe", "apple", "google"] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export const SUBSCRIPTION_MANAGED_BY = [
  "stripe_portal",
  "app_store",
  "play_store",
] as const;
export type SubscriptionManagedBy = (typeof SUBSCRIPTION_MANAGED_BY)[number];

export function managedByForProvider(
  provider: SubscriptionProvider,
): SubscriptionManagedBy {
  return provider === "apple"
    ? "app_store"
    : provider === "google"
      ? "play_store"
      : "stripe_portal";
}

/** Two Apple products per tier because StoreKit auto-applies a configured
 * intro offer; the no-trial product is bought when a rider is ineligible. */
export interface IapTierProducts {
  apple: { trial: string; noTrial: string };
  google: { productId: string; trialOffer: string; noTrialBasePlan: string };
}
export const IAP_PRODUCTS: Record<
  Exclude<SubscriptionTier, "free">,
  IapTierProducts
> = {
  pro: {
    apple: {
      trial: "com.tarmoto.pro.annual.trial",
      noTrial: "com.tarmoto.pro.annual",
    },
    google: {
      productId: "pro_annual",
      trialOffer: "pro-annual-trial",
      noTrialBasePlan: "pro-annual",
    },
  },
  premium: {
    apple: {
      trial: "com.tarmoto.premium.annual.trial",
      noTrial: "com.tarmoto.premium.annual",
    },
    google: {
      productId: "premium_annual",
      trialOffer: "premium-annual-trial",
      noTrialBasePlan: "premium-annual",
    },
  },
};
```

- [ ] **Step 4: Run test → PASS**; then `pnpm shared:build` so the backend picks up the new exports.

- [ ] **Step 5: Commit** `feat(shared): add subscription provider + IAP product vocabulary`.

---

## Task 2: Migration + entities (users columns, inbox, reconciliation)

**Files:**

- Create: `migrations/1822000000000-AddIapFoundation.ts`
- Create: `entities/processed-store-notification.entity.ts`, `entities/store-billing-reconciliation.entity.ts`
- Modify: `entities/user.entity.ts`, `entities/index.ts`, `data-source.ts`, `modules/database/database.module.ts`
- Test: `apps/backend/src/migrations/migration-registry.spec.ts` (existing — must still pass), plus a new entity smoke assertion is optional.

**Interfaces:**

- Produces: `users.subscription_provider VARCHAR(16) NULL`, `users.apple_original_transaction_id VARCHAR(255) NULL`, `users.google_purchase_token VARCHAR(1024) NULL` (each a UNIQUE partial index); tables `processed_store_notifications` and `store_billing_reconciliations` with the columns below; entity classes `ProcessedStoreNotification`, `StoreBillingReconciliation`; new `User` fields `subscription_provider`, `apple_original_transaction_id`, `google_purchase_token`.

- [ ] **Step 1: Write the migration** `1822000000000-AddIapFoundation.ts` (mirror `1714600000000-AddStripeBillingToUsers.ts` style; enums as CHECK):

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIapFoundation1822000000000 implements MigrationInterface {
  name = "AddIapFoundation1822000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- users: provider + store ids (nullable; UNIQUE partial) ---
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN subscription_provider VARCHAR(16)
          CONSTRAINT users_subscription_provider_check
          CHECK (subscription_provider IN ('stripe','apple','google')),
        ADD COLUMN apple_original_transaction_id VARCHAR(255),
        ADD COLUMN google_purchase_token VARCHAR(1024);
    `);
    await queryRunner.query(`
      UPDATE users SET subscription_provider = 'stripe'
      WHERE stripe_subscription_id IS NOT NULL;
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_users_apple_original_transaction_id
         ON users (apple_original_transaction_id)
         WHERE apple_original_transaction_id IS NOT NULL;`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_users_google_purchase_token
         ON users (google_purchase_token)
         WHERE google_purchase_token IS NOT NULL;`,
    );

    // --- processed_store_notifications (transactional inbox) ---
    await queryRunner.query(`
      CREATE TABLE processed_store_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider VARCHAR(16) NOT NULL
          CONSTRAINT psn_provider_check CHECK (provider IN ('apple','google')),
        notification_id VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending'
          CONSTRAINT psn_status_check
          CHECK (status IN ('pending','completed','dead_letter')),
        event_type VARCHAR(64),
        payload JSONB,
        locked_by VARCHAR(128),
        lease_expires_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 10,
        failure_class VARCHAR(16)
          CONSTRAINT psn_failure_class_check
          CHECK (failure_class IN ('transient','permanent')),
        dead_letter_reason VARCHAR(32)
          CONSTRAINT psn_dl_reason_check
          CHECK (dead_letter_reason IN ('permanent_reject','corrupt_context')),
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        dead_lettered_at TIMESTAMPTZ,
        CONSTRAINT uq_psn_provider_notification
          UNIQUE (provider, notification_id)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_psn_status_lease
         ON processed_store_notifications (status, lease_expires_at);`,
    );

    // --- store_billing_reconciliations (durable work items) ---
    await queryRunner.query(`
      CREATE TABLE store_billing_reconciliations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        provider VARCHAR(16) NOT NULL
          CONSTRAINT sbr_provider_check
          CHECK (provider IN ('stripe','apple','google')),
        apple_original_transaction_id VARCHAR(255),
        google_purchase_token VARCHAR(1024),
        stripe_subscription_id VARCHAR(255),
        reason VARCHAR(48) NOT NULL
          CONSTRAINT sbr_reason_check CHECK (reason IN
            ('ineligible_trial_rejected','exclusivity_conflict','deletion_cancel_failed')),
        status VARCHAR(16) NOT NULL DEFAULT 'open'
          CONSTRAINT sbr_status_check CHECK (status IN ('open','resolved')),
        resolution VARCHAR(32)
          CONSTRAINT sbr_resolution_check CHECK (resolution IN
            ('rider_canceled','refunded','expired','server_canceled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_sbr_status_reason
         ON store_billing_reconciliations (status, reason);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_sbr_user ON store_billing_reconciliations (user_id);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS store_billing_reconciliations;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS processed_store_notifications;`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_users_google_purchase_token;`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_users_apple_original_transaction_id;`,
    );
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS google_purchase_token,
        DROP COLUMN IF EXISTS apple_original_transaction_id,
        DROP COLUMN IF EXISTS subscription_provider;
    `);
  }
}
```

- [ ] **Step 2: Add the `User` columns** in `entities/user.entity.ts` (import `SubscriptionProvider` from `@tarmoto/shared` alongside the existing `PlanSource`/`SubscriptionTier` import):

```ts
  @Column({ type: 'varchar', length: 16, nullable: true })
  subscription_provider!: SubscriptionProvider | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  apple_original_transaction_id!: string | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  google_purchase_token!: string | null;
```

- [ ] **Step 3: Create the two entities.** `entities/processed-store-notification.entity.ts` — `@Entity('processed_store_notifications')` class `ProcessedStoreNotification` with `@PrimaryGeneratedColumn('uuid') id`, and `@Column(...)` for every table column above (types: `provider`/`notification_id`/`status`/`event_type`/`locked_by`/`failure_class`/`dead_letter_reason` as `varchar`; `payload` as `@Column({ type: 'jsonb', nullable: true }) payload!: Record<string, unknown> | null`; `lease_expires_at`/`created_at`/`updated_at`/`first_seen_at`/`dead_lettered_at` as `timestamptz`; `attempts`/`max_attempts` as `int`; `last_error` as `text`). `entities/store-billing-reconciliation.entity.ts` — `@Entity('store_billing_reconciliations')` class `StoreBillingReconciliation` with the reconciliation columns (same type mapping).

- [ ] **Step 4: Register.** Add both classes to `entities/index.ts` (barrel export), to `data-source.ts` `entities: [...]` and `migrations: [...]` (import `AddIapFoundation1822000000000`), and to `database.module.ts` entity list + `migrations: [...]`.

- [ ] **Step 5: Run the guard + build** — `pnpm --filter @tarmoto/backend test migration-registry` → PASS; `pnpm backend:build` → compiles. Then apply against a dev DB: `pnpm db:up && pnpm db:migrate` → migration runs clean; `pnpm db:revert` then re-run to prove `down()`/`up()` are symmetric.

- [ ] **Step 6: Commit** `feat(backend): add IAP foundation schema (provider columns, inbox, reconciliation)`.

---

## Task 3: Stripe client — reversible cancel + invoice refund/void

**Files:**

- Modify: `modules/account/stripe-billing.client.ts` (interface `StripeBillingClient` + impl `StripeNodeBillingClient`)
- Test: `modules/account/stripe-billing.client.spec.ts` (create if absent; mock the `Stripe` SDK)

**Interfaces:**

- Produces on `StripeBillingClient`: `setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<void>` (calls `subscriptions.update(id, { cancel_at_period_end })`, tolerates `resource_missing`); `refundOrVoidLatestInvoice(subscriptionId: string): Promise<'refunded' | 'voided' | 'noop'>` (find the subscription's latest paid invoice → `refunds.create({ charge })` if paid, else `invoices.voidInvoice(id)` if open; used by the two-session conflict loser).

- [ ] **Step 1: Write failing tests** — a `setCancelAtPeriodEnd` test asserting `subscriptions.update` is called with `{ cancel_at_period_end: true }` and that a thrown `resource_missing` is swallowed; a `refundOrVoidLatestInvoice` test for the paid-invoice (refund) and open-invoice (void) branches.
- [ ] **Step 2: Run → FAIL** (methods absent).
- [ ] **Step 3: Implement** both methods on `StripeNodeBillingClient` and add their signatures to the `StripeBillingClient` interface, reusing the existing `isResourceMissing` helper and the `this.stripe` null-guard pattern from `cancelSubscription`.
- [ ] **Step 4: Run → PASS**; `pnpm backend:build`.
- [ ] **Step 5: Commit** `feat(backend): add Stripe cancel-at-period-end + invoice refund/void`.

---

## Task 4: ProviderClaimService (atomic claim + identity-guarded terminal clear)

**Files:**

- Create: `modules/account/provider-claim.service.ts` (+ `.spec.ts`)
- Modify: `modules/account/account.module.ts` (register provider + export)

**Interfaces:**

- Consumes: `@InjectRepository(User)` / `DataSource`.
- Produces:
  - `claimForStripe(userId, subscriptionId, fields): Promise<'claimed' | 'conflict'>` — a single guarded `UPDATE users SET (subscription_*, subscription_provider='stripe', stripe_subscription_id=:sub, ...) WHERE id=:id AND (subscription_provider IS NULL OR subscription_provider='stripe') AND (stripe_subscription_id IS NULL OR stripe_subscription_id=:sub)` returning `'claimed'` when `affected===1`, else `'conflict'`.
  - `clearStripeTerminal(userId, subscriptionId): Promise<boolean>` — identity-guarded terminal clear: `UPDATE users SET subscription_provider=NULL, plan_source=NULL, stripe_subscription_id=NULL, subscription_tier='free', subscription_status='canceled', subscription_cancel_at_period_end=false WHERE id=:id AND subscription_provider='stripe' AND stripe_subscription_id=:sub` → returns whether a row changed (a stale `subscription.deleted` for a superseded id is a no-op).

- [ ] **Step 1: Write failing tests** (mock a `QueryBuilder`/`DataSource` or use an in-memory sqlite is out of scope — mock the update result): `claimForStripe` returns `'conflict'` when `affected===0`; `clearStripeTerminal` returns `false` when the stored `stripe_subscription_id` differs from the event's (identity guard); returns `true` on a match.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** with `createQueryBuilder().update(User).set(...).where(...).andWhere(...)` (mirror the existing conditional-claim pattern at `account.service.ts:304-317`).
- [ ] **Step 4: Run → PASS**; register in `account.module.ts` providers + exports.
- [ ] **Step 5: Commit** `feat(backend): add provider-claim service with identity-guarded terminal clear`.

---

## Task 5: Wire the claim into `handleSubscriptionUpdated` + two-session reconciliation

**Files:**

- Modify: `modules/account/account.service.ts` (`handleSubscriptionUpdated`)
- Create: `modules/account/store-reconciliation.service.ts` (+ `.spec.ts`) — `openConflict(...)`, `resolve(id, resolution)`, `findOpen(...)`.
- Modify: `modules/account/account.module.ts`
- Test: `modules/account/account.service.spec.ts` (extend)

**Interfaces:**

- Consumes: `ProviderClaimService`, `StripeBillingClient.refundOrVoidLatestInvoice`, `StoreReconciliationService`.
- Behaviour: the terminal branch (`account.service.ts:234-265`) calls `clearStripeTerminal(userId, subscription.id)` and only proceeds with the cancellation email when it returned `true` (a stale terminal for an old id is a no-op). The activation branch calls `claimForStripe(...)`; on `'conflict'` with a DIFFERENT `stripe_subscription_id` already stored, it does NOT overwrite — it `refundOrVoidLatestInvoice(subscription.id)` for the losing session and `storeReconciliation.openConflict(...)`.

- [ ] **Step 1: Write failing tests**: (a) a `customer.subscription.deleted` whose id ≠ the stored `stripe_subscription_id` leaves tier unchanged and sends no email; (b) a second concurrent activation with a different subscription id triggers `refundOrVoidLatestInvoice` + opens an `exclusivity_conflict` reconciliation and does not clobber the stored id.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**: create `StoreReconciliationService` (repo CRUD on `StoreBillingReconciliation`); refactor the terminal + activation branches to go through the claim/guard; keep the existing email/push dispatch but gate the terminal email on the guard result.
- [ ] **Step 4: Run → PASS**; `pnpm backend:build`.
- [ ] **Step 5: Commit** `fix(backend): identity-guard Stripe terminal + reconcile two-session conflicts`.

---

## Task 6: Provider-gated subscription snapshot + trial eligibility

**Files:**

- Modify: `modules/account/dto/subscription-response.dto.ts` (add `provider`, `managed_by`, `trial_eligible`)
- Modify: `modules/account/account.service.ts` (`getSubscription`, `buildSubscriptionSnapshot`)
- Test: `modules/account/account.service.spec.ts`
- Regen: `pnpm openapi:gen` (commit `packages/openapi-client/src/generated/schema.d.ts`)

**Interfaces:**

- Produces: snapshot gains `provider: SubscriptionProvider | null`, `managed_by: SubscriptionManagedBy | null`, `trial_eligible: boolean`. `getSubscription` queries live Stripe (and overlays it) **only when `subscription_provider === 'stripe'` (or null with a stripe_customer_id for legacy)**; for a store provider it builds the snapshot from the stored `subscription_*` columns with no Stripe read and omits Stripe-only fields (payment method, invoices).

- [ ] **Step 1: Write failing tests**: a user with `subscription_provider='apple'` returns a snapshot with `managed_by:'app_store'`, `payment_method:null`, `billing_history:[]`, and does NOT call `stripe.getBillingSnapshot`; `trial_eligible` reflects `billing_trial_used_at == null`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the provider gate in `getSubscription`; add the three DTO fields with `@ApiProperty`; populate them in `buildSubscriptionSnapshot`.
- [ ] **Step 4: Run → PASS**; `pnpm openapi:gen`; `pnpm backend:build`.
- [ ] **Step 5: Commit** `feat(backend): provider-gate subscription snapshot + expose trial eligibility`.

---

## Task 7: Reversible deletion-time cancellation + restoration + reconciliation

**Files:**

- Modify: `modules/account/account-deletion.service.ts` (`requestDeletion`, add a `restoreAccount`/reversal path if one exists — otherwise document the reversal hook; `purgeUser`/`cancelStripe` adjustments)
- Modify: `modules/account/stripe-billing.client.ts` usage (use `setCancelAtPeriodEnd`)
- Test: `modules/account/account-deletion.service.spec.ts`

**Interfaces:**

- Behaviour: at `requestDeletion`, after scheduling the deletion, call `stripe.setCancelAtPeriodEnd(user.stripe_subscription_id, true)` for a Stripe subscriber (best-effort); on failure open a `deletion_cancel_failed` reconciliation (retained for the worker), do NOT abort the request. Google/Apple paths are P1/P2 (leave TODO hooks referencing the spec, no store calls here). Restoration (if/when an account is restored within the grace window — locate the existing un-delete path, or add `deletion_scheduled_at = NULL` handling) clears `cancel_at_period_end` for Stripe and resolves any open `deletion_cancel_failed` row **under the per-rider advisory lock** (shared with Task 8). `purgeUser`/`cancelStripe` keep the hard cancel + customer delete at purge for accounts that were never restored.

- [ ] **Step 1: Write failing tests**: `requestDeletion` for a Stripe subscriber calls `setCancelAtPeriodEnd(id, true)` (not `cancelSubscription`) and, when that throws, writes a `deletion_cancel_failed` reconciliation and still returns `{status:'scheduled'}`; restoration clears the flag + resolves the row.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**; add the advisory-lock helper (`pg_advisory_xact_lock(hashtext('acct-del:'||user_id))`) used here and by the worker.
- [ ] **Step 4: Run → PASS**; `pnpm backend:build`.
- [ ] **Step 5: Commit** `feat(backend): reversible request-time Stripe cancel on account deletion`.

---

## Task 8: Reconciliation retry worker (restoration-safe) + inbox retention sweeper

**Files:**

- Create: `modules/jobs/processors/store-reconciliation.processor.ts` (+ `.spec.ts`)
- Modify: `modules/jobs/*` (register the repeatable job, mirroring `account-deletion-sweep.processor.ts`)
- Modify: `modules/account/account.module.ts` (export `StoreReconciliationService` for the jobs module, as deletion service is exported today)

**Interfaces:**

- Behaviour: a repeatable BullMQ job drains `store_billing_reconciliations WHERE status='open'`. For `deletion_cancel_failed`: take the per-rider advisory lock, RE-CHECK `deletion_scheduled_at IS NOT NULL` (still pending); if the rider was restored, resolve the row without acting; else retry `setCancelAtPeriodEnd(id, true)` and resolve on success. (Apple/Google reasons are P1/P2 — filter to Stripe-actionable in P0.) A companion sweeper for `processed_store_notifications` (payload-null on completion, dead-letter classification, retention prune) is **spec'd but its producers arrive in P1/P2** — in P0 add only the retention/prune job skeleton with a test that a `completed` row older than the horizon is deleted and a `pending` row is retained.

- [ ] **Step 1: Write failing tests**: the worker skips (resolves-without-cancel) a `deletion_cancel_failed` row whose user has `deletion_scheduled_at = null`; retries + resolves one still pending; the two can't interleave (assert the lock is taken — mirror the trip-shares advisory-lock test).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the processor + registration.
- [ ] **Step 4: Run → PASS**; `pnpm backend:build`.
- [ ] **Step 5: Commit** `feat(backend): restoration-safe reconciliation retry worker`.

---

## Task 9: Companion — provider-aware snapshot + "manage in store" panel

**Files:**

- Modify: `apps/companion/src/lib/subscription.ts` (`SubscriptionSnapshot`, `normalizeSubscriptionSnapshot`)
- Modify: `apps/companion/src/app/(dashboard)/settings/subscription/page.tsx`
- Modify: `apps/companion/src/i18n/locales/en/settings.ts`
- Test: `apps/companion/src/lib/subscription.test.ts`, `.../settings/subscription/page.test.tsx`

**Interfaces:**

- Produces: `SubscriptionSnapshot` gains `provider: SubscriptionProvider | null` and `managedBy: SubscriptionManagedBy | null`; the normalizer reads `provider`/`managed_by`. When `managedBy` is `app_store`/`play_store`, `page.tsx` renders a read-only "Manage your subscription in the App Store / Play Store" panel instead of the Stripe portal/checkout controls (keep plan/status/renewal display).

- [ ] **Step 1: Add i18n strings** to `en/settings.ts` (self-keyed): `"Manage in the App Store"`, `"Manage in Google Play"`, `"Your subscription is managed in the {store}. Open the store to change or cancel it."` (or two literal strings to avoid interpolation-key churn — match the existing catalog style).
- [ ] **Step 2: Write failing tests**: `normalizeSubscriptionSnapshot` maps `provider:'apple'`/`managed_by:'app_store'`; the page renders the store panel (and NOT the "Open billing portal" button) for a store-managed snapshot.
- [ ] **Step 3: Run → FAIL** (`pnpm --filter @tarmoto/companion test`).
- [ ] **Step 4: Implement** the type + normalizer fields and the `page.tsx` branch.
- [ ] **Step 5: Run → PASS**; `pnpm --filter @tarmoto/companion exec tsc --noEmit`; eslint clean; companion catalog test passes.
- [ ] **Step 6: Commit** `feat(companion): render store-managed subscription panel`.

---

## Self-Review

**Spec coverage (P0 items):** shared vocab (T1 ✓), migration + tables (T2 ✓), Stripe client cancel-at-period-end + refund/void (T3 ✓), atomic claim + identity-guarded terminal (T4 ✓), wired into webhook + two-session reconciliation (T5 ✓), provider-gated snapshot + trial eligibility (T6 ✓), reversible request-time cancel + restoration + `deletion_cancel_failed` (T7 ✓), restoration-safe retry worker + inbox retention skeleton (T8 ✓), companion store panel (T9 ✓). **Deferred to P1/P2 by design:** `store_billing_emails` table (first notification email = P1), the inbox lease/dead-letter/redelivery _processing_ (no producer until Apple/Google notifications land), `iap/validate`, the Apple/Google clients. The P0 inbox table is created now (so P1/P2 don't re-migrate) but only its retention skeleton is exercised.

**Type consistency:** `SubscriptionProvider`/`SubscriptionManagedBy` names identical across shared → entity → DTO → companion. `clearStripeTerminal`/`claimForStripe` names identical between T4 (def) and T5 (use). `setCancelAtPeriodEnd`/`refundOrVoidLatestInvoice` identical between T3 (def) and T5/T7 (use).

**Open assumptions to confirm during execution (raise if wrong):**

1. Whether an account-restoration path already exists in `AccountDeletionService` (T7) — if not, its scope (an admin/support endpoint) may belong in a separate task or be stubbed with the reversal helper only.
2. Store product identifiers in `IAP_PRODUCTS` (T1) are placeholders until the real App Store / Play Console ids exist — flagged as ops-provided.
