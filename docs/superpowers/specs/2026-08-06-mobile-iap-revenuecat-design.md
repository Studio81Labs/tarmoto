# Mobile IAP via RevenueCat — narrowed scope

> **Date:** 2026-08-06 · **Status:** approved design · **Stage:** dev (no
> production, no real users)
>
> Supersedes the mobile-IAP delivery strategy in
> `docs/superpowers/specs/2026-07-30-mobile-iap-subscriptions-design.md`. That
> spec's _domain_ rules (cross-provider exclusivity, once-per-rider trial,
> server-side verification, tier resolution) still hold. What changes is **how**
> store purchases and lifecycle reach the backend.
>
> Driven by `docs/reference/payments-subscriptions-audit.md` (2026-08-02).

## Why this exists

The audit found the mobile purchase client — the entire reason native IAP was
built — absent, while the backend Apple-validate path behind it was hardened over
~58 review rounds. Hardening ran ahead of capability.

Mobile IAP cannot be de-scoped: Apple App Store Review Guideline 3.1.1 and Google
Play's Payments policy both require in-app purchase for digital subscriptions
consumed in the app, so routing riders to Stripe Checkout from the mobile app is
not a shippable option. The question was never _whether_ to do mobile IAP, only
_how_.

## Decision

**Adopt RevenueCat (`react-native-purchases`) for Apple and Google. Keep the web
companion on direct Stripe.**

Rationale, in order of weight:

1. **Android is the deciding cost.** Tarmoto ships a bare React Native app with a
   real `android/` target. Under the native path Android is an entire unbuilt
   phase carrying the most intricate contract in the audit — `GoogleBillingClient`,
   Play Developer API validation, the acknowledgement-durability contract, pending
   purchase binding, the full RTDN state matrix, and replay-safe Play mutations.
   Under RevenueCat it is largely store configuration.
2. **Zero users makes switching free today, and it never gets cheaper.** There is
   no billing continuity problem and no migration of live subscribers.
3. **The audit's lesson argues against re-committing to native.** The native path
   is precisely what inverted scope. Choosing it again re-commits to the largest
   remaining surface with unchanged team capacity.
4. **The sunk asset is the smaller half.** ~6,200 lines of Apple first-purchase
   validation exist; the half the audit calls mandatory for a complete system
   (ASSN v2 lifecycle) is unbuilt — and RevenueCat subsumes it for _both_ stores.

Explicitly **not** adopted: migrating the Stripe web path into RevenueCat. Stripe
is the one flow that already works end-to-end. RevenueCat covers Apple and Google
only.

### What RevenueCat does not remove

Access resolves from `users.subscription_tier`, so a purchase known only to
RevenueCat leaves backend and companion entitlements stale. RevenueCat replaces
**provider ingestion**, not Tarmoto's correctness envelope. The webhook consumer
in §4 is a required deliverable of this design, not an optional extra.

## 1. Architecture — RevenueCat is an ingestion channel, not a provider

The load-bearing decision. RevenueCat webhooks carry `store: APP_STORE |
PLAY_STORE` plus the underlying store identifiers, so RevenueCat maps onto the
**existing** domain model instead of becoming a fourth provider:

| Concern                     | Treatment                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUBSCRIPTION_PROVIDERS`    | unchanged — `['stripe','apple','google']`                                                                                                                                  |
| Store identity              | unchanged — `apple_original_transaction_id` / `google_purchase_token` (migration 1822, both already uniquely indexed)                                                      |
| `SUBSCRIPTION_MANAGED_BY`   | unchanged — `app_store` / `play_store`                                                                                                                                     |
| Companion subscription page | **unchanged** — the store panels already render from `managed_by`                                                                                                          |
| Notification inbox          | unchanged — `processed_store_notifications.provider` is already `'apple' \| 'google'`, and the composite `UNIQUE (provider, notification_id)` gives RevenueCat event dedup |
| Reconciliation              | unchanged — `store_billing_reconciliations`                                                                                                                                |

**Consequence: no migration, no shared-contract change, no companion change.**
This is what makes the option cheap, and it is the reason to prefer mapping over
introducing a `revenuecat` provider value.

### Retired by this decision

The native Apple ingestion path becomes dead weight (§6):
`iap-validate.service.ts`, `apple-billing.client.ts`, `apple-iap.config.ts`,
`dto/iap-validate.dto.ts` and their specs.

Retiring `iap/validate` also resolves audit **finding 4** (the advisory-vs-reject
`productId` contract deviation) by removing the endpoint that deviates. No
separate product call is needed.

### Retained and reused

`ProviderClaimService`, `SubscriptionMutationLockService`,
`StoreReconciliationService`, `SubscriptionNotificationService`, the notification
inbox, the reconciliation table, migrations 1822–1829, and on mobile the whole of
`#1086` entitlement consumption plus `entitlementsRefresh` /
`entitlementsRefreshMonitor`. Roughly 4,200 backend lines that serve either
strategy.

## 2. Rider binding

`Purchases.logIn(<tarmoto user id>)` sets RevenueCat's `app_user_id` to the
Tarmoto user id at authentication time, and `Purchases.logOut()` on sign-out.

RevenueCat webhooks then carry `app_user_id` directly, so rider resolution is a
primary-key lookup. This removes the `appAccountToken` (iOS) /
`obfuscatedExternalAccountId` (Android) purchase-parameter injection and JWS
extraction that the native path required — and which today terminally 409s every
Apple purchase (`iap-validate.service.ts:305-315`).

**Anonymous-purchase guard.** The paywall is reachable only for an authenticated
rider, and the purchase call asserts a non-anonymous RevenueCat `app_user_id`
before invoking the store. A purchase made under an RC anonymous id cannot be
resolved to a rider by the webhook.

## 3. Backend: provider claim for Google

`ProviderClaimService` gains `claimForGoogle` and `clearGoogleTerminal`, mirroring
the existing Apple pair exactly: single guarded UPDATE, ownership predicate,
monotonic ordering key on `subscription_store_signed_date`, CAS baseline on the
observed row version, `subscription_lock_fence <= :token` guard, and
`markTrialUsed` folded into the same statement so the tier grant and the
once-per-rider trial stamp commit atomically.

`clearGoogleTerminal` retains `google_purchase_token` as a historical binding
(matching `clearAppleTerminal`'s retained-OTID behaviour) so a later reactivation
can still resolve the rider by token.

## 4. Backend: the RevenueCat webhook consumer

`POST /account/subscription/revenuecat/webhook`.

**Authentication.** A shared secret in the `Authorization` header, configured
RevenueCat-side, compared in constant time against
`TARMOTO_REVENUECAT_WEBHOOK_SECRET`. Verified **before** the envelope is parsed or
persisted. A missing or wrong secret is a 401 with no inbox write.

**Processing order:**

1. **Persist `pending` before any side effect.** Insert into
   `processed_store_notifications` keyed `(provider, notification_id)` where
   `provider` is derived from the event's `store` and `notification_id` is
   RevenueCat's event `id`. A duplicate delivery hits the unique constraint and
   short-circuits as already-seen.
2. **Re-query authoritative state.** Call RevenueCat's subscriber API for the
   `app_user_id` and apply **that**, never the event body. This is the audit's
   overarching ordering rule: the event type is a trigger, not a state.
3. **Derive the ordering key.** The re-query's `request_date_ms` takes the role
   Apple's JWS `signedDate` played — written to `subscription_store_signed_date`
   and used as the ordering predicate of the guarded UPDATE, so a read that
   started earlier cannot overwrite a state a later read already committed.

   Note the semantic difference from `signedDate`, which must be respected: Apple's
   value versions the _state_, whereas `request_date_ms` versions the _read_. It
   orders concurrent consumers correctly (the whole purpose here) but carries no
   claim that RevenueCat's returned state is itself newer. Correctness therefore
   rests on step 2 always fetching authoritative state and step 4 applying it under
   the per-rider lock — not on the timestamp alone. Re-applying an unchanged state
   is idempotent, so a duplicate read is harmless.

4. **Apply under the per-rider lock.** `SubscriptionMutationLockService
.runExclusive(userId, …)`, calling `claimForApple` / `claimForGoogle` with the
   lease's `fenceToken`. Exclusivity, the fence, and the atomic trial stamp come
   for free.
5. **Terminal states** (expiry, refund, revoke, billing-issue exhaustion) route
   through `clearAppleTerminal` / `clearGoogleTerminal` — identity-guarded, never
   an unconditional clear.
6. **Lost claims are reconciled, not swallowed.** When the atomic claim loses —
   Stripe or another store already owns the slot — open a
   `store_billing_reconciliations` row rather than acknowledging a no-op. A
   proven-losing purchase that keeps billing with no entitlement is the failure
   this prevents.
7. **Complete the inbox row and NULL its payload** immediately on success.

**Failure handling** follows the existing inbox semantics: a transiently-blocked
valid event **retains** its payload and escalates to ops past the retry budget; only
a classified-permanent failure is redacted and alerted; leases allow crash
recovery.

**Stale-fence contention** (`claimFor*` affecting zero rows because the lease was
lost) is a retryable 503 / requeue, **not** an ordering no-op — the inbox row must
not complete without applying real state.

## 5. Mobile: the thin end-to-end vertical

The first deliverable proves `purchase → server-owned entitlement` and nothing
else. Applying the audit's sequencing lesson directly.

### In scope

- `react-native-purchases` (10.7.0, MIT, RN ≥ 0.73 — compatible with RN 0.86 and
  the New Architecture, which is enabled) + `Purchases.logIn` / `logOut` wired to
  the auth lifecycle.
- **Pro tier only.** Both platforms (iOS and Android), sandbox.
- A paywall screen showing **store-supplied** price and period. Displayed price
  comes from the store, never from the EUR-canonical config; the config remains
  the intent the store products are configured to match.
- **Exclusivity preflight before invoking the store.** Fetch `GET
/account/subscription` and disable purchase when `provider` is already occupied,
  directing the rider to the existing management surface. Without this a
  Stripe-holding rider can complete a store purchase the webhook then correctly
  refuses — and on Apple that is a recurring subscription Tarmoto cannot cancel
  server-side.
- **Purchase → wait for the server to reflect it.** RevenueCat's purchase
  completes before its webhook reaches Tarmoto, so the SDK callback fires while
  `/users/me` still returns `free`. The client polls an authenticated refresh until
  the server-owned entitlement reflects the purchase, then surfaces success. A
  single post-callback refresh would leave a charged rider locked out for the rest
  of the session.

  Bound it explicitly: exponential backoff from 1s, capped at 5s per attempt, for
  up to ~30s total. On exhaustion the rider sees a "purchase received, activating
  shortly" state — never a failure, since they have been charged — and
  `entitlementsRefreshMonitor` picks it up on the next foreground. These numbers
  are the design's starting point, tunable once real webhook latency is observed
  in sandbox.

- **Restore purchases.**
- **One** `UpgradePrompt` call site wired to open the paywall — `SettingsScreen`,
  as the least conditional entry point.

### Explicitly out of scope

Deferred to follow-up issues so the vertical stays thin:

- the other nine `UpgradePrompt` call sites (MapScreen, RideDetailScreen ×2,
  TripsScreen, GroupRideScreen ×3, TripCreateScreen, OfflineRegionsScreen,
  CommuteScreen, TripDetailScreen)
- the Premium tier
- trial eligibility (backend `billing_trial_used_at` combined with store-side
  eligibility) — the vertical sells the **no-trial** product only
- store-management deep links and `managed_by` display on mobile
- the full lifecycle transition matrix beyond initial purchase and expiry
- store-review paywall disclosures (trial terms, terms/privacy links)
- account-deletion store cancellation

Each is a real requirement; none is needed to prove the vertical.

## 6. Narrowing the native Apple path

Two steps, sequenced by risk.

**Step 1 — now.** Unmount `POST /account/subscription/iap/validate` from
`AccountController` (`account.controller.ts:142`) and drop its controller tests.
The endpoint is authenticated, reachable in every environment, and has zero
callers; it is a live surface with no purpose. One-line removal plus test updates.

**Step 2 — after the vertical passes sandbox on both stores.** Delete
`iap-validate.service.ts` (1,141) + spec (2,573), `apple-billing.client.ts` (779)

- spec (1,204), `apple-iap.config.ts` (153) + spec (310), `dto/iap-validate.dto.ts`
  (73), and unwire them from `AccountModule` — roughly 6,200 lines.

Migrations 1822–1825 are **not** reverted: their columns (`subscription_provider`,
`apple_original_transaction_id`, `google_purchase_token`,
`subscription_store_signed_date`, the reconciliation reason) are all still used by
the RevenueCat path.

Deleting before sandbox proof would repeat the mistake the audit flagged in the
opposite direction — discarding a working fallback ahead of evidence. Unmounting
first removes the liability; deletion removes the weight once it is safe.

## 7. Stripe finding 5 — separate, and first

Two live bugs on the only working path, unrelated to mobile. They land as their own
PRs **ahead** of this work so neither diff hides the other:

- **5a — status → entitlement.** Persist the paid tier only for an **allowlist** of
  entitling raw Stripe statuses (`active`, `trialing`, and `past_due` during a
  genuine grace window), dropping it for every other status. Not a blocklist: naming
  only `incomplete`/`unpaid` still grants on `incomplete_expired`. Fix in Stripe
  ingestion, **not** by a resolver status gate — founder/promo/admin grants
  intentionally carry a paid tier with `subscription_status = canceled` and a status
  gate would revoke them.
- **5b — event ordering.** Re-query the live subscription from the Stripe API on
  same-subscription writes and apply that, not the event snapshot (`event.created`
  is second-granularity and cannot order same-second events). A re-queried
  terminal-or-missing subscription must route through the identity-guarded
  `clearStripeTerminal`, **not** `claimForStripe` — `handleWebhook` derives
  `isDeleted` from the event type alone (`account.service.ts:394-402`), so a delayed
  `updated` otherwise leaves Stripe owning the slot and blocks a later store claim
  even after dropping the tier to `free`. Include a
  deleted-then-delayed-`updated` regression test.

## 8. Testing

**Backend.** Webhook authentication (missing / wrong secret → 401, no inbox write);
inbox dedup on redelivered event id; re-query-not-event-body; out-of-order delivery
(older `request_date_ms` cannot regress a newer committed state); cross-provider
claim conflict opens a reconciliation row; terminal clear is identity-guarded
against a stale old-subscription event; stale-fence contention requeues rather than
completing the inbox row; `claimForGoogle` / `clearGoogleTerminal` mirror the
existing Apple claim suite including the retained-token binding.

**Mobile.** Preflight disables purchase for an occupied provider slot;
purchase-then-delayed-webhook polls until the server reflects the entitlement and
does not report success early; poll exhaustion surfaces a recoverable state rather
than a silent failure; restore path; anonymous `app_user_id` blocks purchase.

**Sandbox E2E.** Purchase on **both** App Store sandbox and Play internal testing,
asserting the entitlement transition server-side at each leg. Renewal and
cancellation legs are part of the _lifecycle_ follow-up, not this vertical — the
vertical asserts purchase and expiry only.

## 9. Ops enablement (blocking the sandbox leg)

Not code, but the vertical cannot pass without it:

- RevenueCat project, both app configurations, and the Pro product/entitlement
  mapping
- App Store Connect app record + Pro annual product + a sandbox tester
- Play Console app + Pro annual subscription + internal testing track + licensed
  testers
- `TARMOTO_REVENUECAT_IOS_API_KEY` / `TARMOTO_REVENUECAT_ANDROID_API_KEY` — the
  platform-specific **public SDK keys**, shipped in the mobile bundle. Public by
  design; they are not secrets and must not be treated as such.
- `TARMOTO_REVENUECAT_WEBHOOK_SECRET` — backend only, a real secret.
- `TARMOTO_REVENUECAT_SECRET_API_KEY` — backend only, for the authoritative
  subscriber re-query in §4 step 2. A real secret; never shipped to a client.
- RevenueCat webhook URL pointed at the backend

## 10. Contract artifacts

The new webhook route changes the HTTP contract, so the PR that adds it runs
**both** `pnpm openapi:gen` **and** `pnpm postman:gen` and commits the tracked
generated artifacts — `packages/openapi-client/src/generated/schema.d.ts` plus the
tracked Postman collection. They are separate scripts; `openapi:gen` does not touch
Postman. `packages/openapi/openapi.yaml` is a gitignored intermediate and must not
be force-added.

## 11. Risks

| Risk                                               | Mitigation                                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RevenueCat is a third party in the payment path    | Entitlements remain resolved from Tarmoto's own `users.subscription_tier`; RevenueCat is ingestion only. A RevenueCat outage stops _new_ purchases reaching us; it does not revoke existing riders. |
| 1% of tracked revenue above $2,500 MTR             | Free at current stage. Revisit at scale; the domain model stays store-native, so a later move back to direct ingestion changes the consumer, not the schema.                                        |
| Deleting ~6,200 hardened lines                     | Deletion gated behind sandbox proof (§6, step 2). Fallback preserved until then.                                                                                                                    |
| Webhook delay leaves a charged rider on `free`     | Bounded polling in the client (§5) plus the reconciliation row on a lost claim.                                                                                                                     |
| Sandbox provisioning blocks both platforms at once | Ops items in §9 are tracked as their own delivery step, per the audit's P4 finding.                                                                                                                 |

## 12. Delivery sequence

Each numbered step is its own PR.

1. Stripe 5a — entitling-status allowlist
2. Stripe 5b — re-query + terminal routing
3. Unmount `iap/validate`
4. Backend: `claimForGoogle` / `clearGoogleTerminal`
5. Backend: RevenueCat webhook consumer + contract artifacts
6. Mobile: SDK, binding, paywall, preflight, purchase, poll-until-reflected,
   restore, one call site
7. Ops enablement + sandbox E2E on both stores
8. Delete the native Apple path

Steps 1–3 are independent of everything else and can land immediately. Step 6
depends only on the `GET /account/subscription` preflight contract, which already
exists — so once step 5's route shape is agreed, mobile (6) and backend (4, 5) can
proceed in parallel. Step 7 gates on 5 and 6 both being merged; step 8 gates on 7
passing.

## Appendix — source references

- Audit: `docs/reference/payments-subscriptions-audit.md`
- Superseded delivery strategy:
  `docs/superpowers/specs/2026-07-30-mobile-iap-subscriptions-design.md`
- Claim service: `apps/backend/src/modules/account/provider-claim.service.ts`
- Lock service:
  `apps/backend/src/modules/account/subscription-mutation-lock.service.ts`
- Inbox entity: `apps/backend/src/entities/processed-store-notification.entity.ts`
- Snapshot DTO:
  `apps/backend/src/modules/account/dto/subscription-response.dto.ts`
- Mobile entitlements: `apps/mobile/src/lib/entitlements.ts`,
  `apps/mobile/src/services/entitlementsRefresh.ts`
- Upgrade seam: `apps/mobile/src/components/entitlements/UpgradePrompt.tsx`
