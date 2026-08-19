# IAP Subscriptions — P1a: Apple Validate Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the backend validate a StoreKit 2 Apple purchase — an `AppleBillingClient` that verifies a signed `JWSTransaction` (x5c → Apple root + `bundleId`/environment check) and queries the App Store Server API, plus `POST /account/subscription/iap/validate` (Apple path) that binds the purchase to the rider, derives the tier from the _verified_ product, atomically claims the provider slot (Stripe/Apple exclusivity), handles the intro trial, and returns the subscription snapshot. **No ASSN v2 webhook or lifecycle processing** — that is P1b.

**Architecture:** Add Apple's official `app-store-server-library` as the JWS/cert-chain verifier + App Store Server API client. New `AppleBillingClient` mirrors `stripe-billing.client.ts` (Symbol token + interface + `useExisting`, `isConfigured()`/`requireX()` guard, `null` when unconfigured). Add `ProviderClaimService.claimForApple`/`clearAppleTerminal` mirroring the Stripe guarded-UPDATE pattern. A new `IapValidateService` (or a method group on `AccountService`) runs the validate flow and reuses the existing `StoreReconciliationService` + the provider-gated snapshot (an Apple validate persists the `User` row; `getSubscription` returns `liveSnapshot=null` for the store path — no snapshot change needed).

**Tech Stack:** NestJS 11, TypeORM, PostgreSQL 16, `app-store-server-library` (NEW), native `fetch` (the library handles the App Store Server API HTTP), `@tarmoto/shared`, `@tarmoto/openapi` client, Jest.

## Global Constraints

- **Verification library:** use Apple's official **`app-store-server-library`** (npm) for: `SignedDataVerifier` (verify `JWSTransaction` — signature + x5c chain to the Apple Root CA + `bundleId` + `environment`), decoding the signed transaction/renewal payloads, and `AppStoreServerAPIClient` (`getAllSubscriptionStatuses` / subscription status). Add it as a DIRECT dependency of `apps/backend`. The Apple Root CA certificates the verifier needs are loaded from config/bundled PEM (the library requires the root certs passed in — see its README; store them as a committed asset or an env-provided path). **Verify the exact class/method names against the installed package's TypeScript types before coding** — this plan names the primary types but the implementer confirms the API surface.
- **Env (`TARMOTO_APPLE_IAP_*`, mirror the APN `.p8` pattern in `push.module.ts`):** `TARMOTO_APPLE_IAP_ISSUER_ID`, `TARMOTO_APPLE_IAP_KEY_ID`, `TARMOTO_APPLE_IAP_PRIVATE_KEY` (the `.p8` contents OR a path — match `TARMOTO_APN_KEY`'s "path or contents" handling), `TARMOTO_APPLE_IAP_BUNDLE_ID`, `TARMOTO_APPLE_IAP_ENVIRONMENT` (`Sandbox`|`Production`). An unconfigured client stays `null` and its methods throw `ServiceUnavailableException` (mirror `StripeNodeBillingClient.requireStripe`/`isConfigured`). Document all in `apps/backend/.env.example` (near the Stripe/APN blocks).
- **Account binding:** the client sets Apple `appAccountToken` to the rider's `users.id` (a UUID). Validate REJECTS (409) when the verified `appAccountToken` ≠ the authenticated user's id, or when the `apple_original_transaction_id` is already owned by a different rider (the UNIQUE partial index → 409).
- **Tier from the VERIFIED product only:** map the verified transaction's product id through `IAP_PRODUCTS[tier].apple.{trial,noTrial}` (both map to the same tier). NEVER trust a client-supplied product id; reject an unknown product.
- **Exclusivity:** the atomic provider claim rejects (409) when a DIFFERENT provider (Stripe/Google) already owns the slot (active/trialing/past_due). Reuse the guarded-UPDATE pattern.
- **Trial:** honour a trial only when `billing_trial_used_at IS NULL`. If a trial transaction arrives for a backend-ineligible rider, REJECT + open an `ineligible_trial_rejected` reconciliation (no second trial). On a genuine first trial, stamp `billing_trial_used_at`.
- **Terminal vs retryable:** the validate response carries `retryable: boolean` (+ provider) so the client drives the finish/close-out (a store-API outage → retryable 5xx; a signature/binding/unknown-product/ineligible-trial failure → terminal). Idempotent on the transaction id (a re-validate of the same transaction is a no-op returning the current snapshot).
- **Migration numbering / registration, shared-build ordering, `openapi:gen` after DTO changes (commit `packages/openapi-client/src/generated/schema.d.ts`), commitlint (lowercase subject ≤100 chars, `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`), CI is BLOCKED → validate locally** — all identical to the P0 plan's constraints. No new migration is expected (P0 added all columns).
- **Spec authoritative:** `docs/superpowers/specs/2026-07-30-mobile-iap-subscriptions-design.md` (the `AppleBillingClient` + `iap/validate` sections). Where this plan and the spec disagree, the spec governs — raise it.

## File Structure

- Modify `apps/backend/package.json` — add `app-store-server-library`.
- Create `apps/backend/src/modules/account/apple-billing.client.ts` (+ `.spec.ts`) — `APPLE_BILLING_CLIENT` Symbol, `AppleBillingClient` interface, `AppleStoreKitBillingClient` impl.
- Create `apps/backend/src/modules/account/apple-iap.config.ts` (or fold into the client) — reads/validates `TARMOTO_APPLE_IAP_*`.
- Create `apps/backend/test/fixtures/apple/` — captured/synthetic JWS transaction fixtures + a fake root for tests.
- Modify `apps/backend/src/modules/account/provider-claim.service.ts` (+ `.spec.ts`) — add `claimForApple`, `clearAppleTerminal`.
- Create `apps/backend/src/modules/account/dto/iap-validate.dto.ts` — `IapValidateRequestDto`, `IapValidateResponseDto` (extends the snapshot shape + `retryable`).
- Create `apps/backend/src/modules/account/iap-validate.service.ts` (+ `.spec.ts`) — the Apple validate flow.
- Modify `apps/backend/src/modules/account/account.controller.ts` — add `POST subscription/iap/validate`.
- Modify `apps/backend/src/modules/account/account.module.ts` — register client + service + token.
- Modify `apps/backend/.env.example` — the `TARMOTO_APPLE_IAP_*` block.
- Regen `packages/openapi-client/src/generated/schema.d.ts`.

---

## Task 1: Dependency + Apple IAP config

**Files:** modify `apps/backend/package.json`; create `apps/backend/src/modules/account/apple-iap.config.ts` (+ `.spec.ts`); modify `apps/backend/.env.example`.

**Interfaces — Produces:** an injectable `AppleIapConfig` (or a plain factory) exposing `{ issuerId; keyId; privateKey; bundleId; environment: 'Sandbox'|'Production'; isConfigured(): boolean }`, reading `TARMOTO_APPLE_IAP_*` via `ConfigService` (trim + null-coalesce, `.p8` path-or-contents like `TARMOTO_APN_KEY`).

- [ ] **Step 1:** `pnpm --filter @tarmoto/backend add app-store-server-library` (pin the version it resolves). Confirm it installs + `pnpm backend:build` still compiles.
- [ ] **Step 2:** Write a failing test for `AppleIapConfig`: `isConfigured()` is false when the env vars are unset; true + the parsed values when all set (feed a fake `ConfigService`). `environment` defaults to `Sandbox` when unset.
- [ ] **Step 3:** Implement `apple-iap.config.ts` (mirror the `StripeNodeBillingClient` constructor env reads + the APN `.p8` path-or-contents handling). Run test → PASS.
- [ ] **Step 4:** Add the documented `TARMOTO_APPLE_IAP_*` block to `.env.example`.
- [ ] **Step 5:** Commit `feat(backend): add app-store-server-library dep + Apple IAP config`.

---

## Task 2: AppleBillingClient — verify transaction + subscription status

**Files:** create `apps/backend/src/modules/account/apple-billing.client.ts` (+ `.spec.ts`), `apps/backend/test/fixtures/apple/*`.

**Interfaces — Produces:**

```ts
export const APPLE_BILLING_CLIENT = Symbol("APPLE_BILLING_CLIENT");
export interface VerifiedAppleTransaction {
  originalTransactionId: string;
  transactionId: string;
  productId: string;
  appAccountToken: string | null; // the rider-linking UUID
  expiresDate: Date | null;
  isTrial: boolean; // offerType/intro-offer indicates a trial
  bundleId: string;
  environment: "Sandbox" | "Production";
}
export interface AppleBillingClient {
  isConfigured(): boolean;
  /** Verify a StoreKit2 signed JWSTransaction: signature + x5c chain to Apple root + bundleId + environment. Throws on any verification failure (terminal). */
  verifyTransaction(jwsTransaction: string): Promise<VerifiedAppleTransaction>;
  /** App Store Server API: current status for the subscription. Throws a retryable error on a store outage. */
  getSubscriptionStatus(originalTransactionId: string): Promise<{
    status: "active" | "trialing" | "past_due" | "canceled" | "expired";
    expiresDate: Date | null;
    autoRenew: boolean;
  }>;
}
```

Impl `AppleStoreKitBillingClient` uses `app-store-server-library`'s `SignedDataVerifier` (constructed with the Apple root certs, `environment`, `bundleId`, and the app apple id if required) to verify + decode `jwsTransaction`, mapping the decoded payload → `VerifiedAppleTransaction` (derive `isTrial` from the decoded `offerType`/`type`). `getSubscriptionStatus` uses `AppStoreServerAPIClient` (issuer/key/`.p8`/bundle) `getAllSubscriptionStatuses(originalTransactionId)` and maps Apple's status codes → the union. `isConfigured()` false → methods throw `ServiceUnavailableException` (mirror `requireStripe`).

- [ ] **Step 1:** Confirm the exact `app-store-server-library` API by reading its installed `.d.ts` (class names, `SignedDataVerifier` ctor args, the decoded transaction fields, `AppStoreServerAPIClient` methods, `Environment` enum). Note the real names in the report if they differ from this plan.
- [ ] **Step 2:** Add a fixture: a decoded-transaction sample + (if feasible) a self-signed JWS + a fake root so `SignedDataVerifier` can be exercised; OR mock `SignedDataVerifier` at the module boundary (inject it / wrap it behind a small seam) so the client's mapping logic is unit-tested without real Apple certs. Choose the cleaner seam and note it.
- [ ] **Step 3:** Write failing tests: `verifyTransaction` maps a verified payload → `VerifiedAppleTransaction` (incl. `isTrial` true for an intro-offer payload); a verification failure throws (terminal); a `bundleId`/environment mismatch throws; `getSubscriptionStatus` maps Apple status → the union; `isConfigured()` false → both methods throw `ServiceUnavailableException`.
- [ ] **Step 4:** Implement the client. Run tests → PASS; `pnpm backend:build`.
- [ ] **Step 5:** Commit `feat(backend): add AppleBillingClient (verify transaction + subscription status)`.

---

## Task 3: ProviderClaimService — claimForApple + clearAppleTerminal

**Files:** modify `apps/backend/src/modules/account/provider-claim.service.ts` (+ `.spec.ts`).

**Interfaces — Produces:**

```ts
async claimForApple(
  userId: string,
  originalTransactionId: string,
  fields: { tier: SubscriptionTier; status: 'active'|'trialing'|'past_due'|'canceled'; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean },
): Promise<'claimed' | 'conflict'>;
async clearAppleTerminal(userId: string, originalTransactionId: string): Promise<boolean>;
```

`claimForApple`: a single guarded `UPDATE users SET subscription_provider='apple', apple_original_transaction_id=:otid, subscription_tier=:tier, subscription_status=:status, subscription_current_period_end=:end, subscription_cancel_at_period_end=:cape, plan_source='subscription', updated_at=NOW() WHERE id=:id AND (subscription_provider IS NULL OR subscription_provider='apple') AND (apple_original_transaction_id IS NULL OR apple_original_transaction_id=:otid)` → `'claimed'` iff `affected===1`, else `'conflict'`. `clearAppleTerminal`: identity-guarded clear (`WHERE id AND subscription_provider='apple' AND apple_original_transaction_id=:otid`) → returns whether a row changed. Mirror `claimForStripe`/`clearStripeTerminal` exactly (same `createQueryBuilder().update(User)...andWhere(...)`, `(result.affected ?? 0) > 0`, `updated_at` handled by `@UpdateDateColumn`).

- [ ] **Step 1:** Failing tests: `claimForApple` returns `'conflict'` when `affected===0` and `'claimed'` when `1`; the WHERE includes the apple ownership + identity guards (assert the `andWhere` params); `clearAppleTerminal` returns false when the stored otid differs (identity guard).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (mirror the Stripe methods). Run → PASS; `pnpm backend:build`.
- [ ] **Step 4:** Commit `feat(backend): add provider-claim apple slot claim + terminal clear`.

---

## Task 4: iap/validate DTOs

**Files:** create `apps/backend/src/modules/account/dto/iap-validate.dto.ts`.

**Interfaces — Produces:** `IapValidateRequestDto { provider: 'apple' /* google later */; transaction: string /* the JWS */; productId?: string /* hint only, never trusted */ }` (class-validator: `@IsIn(['apple'])` for P1a, `@IsString()` transaction). `IapValidateResponseDto` = the `SubscriptionSnapshotResponseDto` shape PLUS `retryable: boolean` and `provider: SubscriptionProvider` (`@ApiProperty`, required-nullable where applicable). Reuse `SubscriptionSnapshotResponseDto`'s nested DTOs (compose, don't duplicate).

- [ ] **Step 1:** Write the DTOs with `@ApiProperty`/validators, composing the existing snapshot DTO.
- [ ] **Step 2:** `pnpm backend:build` compiles; `pnpm openapi:gen` and commit the regenerated `schema.d.ts` (the new endpoint's request/response types appear).
- [ ] **Step 3:** Commit `feat(backend): add iap/validate request+response DTOs`.

---

## Task 5: Apple validate flow (IapValidateService) + endpoint + wiring

**Files:** create `apps/backend/src/modules/account/iap-validate.service.ts` (+ `.spec.ts`); modify `account.controller.ts`, `account.module.ts`.

**Interfaces — Consumes:** `AppleBillingClient`, `ProviderClaimService.claimForApple`, `StoreReconciliationService.openConflict`, `@InjectRepository(User)`, `AccountService.buildSubscriptionSnapshot`/`getSubscription` (to return the snapshot shape).
**Behaviour — `validate(userId, dto): Promise<IapValidateResponseDto>` (Apple path), in this ORDER (spec §validate):**

1. `verifyTransaction(dto.transaction)` — on a verification failure throw a TERMINAL 400/422 (`retryable:false`); on a store-API/network error from a later re-query throw a RETRYABLE 5xx (`retryable:true`).
2. **Account binding FIRST:** reject 409 when `verified.appAccountToken !== userId`, or when `apple_original_transaction_id` is already owned by another rider (unique-index conflict → 409). No mutation on a binding failure.
3. **Derive tier** from `verified.productId` via `IAP_PRODUCTS` (apple trial/noTrial → tier); reject 400 on an unknown product; reject when `dto.productId` hint disagrees with the verified one.
4. **Trial:** if `verified.isTrial` and `user.billing_trial_used_at != null` (ineligible) → reject + `storeReconciliation.openConflict({ provider:'apple', appleOriginalTransactionId, reason:'ineligible_trial_rejected', userId })` (terminal). On a genuine first trial, include `billing_trial_used_at = NOW()` in the claim/update.
5. **Atomic claim:** `claimForApple(userId, originalTransactionId, { tier, status, currentPeriodEnd: expiresDate, cancelAtPeriodEnd:false })`; on `'conflict'` (a DIFFERENT provider owns the slot, OR a different apple otid) → 409 (exclusivity). Idempotent: a re-validate of the same otid that is already the owner returns the current snapshot (no-op).
6. Return the snapshot (`getSubscription(userId)` — store path, `liveSnapshot=null`) as `IapValidateResponseDto` with `retryable:false`, `provider:'apple'`.
   Controller: `@Post('subscription/iap/validate') @UseGuards(AuthGuard) @ApiBearerAuth()` → `iapValidateService.validate(req.user.userId, dto)`. Register the service + `AppleBillingClient` (`{ provide: APPLE_BILLING_CLIENT, useExisting: AppleStoreKitBillingClient }`) in `account.module.ts` providers/exports.

- [ ] **Step 1:** Failing tests (mock `AppleBillingClient` + `ProviderClaimService` + `StoreReconciliationService` + the user repo): (a) `appAccountToken !== userId` → 409, no claim; (b) unknown product → 400; (c) ineligible trial → reject + `ineligible_trial_rejected` reconciliation opened; (d) exclusivity conflict (`claimForApple`→'conflict') → 409; (e) happy path → `claimForApple` called with the derived tier + status, snapshot returned with `provider:'apple'`, `retryable:false`; (f) idempotent re-validate of the owning otid → snapshot, no double-claim; (g) a store re-query outage → retryable 5xx / `retryable:true`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `IapValidateService`, the controller route, and the module wiring. Run the focused spec + the full `apps/backend/src/modules/account` suite → PASS; `pnpm openapi:gen` (commit `schema.d.ts`); `pnpm backend:build`; eslint.
- [ ] **Step 4:** Commit `feat(backend): Apple iap/validate flow (binding-first, tier-derive, claim, trial)`.

---

## Task 6: Docs + reference

**Files:** modify `docs/reference/feature-flags.md` (or a new `docs/reference/iap.md`) — note the Apple validate path is live (server-enforced), the `TARMOTO_APPLE_IAP_*` ops-enablement, and that ASSN v2 webhook + lifecycle is P1b. Update any subscription/billing doc that enumerates providers.

- [ ] **Step 1:** Write the doc note (validate endpoint, verification via `app-store-server-library`, binding via `appAccountToken`=user id, exclusivity, trial, the terminal-vs-retryable contract, ops-enablement env vars, P1b scope).
- [ ] **Step 2:** Commit `docs(backend): document the Apple iap/validate path + ops enablement`.

---

## Self-Review

**Spec coverage (P1a):** `AppleBillingClient` verify (signature + x5c + bundle/env) + App Store Server API status (T2 ✓); `iap/validate` Apple path with binding-first, tier-from-verified-product, atomic exclusivity claim, trial handling + `ineligible_trial_rejected` reconciliation, idempotency, terminal-vs-retryable (T4/T5 ✓); apple slot claim/terminal (T3 ✓); config/env/dep (T1 ✓); docs (T6 ✓). **Deferred to P1b (by design):** the ASSN v2 webhook endpoint + `decodeNotification`, the full subscription lifecycle (renew/grace/hold/recover/renewal-pref/renewal-status/expired/refund/revoke/reactivation), the inbox lease/dead-letter/redelivery _processing_, and the `store_billing_emails` ledger. **Ops-enablement remains:** real `TARMOTO_APPLE_IAP_*` credentials + App Store Connect products + Apple sandbox E2E (the code is buildable + unit-testable against fixtures/mocks now, ships dark until configured).

**Type consistency:** `APPLE_BILLING_CLIENT`/`AppleBillingClient`/`VerifiedAppleTransaction` identical across T2 (def) and T5 (use); `claimForApple`/`clearAppleTerminal` identical T3 (def) → T5 (use); `IapValidateRequestDto`/`IapValidateResponseDto` identical T4 (def) → T5 (use).

**Open assumptions to confirm during execution (raise if wrong):**

1. The exact `app-store-server-library` API surface (class + method names, the decoded-transaction field names, how the Apple root certs are supplied) — confirm against the installed `.d.ts` in T2 Step 1; adjust the client if it differs.
2. `appAccountToken == users.id` as the binding scheme (the mobile client must set it so) — if the spec/mobile intends a separate mapping table, raise it (P1a assumes the direct user-id scheme).
3. Whether to fold `AppleIapConfig` into the client or keep it separate — implementer's call; keep it minimal.
