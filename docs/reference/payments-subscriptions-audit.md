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
  Real-Time Developer Notifications**; deletion-grace cancellation is
  **provider-specific**, not universally reversible: only **Stripe** is
  server-reversible (clear `cancel_at_period_end` while the sub stays live);
  **Google** needs the rider to re-enable renewal / re-subscribe, and **Apple**
  has no server-cancel API and requires re-subscription after cancellation (spec
  lines ~101–106).
- Tiers `free` / `pro` (€29.99/yr) / `premium` (€49.99/yr), EUR-canonical
  (ADR-0003).

## Built vs. intended

| Capability                                                                                                            | Intended                | Actual state                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stripe (web)** — Checkout / Portal / webhook / entitlement gating                                                   | ✅                      | ✅ **end-to-end usable** (`account.service.ts`, `stripe-billing.client.ts`, companion `settings/subscription/page.tsx`); two hardening gaps — status→entitlement (any non-entitling raw status, e.g. `incomplete`/`incomplete_expired`/`unpaid`) and event ordering (finding 5)                                                                                                          |
| **Backend Apple `iap/validate`**                                                                                      | ✅                      | ✅ built + hardened (`iap-validate.service.ts`; P0 #1120, P1a #1121, #1123) — one internal design-spec contradiction to reconcile (advisory `productId`; see finding 4)                                                                                                                                                                                                                  |
| **Cross-provider exclusivity + once-per-rider trial**                                                                 | ✅                      | ✅ built for **Stripe↔Apple** (`provider-claim.service.ts`, `store-reconciliation.service.ts`); Google is schema/scaffolding only — `claimForStripe`/`claimForApple` exist but there is no Google claim, and `IapValidateRequestDto` rejects `google`, so no Google activation runs the exclusivity / once-per-rider-trial guard                                                         |
| **Cross-provider mutation serialization**                                                                             | (implied)               | ✅ built, heavily: Redis per-rider lock + durable Postgres fence tokens + OTID lock + `pg_advisory_xact_lock`'d bounded claim tx + generation-versioned notification queue + 2 monotonic triggers (`subscription-mutation-lock.service.ts`, migrations 1826–1829)                                                                                                                        |
| **Mobile purchase client** — StoreKit/Play Billing → `validate` → entitlement refresh, restore purchases, paywall→buy | ✅ **core deliverable** | ❌ **absent** — no IAP SDK in `apps/mobile/package.json` (no `react-native-iap`/`expo-in-app-purchases`/RevenueCat/StoreKit); nothing calls `iap/validate`; `UpgradePrompt` renders a **disabled "Coming soon"** seam (`onUpgrade` unwired)                                                                                                                                              |
| **Google Play** — client + `GoogleBillingClient` + RTDN                                                               | ✅ (Android)            | ⚠️ **foundation built, purchase path unbuilt** — shared product catalog (`constants.ts` `IAP_PRODUCTS.*.google`), Google-capable inbox/reconciliation schema (migration 1822, `google_purchase_token` + unique index), and companion Play-store management/deletion surfaces exist; the **purchase client, `GoogleBillingClient`, token validation, and RTDN handler are unimplemented** |
| **Apple ASSN v2 lifecycle** — renew/grace/cancel/refund/revoke/reactivate                                             | ✅                      | ❌ **server-driven lifecycle deferred (P1b)** — a revalidating client can recover state via `iap/validate` (finding 4); only server-push-while-client-idle is absent                                                                                                                                                                                                                     |
| **Mobile entitlement _consumption_** — gating, `useFeature`/`useLimit`, `UpgradePrompt`                               | ✅                      | ✅ built (#1086)                                                                                                                                                                                                                                                                                                                                                                         |

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

Google is **designed and partly scaffolded, but the purchase path isn't built.**
The mobile-IAP spec specifies the Play work in detail — Play Developer API token
validation (`purchases.subscriptionsv2.get`), separate verify/acknowledge with
acknowledgement-recovery, and RTDN lifecycle handling — and assigns it to phases
**P2/P3** (spec lines ~63–85, 167–168). A real **foundation already exists**: the
shared product catalog (`IAP_PRODUCTS.*.google`), the Google-capable inbox +
reconciliation schema (migration 1822, `google_purchase_token` + unique index),
and companion Play-store management/deletion surfaces. **Unimplemented** are the
purchase client, `GoogleBillingClient`, token validation, and the RTDN handler. So
this is unstarted purchase implementation on top of a planned, partly-built
foundation — the de-scope option below means consciously dropping that (and
accounting for the existing scaffold's migration/removal cost), not skipping
something no one designed. Android riders have no path today.

### 4. "Validate" alone is not a subscription system (Apple lifecycle)

Apple lifecycle (ASSN v2) is deferred, so **server-driven** updates (a
cancel/refund/expiry/recovery that happens while the app is closed) are unhandled.
`billing_retry` is an **Apple-specific** state (`apple-billing.client.ts` — Apple
keeps retrying a failed payment after grace): it drops the tier to `free` while
retaining the provider, and it renders the contradictory "Free + Payment issue"
badge in the companion (tier `free` + status `past_due`).

Client revalidation is a useful **secondary** recovery path but **not a
substitute** for ASSN: the already-built `iap/validate` re-queries Apple and
reclaims the retained OTID / restores an entitling state, so a StoreKit
transaction listener or Restore Purchases _can_ recover a rider — **but only when
the client actually revalidates.** If a refund/revoke/expiry happens while the
rider leaves the mobile app closed and keeps using the companion or backend APIs,
no revalidation occurs and the server serves the persisted paid tier
**indefinitely**. So ASSN is **required** for server-authoritative lifecycle (the
approved design mandates it); a client-only implementation is not a complete
subscription system. A usable Apple subscription needs the **ASSN lifecycle
webhook**, with client revalidation as a complementary recovery path — not
first-purchase validation alone. (This gap is Apple's, not Stripe's — see
finding 5.)

**One `productId` contract inconsistency to reconcile.** The `iap/validate`
endpoint is marked "built + hardened" above, but the client-reported `productId`
rule is **internally contradictory in the design spec itself**, so calling the
implementation right or wrong picks one side of a self-inconsistent source of
truth. The spec both **allows** the hint (`2026-07-30-mobile-iap-subscriptions-design.md:72`
— "any client `productId` is a hint only — never trusted for entitlement") **and**
requires rejecting a mismatch (spec:75 and spec:155 — "reject when a client
`productId` hint disagrees with the verified one"). `IapValidateService` treats
the hint as **advisory only** — a mismatch is logged and ignored, never a rejection
cause (`iap-validate.service.ts:665-680`) — which matches spec:72 and
`docs/reference/iap.md:63-68` but contradicts spec:75/155. The granted tier comes
solely from the store-verified product, so the advisory behaviour is defensible (a
stale client hint should not reject an otherwise-valid transaction). The action is
to **reconcile all three spec clauses** (72, 75, 155) to one rule — recommend
settling on advisory, since spec:72, the implementation, and `iap.md` already
agree, and edit spec:75/155 to match. Until the spec is made self-consistent,
"validate complete" hides an unresolved
internal design-spec contradiction.

### 5. The Stripe web path is the most complete — but has two real gaps

Companion riders can subscribe, upgrade, manage, and cancel through Stripe, and the
common flow is self-healing: a successful retry redelivers
`customer.subscription.updated`, which `handleWebhook` processes to restore
`active`. But "complete" was too strong — two real gaps remain on the live path:

**(a) Status → entitlement.** Feature resolution reads **only
`subscription_tier`** (`feature-resolver.service.ts`), and `claimForStripe`
persists `tier: tierFromPrice(price)` with **no status-eligibility guard** of its
own. Meanwhile `statusFromSubscription` folds Stripe's non-entitling states into
entitling-looking ones: `incomplete` (initial payment never succeeded) → `canceled`
but the paid tier is still persisted; `unpaid` (retries exhausted) → `past_due`,
which retains the paid tier; and `incomplete_expired` falls through the same
default→`canceled` branch. So a rider can hold Pro/Premium features **without an
entitling payment**. The fix belongs in **Stripe ingestion**, and must be defined
as an **allowlist of ENTITLING statuses** (`active`, `trialing`, and `past_due`
during a genuine grace window) that drops the paid tier for **every other**
Stripe status — not an enumerated blocklist of `incomplete`/`unpaid`. Naming only
those two would still grant on `incomplete_expired` (and could even drop access on
`incomplete` then re-grant when it expires). Note the remedy is _not_ "gate the
resolver on status": founder/promo/admin
grants intentionally carry a paid `subscription_tier` with `subscription_status =
canceled` (`settings/subscription/page.tsx:266–281`), so a status gate would revoke
them; and `statusFromSubscription` collapses `unpaid` and `past_due` to one stored
status, so status alone can't even distinguish them. If a resolver check is wanted,
scope it to **billed provenance** (`plan_source = 'subscription'`), not status.

**(b) Event ordering.** `handleWebhook` applies
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
- **Commit to Android or de-scope `google`** — but account for the existing
  foundation (shared catalog, inbox/reconciliation schema, companion Play-store
  surfaces), so a de-scope is a conscious migration/removal, not a no-op.
- **The `billing_retry` badge + server-driven recovery are Apple lifecycle work,
  not Stripe** — handled by the (required) ASSN v2 handler, with client
  revalidation as a secondary path (or by RevenueCat if chosen).
- **Fix the two live Stripe-path bugs** (finding 5), independent of the mobile
  decision: (a) persist the paid tier only for an **allowlist of entitling Stripe
  statuses** (`active`/`trialing`/grace `past_due`) and drop it for every other
  status (`incomplete`, `incomplete_expired`, `unpaid`, …), not a two-status
  blocklist; (b) apply a **live subscription re-query** on same-subscription writes so
  out-of-order delivery can't resurrect/regress state (`event.created` is
  second-granularity and insufficient). Both small, both on the one live path.
- **Sequence capability before correctness-hardening**: for the next payment work,
  get one provider _end-to-end_ (purchase → entitlement → lifecycle) before
  hardening its edges.

## Suggested next steps (issues to open)

- **Mobile purchase client** (blocked on the strategy decision above) — the core gap.
- **Google Play IAP** — build or explicitly de-scope.
- **Apple ASSN v2 lifecycle (P1b)** — the full transition set from spec:84, not
  just renew/expire/refund: `SUBSCRIBED` (resubscribe/reactivate → re-validate +
  re-claim), `DID_RENEW`, `DID_FAIL_TO_RENEW` (→ `past_due`, tier held only during
  a real grace window), `DID_RECOVER` (→ `active`), `GRACE_PERIOD_EXPIRED` (drop
  tier to `free` but **retain** the provider — recovery still possible for ~60d),
  `DID_CHANGE_RENEWAL_PREF` (in-group Pro↔Premium — **apply upgrades immediately,
  defer downgrades to the next `DID_RENEW`**; tier from the re-queried verified
  product, never the event), `DID_CHANGE_RENEWAL_STATUS` (**handle both subtypes** —
  OFF → keep tier + `cancel_at_period_end = true`; ON → re-query + **clear**
  `cancel_at_period_end` so a re-enabled rider isn't left marked as canceling),
  `EXPIRED`/`REFUND`/`REVOKE` (terminal). Plus the `billing_retry` recovery +
  "Free + Payment issue" badge (both Apple-specific) — or fold into RevenueCat if
  chosen.
- **Stripe status→entitlement hardening** — persist the paid tier only for an
  **allowlist of entitling raw Stripe statuses** (`active`, `trialing`, and
  `past_due` during a genuine grace window) and drop it for **every other** status
  (`incomplete`, `incomplete_expired`, `unpaid`, …) — not a two-item blocklist,
  which still re-grants on `incomplete_expired`. Fix in Stripe ingestion, not by a
  resolver status gate (which would revoke founder/promo/admin grants); finding 5a.
  A live web-path bug today.
- **Stripe event-ordering hardening** — live subscription re-query applied on
  same-subscription writes (not `event.created`, which is second-granularity;
  finding 5b); applies on the live web path
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
