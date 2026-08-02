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
| **Stripe (web)** — Checkout / Portal / webhook / entitlement gating                                                   | ✅                      | ✅ **end-to-end usable** (`account.service.ts`, `stripe-billing.client.ts`, companion `settings/subscription/page.tsx`); state coverage complete — one event-ordering hardening item (finding 5)                                                                  |
| **Backend Apple `iap/validate`**                                                                                      | ✅                      | ✅ built + hardened (`iap-validate.service.ts`; P0 #1120, P1a #1121, #1123)                                                                                                                                                                                       |
| **Cross-provider exclusivity + once-per-rider trial**                                                                 | ✅                      | ✅ built (`provider-claim.service.ts`, `store-reconciliation.service.ts`)                                                                                                                                                                                         |
| **Cross-provider mutation serialization**                                                                             | (implied)               | ✅ built, heavily: Redis per-rider lock + durable Postgres fence tokens + OTID lock + `pg_advisory_xact_lock`'d bounded claim tx + generation-versioned notification queue + 2 monotonic triggers (`subscription-mutation-lock.service.ts`, migrations 1826–1829) |
| **Mobile purchase client** — StoreKit/Play Billing → `validate` → entitlement refresh, restore purchases, paywall→buy | ✅ **core deliverable** | ❌ **absent** — no IAP SDK in `apps/mobile/package.json` (no `react-native-iap`/`expo-in-app-purchases`/RevenueCat/StoreKit); nothing calls `iap/validate`; `UpgradePrompt` renders a **disabled "Coming soon"** seam (`onUpgrade` unwired)                       |
| **Google Play** — client + `GoogleBillingClient` + RTDN                                                               | ✅ (Android)            | ❌ **vocabulary only** — the `"google"` provider, a `google_purchase_token` column, and "once wired" comments exist; **no code**                                                                                                                                  |
| **Apple ASSN v2 lifecycle** — renew/grace/cancel/refund/revoke/reactivate                                             | ✅                      | ❌ **server-driven lifecycle deferred (P1b)** — a revalidating client can recover state via `iap/validate` (finding 4); only server-push-while-client-idle is absent                                                                                              |
| **Mobile entitlement _consumption_** — gating, `useFeature`/`useLimit`, `UpgradePrompt`                               | ✅                      | ✅ built (#1086)                                                                                                                                                                                                                                                  |

## Findings

### 1. The mobile subscribe path does not exist

A rider cannot buy anything on mobile. The Apple-validate endpoint — hardened over
dozens of review rounds — has **no caller**: there is no native IAP SDK, no
purchase → `validate` → entitlement-refresh loop, and no restore-purchases. The
mobile `UpgradePrompt` (`apps/mobile/src/components/entitlements/UpgradePrompt`,
used e.g. `RideDetailScreen.tsx:84`) is honest about this — with no `onUpgrade`
wired it renders a **disabled "Coming soon"** CTA (an intentional IAP seam for a
future PR), not a dead-end. Net: the backend IAP investment currently delivers
**zero end-user value**.

### 2. Hardening ran ahead of capability (proportionality)

A good chunk of the serialization is genuinely needed _now_, even web-only —
because all of it is currently driven by the **Stripe** path
(`AccountService.handleSubscriptionUpdated`):

- **Per-rider lock + fence** — Stripe redelivers/retries
  `customer.subscription.updated` and a rider can open two Checkout sessions, so
  concurrent same-rider Stripe deliveries are real; the handler already runs every
  event through `subscriptionLock.runExclusive` (the lock's own doc names "two
  webhooks" as a supported case). Justified.
- **The generation-versioned notification queue** (+ the `subscription_notify_generation`
  column/trigger, migrations 1828–1829) — every `enqueueSubscriptionNotification`
  call is in the Stripe handler; it defers the ~10s email send out of the webhook
  (Stripe's ~20s timeout) and drops a stale cancellation-after-reactivation
  (a **Stripe** ABA the spec test covers). Also a live web-path safeguard.

What was **premature** is only the _cross-provider / Apple-specific_ tail layered
on top: the OTID lock, the Apple-`validate`-vs-Stripe-webhook trial-marker race,
and the `pg_advisory_xact_lock`'d bounded claim tx for the cross-rider
**same-OTID** case — these defend races that require the Apple/mobile path and real
cross-provider concurrency, i.e. the mobile client that doesn't exist and users who
aren't here yet. The code is _correct_, but a large share of the ~32 review rounds
went into that cross-provider tail (and its deep edge cases) before the core
capability existed. This is not a call to rip anything out (it's built, tested,
ships dark) — it's a call to **keep the Stripe-path baseline (lock, fence,
notification queue), and stop adding speculative cross-provider concurrency rounds
until there is a workload to justify them.**

### 3. Android (Google Play) is planned but unimplemented

Google is **designed, not built.** The mobile-IAP spec specifies the Play work in
detail — Play Developer API token validation (`purchases.subscriptionsv2.get`),
separate verify/acknowledge with acknowledgement-recovery, and RTDN lifecycle
handling — and assigns it to phases **P2/P3** (spec lines ~63–85, 167–168). In
code it's only vocabulary (`"google"` provider, `google_purchase_token` column,
"once wired" comments). So this is unstarted _implementation_ of a planned scope,
not an absent plan — the de-scope option below means consciously dropping planned
work, not skipping something no one designed. Android riders have no path today.

### 4. "Validate" alone is not a subscription system (Apple lifecycle)

Apple lifecycle (ASSN v2) is deferred, so **server-driven** updates (a
cancel/refund/expiry/recovery that happens while the app is closed) are unhandled.
`billing_retry` is an **Apple-specific** state (`apple-billing.client.ts` — Apple
keeps retrying a failed payment after grace): it drops the tier to `free` while
retaining the provider, and it renders the contradictory "Free + Payment issue"
badge in the companion (tier `free` + status `past_due`).

Recovery is **not exclusively** ASSN, though: the already-built `iap/validate`
re-queries Apple's authoritative status and reclaims the retained OTID / restores
an entitling state, so a **client revalidation** (the planned StoreKit transaction
listener or Restore Purchases) also recovers a rider after `billing_retry`/expiry.
ASSN is needed for the server-driven case when the client does _not_ revalidate;
it is not the only recovery path. Either way both require the (missing) mobile
client — so today there is no recovery in practice. A usable Apple subscription
needs **either** the lifecycle webhook **or** a revalidating client, not just
first-purchase validation. (This gap is Apple's, not Stripe's — see finding 5.)

### 5. The Stripe web path is the most complete — one ordering gap remains

Companion riders can subscribe, upgrade, manage, and cancel through Stripe, and the
**state coverage** is complete + self-healing for normal delivery:
`AccountService.statusFromSubscription` normalizes Stripe statuses to
`active`/`trialing`/`past_due`/`canceled` (there is no `billing_retry` on Stripe),
and a successful Stripe retry redelivers `customer.subscription.updated`, which
`handleWebhook` already processes to restore `active`.

The one real gap is **event ordering**: `handleWebhook` applies
`event.data.object` directly with **no version guard and no API re-query**, and
the fence only enforces lock-_acquisition_ order, not Stripe _event_ order. Stripe does not guarantee delivery order, so a delayed stale
`customer.subscription.updated: active` arriving _after_ a `deleted` can reclaim
the now-empty slot and resurrect a canceled subscription, and a delayed `past_due`
can regress a newer recovery. So this is the path to build on, but it warrants an
**ordering / re-query hardening follow-up** — **re-fetch the live subscription
from the Stripe API** and apply that (not the event snapshot) on same-subscription
writes. (Note `event.created` is only second-granularity — same-second events
collide, so it can't order them; the re-query is the reliable fix.) — plus the
cosmetic snapshot-display
polish.

## Recommendation — decide the mobile IAP strategy before building more

The pivotal fork is _how_ to do mobile IAP, because it determines how much of the
deferred custom backend (ASSN v2 + RTDN webhooks, the notification inbox/outbox,
reconciliation, and the lock machinery) you actually need:

1. **RevenueCat (or equivalent managed IAP).** Fastest cross-platform iOS+Android
   purchase + receipt/lifecycle handling. It **subsumes the genuinely DEFERRED
   work**: the Apple ASSN v2 + Google RTDN lifecycle webhooks and the notification
   inbox/outbox processing (P1b), plus the **unbuilt** Google Play validation
   (P2/P3). It would **replace or migrate** the _already-built_ P1a Apple
   `iap/validate` (JWS verification + authoritative status lookup) rather than
   eliminate deferred work — so that P1a validation is a migration cost under this
   option, not a saving. Best fit given no users yet and the goal of not
   over-building. Trade-offs: a third-party dependency + fee; reconciling RC's
   webhook/entitlement model with the existing feature-flag resolver; and retiring
   or migrating the built P1a Apple path.
2. **Native `react-native-iap` + the custom backend.** Matches the current spec
   exactly; most work; you still owe `GoogleBillingClient`, ASSN v2, RTDN, and the
   inbox/outbox/reconciliation lifecycle.
3. **Web-only Stripe for now.** Ship the one complete path; **formally de-scope**
   mobile IAP until it's a priority, and stop carrying `google`/`apple` surfaces
   as if imminent.

Regardless of the choice:

- **Keep the Stripe-path baseline** — the per-rider lock/fence AND the
  generation-versioned notification queue (both drive the live web path; don't
  churn them) — but **stop adding speculative cross-provider concurrency rounds**
  until a real workload exists.
- **Commit to Android or de-scope `google`** rather than carrying half-vocabulary.
- **The `billing_retry` badge + recovery are Apple lifecycle work, not Stripe** —
  they're handled by the deferred ASSN v2 handler and/or a revalidating client (or
  by RevenueCat if chosen). The Stripe web lifecycle _state coverage_ is complete.
- **Harden Stripe event ordering** — **re-fetch the live subscription from the
  Stripe API** and apply that on same-subscription writes, so out-of-order
  delivery can't resurrect a canceled sub or regress a recovery (finding 5).
  (`event.created` is second-granularity and can't order same-second events, so
  it's not a sufficient guard.) Small, worth doing on the one live path.
- **Sequence capability before correctness-hardening**: for the next payment work,
  get one provider _end-to-end_ (purchase → entitlement → lifecycle) before
  hardening its edges.

## Suggested next steps (issues to open)

- **Mobile purchase client** (blocked on the strategy decision above) — the core gap.
- **Google Play IAP** — build or explicitly de-scope.
- **Apple ASSN v2 lifecycle (P1b)** — renew/grace/cancel/refund/revoke **and** the
  `billing_retry` recovery + "Free + Payment issue" badge (both Apple-specific) —
  or fold into RevenueCat if chosen.
- **Stripe event-ordering hardening** — live subscription re-query applied on
  same-subscription writes (not `event.created`, which is second-granularity;
  finding 5); applies on the live web path
  today, independent of the mobile decision.

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
