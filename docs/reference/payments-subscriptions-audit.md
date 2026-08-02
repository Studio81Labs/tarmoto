# Payments & Subscriptions — Implementation Audit

> **Date:** 2026-08-02 · **Status:** point-in-time assessment · **Stage:** dev (no
> production, no real users) · **Author:** engineering audit
>
> Scope: is the payment/subscription stack implemented "the right way" across the
> companion (web) and mobile apps, per the design docs? This is an assessment, not
> a change — it ends with a decision to make and recommended next steps.

## Bottom line

The **web (Stripe) path is the only end-to-end usable subscription flow.** The
**mobile purchase flow — the entire reason native in-app purchase exists — is not
built**, yet the backend Apple-validate machinery behind it was hardened to an
extreme degree (~26 review rounds in P1a, then ~32 rounds in the #1123
mutation-serialization follow-up). Hardening the backend to maximal concurrency
correctness _in front of a missing core capability_, on an app with zero users,
is a scope/sequencing inversion — the "went out of scope, took a lot of rounds"
signal that prompted this audit.

## Intended architecture (the yardstick)

From `docs/superpowers/specs/2026-07-30-mobile-iap-subscriptions-design.md` and
`docs/reference/iap.md`:

- **Web → Stripe** (Checkout + Customer Portal + `customer.subscription.*`
  webhook). **Mobile → Apple StoreKit 2 + Google Play Billing**, iOS **and**
  Android, "designed together, delivered in phases."
- A client purchase is verified **server-side only** (`POST
/account/subscription/iap/validate`); the client never grants a tier. The
  result feeds the single shared `users.subscription_tier`, so the existing
  feature-flag entitlement resolver (`packages/shared/src/feature-flags.ts`) is
  unchanged.
- **One active subscription per rider across `stripe`/`apple`/`google`**
  (`SUBSCRIPTION_PROVIDERS`, `constants.ts:238`); a 14-day intro trial granted
  **once per rider** (`users.billing_trial_used_at`).
- Lifecycle via **Apple App Store Server Notifications v2** and **Google
  Real-Time Developer Notifications**; **reversible** cancellation during the
  account-deletion grace window.
- Tiers `free` / `pro` (€29.99/yr) / `premium` (€49.99/yr), EUR-canonical
  (ADR-0003).

## Built vs. intended

| Capability                                                                                                            | Intended                | Actual state                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stripe (web)** — Checkout / Portal / webhook / entitlement gating                                                   | ✅                      | ✅ **complete, end-to-end usable** (`account.service.ts`, `stripe-billing.client.ts`, companion `settings/subscription/page.tsx`)                                                                                                                                 |
| **Backend Apple `iap/validate`**                                                                                      | ✅                      | ✅ built + hardened (`iap-validate.service.ts`; P0 #1120, P1a #1121, #1123)                                                                                                                                                                                       |
| **Cross-provider exclusivity + once-per-rider trial**                                                                 | ✅                      | ✅ built (`provider-claim.service.ts`, `store-reconciliation.service.ts`)                                                                                                                                                                                         |
| **Cross-provider mutation serialization**                                                                             | (implied)               | ✅ built, heavily: Redis per-rider lock + durable Postgres fence tokens + OTID lock + `pg_advisory_xact_lock`'d bounded claim tx + generation-versioned notification queue + 2 monotonic triggers (`subscription-mutation-lock.service.ts`, migrations 1826–1829) |
| **Mobile purchase client** — StoreKit/Play Billing → `validate` → entitlement refresh, restore purchases, paywall→buy | ✅ **core deliverable** | ❌ **absent** — no IAP SDK in `apps/mobile/package.json` (no `react-native-iap`/`expo-in-app-purchases`/RevenueCat/StoreKit); nothing calls `iap/validate`; `UpgradePrompt` is a CTA that dead-ends                                                               |
| **Google Play** — client + `GoogleBillingClient` + RTDN                                                               | ✅ (Android)            | ❌ **vocabulary only** — the `"google"` provider, a `google_purchase_token` column, and "once wired" comments exist; **no code**                                                                                                                                  |
| **Apple ASSN v2 lifecycle** — renew/grace/cancel/refund/revoke/reactivate                                             | ✅                      | ❌ **deferred (P1b)** — so even Apple, with a client, would have no lifecycle                                                                                                                                                                                     |
| **Mobile entitlement _consumption_** — gating, `useFeature`/`useLimit`, `UpgradePrompt`                               | ✅                      | ✅ built (#1086)                                                                                                                                                                                                                                                  |

## Findings

### 1. The mobile subscribe path does not exist

A rider cannot buy anything on mobile. The Apple-validate endpoint — hardened over
dozens of review rounds — has **no caller**: there is no native IAP SDK, no
purchase → `validate` → entitlement-refresh loop, and no restore-purchases. The
mobile `UpgradePrompt` (`apps/mobile/src/components/entitlements/UpgradePrompt`,
used e.g. `RideDetailScreen.tsx:84`) surfaces a CTA but leads to no purchase. Net:
the backend IAP investment currently delivers **zero end-user value**.

### 2. Hardening ran ahead of capability (proportionality)

The 32-round mutation-serialization work defends against races — a concurrent
Stripe webhook and an Apple `validate` both consuming the trial marker, ABA
transitions, TTL-lease-loss stragglers — that **cannot occur** until real users
purchase across providers, which requires the mobile client that doesn't exist.
The code is _correct_, but it was **premature**: for the current reality
(Stripe-only, web-only, no concurrent cross-provider mutations) the minimal
correct version is far simpler. The 32 rounds were the tell. This is not a call to
rip it out (it's built, tested, ships dark) — it's a call to **stop adding
speculative concurrency rounds until there is a workload to justify them.**

### 3. Android (Google Play) is unstarted

Despite the spec designing iOS+Android together, Google is half-vocabulary. Android
riders have no path, and the `"google"` provider surface reads as "coming" without
a plan behind it.

### 4. "Validate" alone is not a subscription system

Apple lifecycle (ASSN v2) is deferred, so even if a client existed a rider who
cancels/refunds keeps their tier and a billing-retry never recovers. A usable
Apple subscription needs the lifecycle webhook, not just first-purchase validation.

### 5. The Stripe web path is genuinely complete — and is the asset to build on

Companion riders can subscribe, upgrade, manage, and cancel through Stripe. Known
polish item: the `billing_retry` state renders a contradictory "Free + Payment
issue" badge (flagged in earlier reviews) and there is no auto-recovery without
the (deferred) lifecycle webhook.

## Recommendation — decide the mobile IAP strategy before building more

The pivotal fork is _how_ to do mobile IAP, because it determines how much of the
deferred custom backend (ASSN v2 + RTDN webhooks, the notification inbox/outbox,
reconciliation, and the lock machinery) you actually need:

1. **RevenueCat (or equivalent managed IAP).** Fastest cross-platform iOS+Android
   purchase + receipt/lifecycle handling; **subsumes much of the deferred P1b
   backend** (webhooks, renewal/refund/grace lifecycle, receipt validation). Best
   fit given no users yet and the goal of not over-building. Trade-off: a
   third-party dependency + fee, and reconciling its webhook/entitlement model
   with the existing feature-flag resolver.
2. **Native `react-native-iap` + the custom backend.** Matches the current spec
   exactly; most work; you still owe `GoogleBillingClient`, ASSN v2, RTDN, and the
   inbox/outbox/reconciliation lifecycle.
3. **Web-only Stripe for now.** Ship the one complete path; **formally de-scope**
   mobile IAP until it's a priority, and stop carrying `google`/`apple` surfaces
   as if imminent.

Regardless of the choice:

- **Keep the built lock/fence hardening** (dark + tested — don't churn it), but
  **stop adding speculative concurrency rounds** until a real workload exists.
- **Commit to Android or de-scope `google`** rather than carrying half-vocabulary.
- **Finish the Stripe web lifecycle** (fix the `billing_retry` badge; decide how
  past-due recovery works without the webhook).
- **Sequence capability before correctness-hardening**: for the next payment work,
  get one provider _end-to-end_ (purchase → entitlement → lifecycle) before
  hardening its edges.

## Suggested next steps (issues to open)

- **Mobile purchase client** (blocked on the strategy decision above) — the core gap.
- **Google Play IAP** — build or explicitly de-scope.
- **Apple ASSN v2 lifecycle (P1b)** — or fold into RevenueCat if chosen.
- **Stripe web lifecycle polish** — `billing_retry` badge + past-due recovery.

## Appendix — key source references

- Design spec: `docs/superpowers/specs/2026-07-30-mobile-iap-subscriptions-design.md`
- Backend Apple validate: `apps/backend/src/modules/account/iap-validate.service.ts`
- Exclusivity/claim: `apps/backend/src/modules/account/provider-claim.service.ts`
- Mutation-serialization stack: `apps/backend/src/modules/account/subscription-mutation-lock.service.ts` (+ migrations 1826–1829)
- Stripe (backend): `apps/backend/src/modules/account/account.service.ts`, `stripe-billing.client.ts`
- Stripe (companion): `apps/companion/src/app/(dashboard)/settings/subscription/page.tsx`
- Entitlement registry: `packages/shared/src/feature-flags.ts`, `constants.ts:238` (`SUBSCRIPTION_PROVIDERS`)
- Mobile entitlement consumption: `apps/mobile/src/hooks/useEntitlements.ts`, `apps/mobile/src/lib/entitlements.ts`
- Reference: `docs/reference/iap.md`, `docs/reference/feature-flags.md`, ADR `docs/decisions/0003-subscription-pricing-currency.md`
