# Mobile In-App Purchase Subscriptions — Design

**Date:** 2026-07-30
**Status:** Approved (design); pending implementation plan
**Related:** #1104 (paid-tier enforcement, blocked on billing), #1115 (finish Stripe billing), the feature-flag entitlement system (`packages/shared/src/feature-flags.ts`)

## Goal

Let riders subscribe to the `pro` (€29.99/yr) and `premium` (€49.99/yr) tiers from the mobile app via **Apple StoreKit** and **Google Play Billing**, feeding the **same** `users.subscription_tier` the Stripe web flow already drives — so the existing feature-flag entitlement resolver is unchanged. One active subscription per rider at a time (across Stripe / Apple / Google), with a 14-day intro trial granted once per rider.

## Decisions (locked)

- **Platforms:** iOS **and** Android, designed together, delivered in phases.
- **Trial:** mirror the web flow — a **14-day intro free trial**, granted **once per rider**, gated by `users.billing_trial_used_at` across _all_ sources (web + both stores).
- **Cross-platform:** **one active subscription at a time.** A store purchase is blocked while a Stripe subscription is active, and vice-versa. The tier comes from the single active source.
- **Data model:** **Approach A — extend `users`** (denormalized), not a separate `subscriptions` table. Correct under the single-active constraint and needs no `feature-resolver` change.
- **Validation:** server-side only. Apple = StoreKit 2 signed transactions + App Store Server API + App Store Server Notifications v2. Google = Play Developer API token validation + Real-Time Developer Notifications. The client never grants a tier.

## Architecture

### Data model (migration on `users`)

New nullable columns:

- `subscription_provider` `varchar(16)` — `stripe | apple | google`, `null` when free. The discriminator for who owns the active subscription.
- `apple_original_transaction_id` `varchar(255)` — Apple's stable per-subscription key; used to find the rider from an ASSN v2 notification.
- `google_purchase_token` `varchar(1024)` — Google's purchase token; used to find the rider from an RTDN and to re-query the Play Developer API.

**A store subscription belongs to exactly one rider.** Both store-id columns get a **UNIQUE partial index** (`WHERE <col> IS NOT NULL`) so the same transaction/token can never be claimed by two accounts (which would duplicate the entitlement and make notification lookup ambiguous). Purchases are additionally **bound to the account at purchase time** via the stores' account-linking identifiers — Apple `appAccountToken` (a UUID the client sets to a value the backend maps to the rider) and Google `obfuscatedExternalAccountId` — so mere possession of a valid transaction/token can't reassign a subscription to a different signed-in account: `iap/validate` rejects (409) a store payload whose account-linking id doesn't map to the authenticated rider, and rejects a store id already owned by another rider.

Backfill: `subscription_provider = 'stripe'` where `stripe_subscription_id IS NOT NULL`, else `NULL`.

`feature-resolver` is **unchanged** — it reads `user.subscription_tier`; all three sources converge on that field plus `subscription_status`, `subscription_current_period_end`, `subscription_cancel_at_period_end`.

### Shared (`@tarmoto/shared`)

- `SUBSCRIPTION_PROVIDERS = ['stripe','apple','google'] as const` + `SubscriptionProvider` type.
- `IAP_PRODUCTS`: the tier ↔ store-product map, single-sourced so mobile and backend agree. **Because StoreKit auto-applies whichever introductory offer is configured on an Apple product — the client can't opt a given Apple product out of its trial — each tier maps to TWO Apple products, one with the intro trial and one without.** Google expresses this with one product + a trial base-plan/offer and a no-trial base-plan. So:
  `{ pro: { apple: { trial: 'com.tarmoto.pro.annual.trial', noTrial: 'com.tarmoto.pro.annual' }, google: { productId: 'pro_annual', trialOffer: '…', noTrialBasePlan: '…' } }, premium: {…} }`.
  Both Apple products (and both Google base-plans) map to the same tier server-side, so tier derivation is unaffected; the _offer selection_ is what trial-eligibility drives.
- Request/response DTO types for the validate endpoint.

### Backend (`apps/backend/src/modules/account`, or a new `billing/iap` submodule)

**`AppleBillingClient`**

- Verify a StoreKit 2 signed `JWSTransaction` against Apple's public keys (x5c chain → Apple root).
- Query the App Store Server API (`GET /inApps/v1/subscriptions/{originalTransactionId}`) with an ES256 JWT (issuer id + key id + `.p8`).
- Decode + verify ASSN v2 notification payloads (signed JWS).
- Env: `TARMOTO_APPLE_IAP_ISSUER_ID`, `TARMOTO_APPLE_IAP_KEY_ID`, `TARMOTO_APPLE_IAP_PRIVATE_KEY` (`.p8`), `TARMOTO_APPLE_IAP_BUNDLE_ID`, `TARMOTO_APPLE_IAP_ENVIRONMENT` (sandbox|production).

**`GoogleBillingClient`**

- Validate a purchase token via the Play Developer API (`purchases.subscriptionsv2.get`) with a service-account JWT.
- Decode RTDN messages (Pub/Sub push envelope → `SubscriptionNotification`).
- Acknowledge the purchase server-side if not auto-acked.
- Env: `TARMOTO_GOOGLE_IAP_SERVICE_ACCOUNT_JSON` (or path), `TARMOTO_GOOGLE_IAP_PACKAGE_NAME`, `TARMOTO_GOOGLE_IAP_PUBSUB_VERIFICATION_TOKEN`.

**Endpoints**

- `POST /account/subscription/iap/validate` — authed. Body `{ provider: 'apple'|'google', transaction | purchaseToken }`. (Any client `productId` is a hint only — never trusted for entitlement.)
  1. Verify with the store client (signature + server API).
  2. **Derive the tier from the VERIFIED payload's product / base-plan id** (returned by Apple/Google), mapped through `IAP_PRODUCTS` — never from a client-supplied field. Reject an unknown product; reject when a client `productId` hint disagrees with the verified one (a client claiming Premium for a verified Pro purchase must fail, not escalate).
  3. **Account binding:** reject (409) when the verified payload's account-linking id (Apple `appAccountToken` / Google `obfuscatedExternalAccountId`) doesn't map to the authenticated rider, or when the store id is already owned by another rider (unique-index conflict → 409).
  4. **Exclusivity (atomic claim):** claim the provider slot atomically (see below); 409 if another provider is already active.
  5. Set `subscription_tier/status/current_period_end/cancel_at_period_end`, `subscription_provider`, and the store id column — all from the verified payload. Also set `plan_source = 'subscription'` (matching the Stripe handler) so a launch-granted `founder` who now pays through a store is no longer labelled a founder in the admin UI.
  6. **Trial:** honour a trial only when the rider is backend-eligible (`billing_trial_used_at IS NULL`). Since `billing_trial_used_at` can't control a store's offer, the client queries backend eligibility _before_ purchase and buys the **no-trial Apple product / no-trial Google base-plan** (see `IAP_PRODUCTS`) for ineligible riders; if a trial transaction still arrives for an ineligible rider the backend **rejects and reconciles it** (no second trial). On a genuine first trial, stamp `billing_trial_used_at`.
  7. Return the same subscription snapshot shape as `GET /account/subscription`.
     Idempotent on the store transaction id (a re-validate of the same transaction is a no-op that returns the current snapshot).
- `POST /account/subscription/iap/apple/notifications` — ASSN v2. No user auth; verified by JWS signature. Find the rider by `apple_original_transaction_id` → sync tier/status/period_end for the full lifecycle: `DID_RENEW`, `DID_FAIL_TO_RENEW` (→ `past_due`/grace, tier held), `DID_RECOVER` (billing-retry success → `active`, since a recovery does NOT always emit `DID_RENEW`), `EXPIRED`, `GRACE_PERIOD_EXPIRED`, `DID_CHANGE_RENEWAL_STATUS`, `REFUND`, `REVOKE`. A terminal transition (`EXPIRED`/`REVOKE`/`REFUND`, no active sub left) drops the tier to `free` and **clears `subscription_provider`, the store id, and `plan_source`**.
- `POST /account/subscription/iap/google/notifications` — RTDN via authenticated Pub/Sub push. Find the rider by `google_purchase_token` → re-query the Play Developer API → sync the equivalent lifecycle (`SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_IN_GRACE_PERIOD`, `SUBSCRIPTION_RECOVERED`, `SUBSCRIPTION_ON_HOLD`, `SUBSCRIPTION_EXPIRED`, `SUBSCRIPTION_REVOKED`, `SUBSCRIPTION_CANCELED`), with the same terminal clear.
- `GET /account/subscription` extended: add `provider`, `managed_by` (`stripe_portal | app_store | play_store`), and trial-eligibility. **The snapshot must be gated by `subscription_provider`, not merely annotated:** `getSubscription`/`buildSubscriptionSnapshot` today load live Stripe whenever `stripe_customer_id` exists and prefer that plan — for a store subscriber (who may still have an old canceled Stripe customer) that returns a stale Stripe tier/status/payment-method/invoices. So query + overlay Stripe billing ONLY when `subscription_provider === 'stripe'`; for a store provider build the snapshot from the stored `subscription_*` fields (no Stripe read), and omit Stripe-only fields (payment method, invoices) or source them from the store where available.

**Exclusivity enforcement (atomic provider claim, every activation path)**

Blocking only the two synchronous entry points is insufficient: a Stripe Checkout session created earlier can complete _after_ a store purchase, and an expired store subscription can be reactivated from store settings _after_ Stripe becomes active — those webhook/notification paths would then silently overwrite the shared fields while both providers keep billing. So exclusivity is an **atomic provider claim** applied on **every** activation:

- Model the claim as a conditional write: a provider may set the active-subscription fields only when `subscription_provider IS NULL` or already equals that provider (a single guarded `UPDATE … WHERE subscription_provider IS NULL OR subscription_provider = :provider`, run inside the request/notification transaction, is the claim).
- **Entry points:** `createCheckoutSession` (Stripe) 403s when a store provider is active/trialing/past_due (reusing the "Existing subscriptions must be changed in the billing portal" guard, store-specific copy); `iap/validate` 409s when Stripe (or the other store) is active.
- **Async paths:** the Stripe webhook and both store notification handlers run the same guarded claim. On a **conflict** (another provider already owns the slot), they do NOT overwrite — they log a reconciliation event for support and, where the API allows, cancel the losing/duplicate subscription (Stripe: cancel the subscription; stores: cancellation is the rider's, so flag it) so the rider isn't double-billed silently.

**Account deletion**

- Store subscriptions **cannot** be server-cancelled (the store owns cancellation), and after the hard purge even the store-token association needed for follow-up notifications is gone. Surfacing guidance only "on purge" is too late — the current flow soft-deletes immediately and hard-purges 30 days later while the store keeps charging.
- Therefore the **deletion request** path (`DELETE /account`) detects a store-managed subscription and returns that fact; the **confirmation UI + email** must prominently instruct the rider to cancel in the App Store / Play Store **before** the account becomes inaccessible (ideally requiring an explicit acknowledgement for a store-managed sub). Stripe's server-cancellable path is unchanged.

### Mobile (`apps/mobile`, `react-native-iap`)

- **`services/iap.ts`** — connect on demand; fetch products (localized store prices); purchase; transaction/purchase listener; **finish (iOS) / acknowledge (Android) only after** the backend validate succeeds; restore purchases; teardown.
- **Paywall sheet** — pro/premium with store-localized prices + trial copy + purchase/restore. Reads product metadata from `react-native-iap`.
- Wire the ~10 `UpgradePrompt` `onUpgrade` call sites (MapScreen, RideDetailScreen, TripsScreen, GroupRideScreen, TripCreateScreen, OfflineRegionsScreen, CommuteScreen, TripDetailScreen, SettingsScreen) → open the paywall.
- Purchase flow: buy → `POST /account/subscription/iap/validate` → refresh `/users/me` entitlements → finish/acknowledge the transaction. On backend failure, branch on the error kind rather than a blanket "don't finish": a **retryable** outage (5xx / network) leaves the transaction unfinished so the store re-delivers and a later validate succeeds; a **terminal** rejection (wrong `appAccountToken`, unknown product, ineligible-trial, exclusivity conflict) can never validate — the backend records/reconciles the verified purchase, the client **finishes** it (so it doesn't re-surface the same error on every launch), and the rider is directed to the applicable refund/cancel flow. The validate endpoint returns a machine-readable `retryable: boolean` (or a stable error code) to drive this.
- **Restore purchases** in Settings → re-validate the current entitlement.
- **Status display** — show the plan + a "Manage in App Store / Play Store" deep link (store subs are managed in the store, not in-app).
- **Trial eligibility:** before purchase, fetch backend trial-eligibility (a field on `GET /account/subscription`, or a lightweight endpoint) and pick the trial vs no-trial store offer accordingly (see the validate `Trial` step).

### Companion (`apps/companion`) — must handle store-managed subscriptions

The extended snapshot (`provider` / `managed_by`) is not cosmetic: today `settings/subscription/page.tsx` routes every active paid-plan change and cancellation through the Stripe portal (`openPortal`), and `normalizeSubscriptionSnapshot` ignores the new fields — so a **store subscriber visiting the web app** would hit disabled controls or be sent to the wrong (Stripe) portal.

- `normalizeSubscriptionSnapshot` reads `provider` / `managed_by`.
- For a store-managed subscription, replace the Stripe-portal "manage/cancel/change" actions with a clear "Manage your subscription in the App Store / Play Store" panel (store subs can't be changed from the web); keep the plan/status/renewal display.
- The companion contract types + tests updated alongside this snapshot change (this is part of the same phase, not a mobile-only concern).

## Data flows

- **Purchase:** mobile buy → store → transaction → mobile → `iap/validate` → backend verifies with store API → sets tier → snapshot → mobile refreshes entitlements + finishes transaction.
- **Renewal / cancel / refund / grace:** store → ASSN v2 / RTDN → backend notification handler → re-query store → sync tier/status/period_end. Tier held through grace/billing-retry, dropped on expiry.
- **Restore:** mobile restore → `iap/validate` with the restored transaction → same as purchase.
- **Exclusivity:** a purchase attempt while another source is active → backend 403 → client shows "manage your existing subscription first."

## Error handling & correctness

- Server validation is the only source of a grant; the client is never trusted.
- Idempotent `validate` (transaction-id dedupe) + notification dedupe (Apple `notificationUUID` / Google message id).
- Deferred/pending Google purchases handled (no grant until the token resolves to a purchased state).
- Signature/verification failures reject; a store-API outage during `validate` returns a retryable 5xx (the client can re-validate; the store re-delivers).

## Testing strategy

- **Backend unit:** `AppleBillingClient`/`GoogleBillingClient` verify + notification-decode against captured fixtures (mock the store HTTP); `iap/validate` — **tier derived from the verified product (a mismatched client `productId` is rejected, not escalated)**, **account binding** (wrong `appAccountToken`/`obfuscatedExternalAccountId` → 409; store id owned by another rider → 409), **atomic-claim exclusivity conflicts** on validate AND on webhook/notification paths (late Stripe completion / store reactivation don't overwrite an active provider), **trial** stamping + rejection for backend-ineligible riders, idempotency; notification handlers (renew→active, expire→free, refund→revoke).
- **Companion unit:** `normalizeSubscriptionSnapshot` honours `provider`/`managed_by`; a store-managed snapshot renders the "manage in store" panel instead of Stripe-portal controls.
- **Backend deletion:** `DELETE /account` flags a store-managed subscription so the confirmation surface can warn before soft-delete.
- **Mobile unit:** `services/iap.ts` with `react-native-iap` mocked — buy→validate→refresh→finish, do-not-finish-on-backend-failure, restore, exclusivity error surfacing, trial-vs-no-trial offer selection by eligibility. Paywall render + CTA wiring.
- **Sandbox E2E (manual/ops):** App Store sandbox + Play internal testing full purchase/renew/cancel loops.

## Delivery phases (epic — multiple PRs)

- **P0** — shared `SubscriptionProvider` + `IAP_PRODUCTS` + validate DTOs; `users` migration (provider + store id columns **with UNIQUE partial indexes**, backfill); the **atomic provider-claim** helper + applying it to the existing Stripe webhook/checkout; `GET /account/subscription` snapshot extended with `provider`/`managed_by` + trial-eligibility; **companion** normalization + store-managed "manage in store" panel + tests; the `DELETE /account` store-managed detection + confirmation-UI/email cancellation warning.
- **P1** — Apple: `AppleBillingClient` (verify + derive tier from verified product + `appAccountToken` binding), `iap/validate` (Apple path), ASSN v2 webhook with the atomic claim + conflict reconciliation, Stripe/Apple exclusivity, trial-eligibility offer selection, tests.
- **P2** — Google: `GoogleBillingClient` (`obfuscatedExternalAccountId` binding), `iap/validate` (Google path), RTDN webhook with the atomic claim, exclusivity across all three, tests.
- **P3** — mobile: `services/iap.ts`, paywall (trial vs no-trial offer by eligibility), wire `UpgradePrompt` CTAs, restore, status display, tests.
- **P4** — ops config + sandbox E2E verification.

Each phase is independently shippable behind the store config being absent (endpoints 503 until env is set, exactly like Stripe today).

**Every phase that changes an HTTP contract regenerates the OpenAPI artifacts in the same PR** (`pnpm openapi:gen` → committed `packages/openapi/openapi.yaml` + `packages/openapi-client/src/generated/schema.d.ts`), so generated consumers see `provider`/`managed_by`/trial-eligibility and the new `iap/validate` + notification routes: P0 (snapshot fields), P1/P2 (new endpoints). Postman regen where a new endpoint lands.

## Ops prerequisites (account owner)

- **App Store Connect:** **4** auto-renewable subscriptions — a trial and a no-trial product **per tier** (pro/premium annual, €29.99/€49.99), because StoreKit auto-applies a product's configured intro offer and can't be told to skip it; the 14-day intro free trial is configured only on the two `*.trial` products. Plus ASSN v2 URL, App Store Server API key (issuer id + key id + `.p8`), bundle id.
- **Google Play Console:** 2 subscription products (pro/premium annual) each with a **14-day free-trial base-plan/offer AND a no-trial base-plan**, a Pub/Sub topic for RTDN, a service account with Play Developer API access, package name.
- Set the `TARMOTO_APPLE_IAP_*` / `TARMOTO_GOOGLE_IAP_*` env vars in the backend deploy.

## Risks / open items

- **Price parity:** store prices are set per-store in local currency; keep them aligned to the €29.99/€49.99 intent (stores don't take an arbitrary amount — pick the closest store price tier). Displayed price comes from the store, not our config.
- **Store review:** the paywall must follow each store's subscription-disclosure rules (price, period, trial terms, restore button, links to terms/privacy).
- **`react-native-iap` native setup:** bare RN 0.85 — pods (iOS) + Play Billing lib (Android); a native dependency addition.
- **Refund/chargeback:** handled via notifications → revoke tier; no separate flow.
