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
- `apple_original_transaction_id` `varchar(255)` — Apple's stable per-subscription key; used to find the rider from an ASSN v2 notification. Indexed.
- `google_purchase_token` `varchar(1024)` — Google's purchase token; used to find the rider from an RTDN and to re-query the Play Developer API. Indexed.

Backfill: `subscription_provider = 'stripe'` where `stripe_subscription_id IS NOT NULL`, else `NULL`.

`feature-resolver` is **unchanged** — it reads `user.subscription_tier`; all three sources converge on that field plus `subscription_status`, `subscription_current_period_end`, `subscription_cancel_at_period_end`.

### Shared (`@tarmoto/shared`)

- `SUBSCRIPTION_PROVIDERS = ['stripe','apple','google'] as const` + `SubscriptionProvider` type.
- `IAP_PRODUCTS`: the tier ↔ store-product-id map, single-sourced so mobile and backend agree, e.g.
  `{ pro: { apple: 'com.tarmoto.pro.annual', google: 'pro_annual' }, premium: {...} }`.
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

- `POST /account/subscription/iap/validate` — authed. Body `{ provider: 'apple'|'google', productId, transaction | purchaseToken }`.
  1. Verify with the store client (signature + server API).
  2. **Exclusivity:** 403 if the rider has any _other_ active subscription (Stripe, or the other store).
  3. Map product → tier (`IAP_PRODUCTS`); reject an unknown product.
  4. Set `subscription_tier/status/current_period_end/cancel_at_period_end`, `subscription_provider`, and the store id column.
  5. If the store reports an intro/trial period and `billing_trial_used_at IS NULL`, stamp it (trial-abuse guard shared with web).
  6. Return the same subscription snapshot shape as `GET /account/subscription`.
     Idempotent on the store transaction id (a re-validate of the same transaction is a no-op that returns the current snapshot).
- `POST /account/subscription/iap/apple/notifications` — ASSN v2. No user auth; verified by JWS signature. Find the rider by `apple_original_transaction_id` → sync tier/status/period_end for `DID_RENEW`, `EXPIRED`, `DID_CHANGE_RENEWAL_STATUS`, `GRACE_PERIOD_EXPIRED`, `REFUND`, `REVOKE`.
- `POST /account/subscription/iap/google/notifications` — RTDN via authenticated Pub/Sub push. Find the rider by `google_purchase_token` → re-query the Play Developer API → sync.
- `GET /account/subscription` extended: add `provider` and a `managed_by` hint (`stripe_portal | app_store | play_store`) so clients show the right "manage" affordance.

**Exclusivity enforcement**

- `createCheckoutSession` (Stripe) 403s when `subscription_provider IN ('apple','google')` and status is active/trialing/past_due — reusing the existing "Existing subscriptions must be changed in the billing portal" guard shape, with store-specific copy.
- `iap/validate` 403s when `subscription_provider = 'stripe'` and active.

**Account deletion**

- Store subscriptions **cannot** be server-cancelled (the store owns cancellation). On purge, clear the local subscription fields but surface guidance that the rider must cancel in the App Store / Play Store to stop billing. Stripe cancellation path is unchanged.

### Mobile (`apps/mobile`, `react-native-iap`)

- **`services/iap.ts`** — connect on demand; fetch products (localized store prices); purchase; transaction/purchase listener; **finish (iOS) / acknowledge (Android) only after** the backend validate succeeds; restore purchases; teardown.
- **Paywall sheet** — pro/premium with store-localized prices + trial copy + purchase/restore. Reads product metadata from `react-native-iap`.
- Wire the ~10 `UpgradePrompt` `onUpgrade` call sites (MapScreen, RideDetailScreen, TripsScreen, GroupRideScreen, TripCreateScreen, OfflineRegionsScreen, CommuteScreen, TripDetailScreen, SettingsScreen) → open the paywall.
- Purchase flow: buy → `POST /account/subscription/iap/validate` → refresh `/users/me` entitlements → finish/acknowledge the transaction. On backend failure: do **not** finish (the store re-delivers so a safe retry validates later); surface an error.
- **Restore purchases** in Settings → re-validate the current entitlement.
- **Status display** — show the plan + a "Manage in App Store / Play Store" deep link (store subs are managed in the store, not in-app).

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

- **Backend unit:** `AppleBillingClient`/`GoogleBillingClient` verify + notification-decode against captured fixtures (mock the store HTTP); `iap/validate` (exclusivity 403s, product→tier, trial stamping, idempotency); notification handlers (renew→active, expire→free, refund→revoke). Reconciliation (provider discriminator, single-active).
- **Mobile unit:** `services/iap.ts` with `react-native-iap` mocked — buy→validate→refresh→finish, do-not-finish-on-backend-failure, restore, exclusivity error surfacing. Paywall render + CTA wiring.
- **Sandbox E2E (manual/ops):** App Store sandbox + Play internal testing full purchase/renew/cancel loops.

## Delivery phases (epic — multiple PRs)

- **P0** — shared `SubscriptionProvider` + `IAP_PRODUCTS` + validate DTOs; `users` migration (provider + store id columns, backfill); `GET /account/subscription` snapshot extended with `provider`/`managed_by`.
- **P1** — Apple: `AppleBillingClient`, `iap/validate` (Apple path), ASSN v2 webhook, Stripe/Apple exclusivity, tests.
- **P2** — Google: `GoogleBillingClient`, `iap/validate` (Google path), RTDN webhook, exclusivity across all three, tests.
- **P3** — mobile: `services/iap.ts`, paywall, wire `UpgradePrompt` CTAs, restore, status display, tests.
- **P4** — ops config + sandbox E2E verification.

Each phase is independently shippable behind the store config being absent (endpoints 503 until env is set, exactly like Stripe today).

## Ops prerequisites (account owner)

- **App Store Connect:** 2 auto-renewable subscriptions (pro/premium annual, €29.99/€49.99), a 14-day intro free-trial offer, ASSN v2 URL, App Store Server API key (issuer id + key id + `.p8`), bundle id.
- **Google Play Console:** 2 subscription products + base plans + 14-day free-trial offer, a Pub/Sub topic for RTDN, a service account with Play Developer API access, package name.
- Set the `TARMOTO_APPLE_IAP_*` / `TARMOTO_GOOGLE_IAP_*` env vars in the backend deploy.

## Risks / open items

- **Price parity:** store prices are set per-store in local currency; keep them aligned to the €29.99/€49.99 intent (stores don't take an arbitrary amount — pick the closest store price tier). Displayed price comes from the store, not our config.
- **Store review:** the paywall must follow each store's subscription-disclosure rules (price, period, trial terms, restore button, links to terms/privacy).
- **`react-native-iap` native setup:** bare RN 0.85 — pods (iOS) + Play Billing lib (Android); a native dependency addition.
- **Refund/chargeback:** handled via notifications → revoke tier; no separate flow.
