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
collide, so it can't order them; the re-query is the reliable fix.) **Re-querying
alone is not sufficient, though:** `handleWebhook` derives `isDeleted` **solely
from the event type** (`account.service.ts:394-402` — only
`customer.subscription.deleted` sets it), so a delayed `customer.subscription.updated`
still enters the non-deleted path and calls `claimForStripe`, which writes
`subscription_provider = 'stripe'` + the subscription id **even when the allowlist
drops the tier to `free`** — leaving a terminated subscription owning the slot and
blocking a later Apple/Google claim. So the follow-up must **route a re-queried
terminal-or-missing subscription through the identity-guarded terminal-clear path**
(clear `subscription_provider`/`plan_source`), not merely swap the snapshot. Add a
**deleted-then-delayed-`updated`** regression test. Plus the cosmetic
snapshot-display polish.

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
   or migrating the built P1a Apple path. **RevenueCat does not remove the need for
   a backend lifecycle consumer.** Access is resolved from `users.subscription_tier`,
   so a purchase/refund/expiry known only to RC leaves backend + companion
   entitlements stale unless a server-side consumer keeps that row fresh. Under this
   option you still owe an **authenticated RevenueCat webhook consumer** (or
   equivalent server-side reconciliation) that maps the RC customer → rider, updates
   `users.subscription_tier` while the client is idle, and **participates in the
   existing Stripe cross-provider claim / once-per-rider-trial guard** — RC replaces
   the provider-specific ASSN/RTDN _ingestion_, not this deliverable. It must be in
   the issue scope.
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
  second-granularity and insufficient) **and route a re-queried terminal-or-missing
  subscription through the identity-guarded `clearStripeTerminal` path** — re-query
  alone still enters `claimForStripe` (which keeps Stripe owning the slot and blocks
  a later Apple/Google claim) because `isDeleted` is derived from the event type.
  Both small, both on the one live path.
- **Sequence capability before correctness-hardening**: for the next payment work,
  get one provider _end-to-end_ (purchase → entitlement → lifecycle) before
  hardening its edges.

## Suggested next steps (issues to open)

- **Mobile purchase client** (blocked on the strategy decision above) — the core
  gap. **Must include wiring the existing `UpgradePrompt` call sites** (spec:112):
  every production prompt currently omits `onUpgrade`, so `UpgradePrompt.tsx`
  disables the CTA and shows "Coming soon" — building the purchase flow without
  wiring the ~10 sites (MapScreen, RideDetailScreen, TripsScreen, GroupRideScreen,
  TripCreateScreen, OfflineRegionsScreen, CommuteScreen, TripDetailScreen,
  SettingsScreen, …) to open the paywall would leave it **unreachable**. Include the
  call-site wiring + regression coverage. **Account-linking injection at purchase
  time** (required for validation to pass at all): the purchase request must set the
  authenticated rider's **`appAccountToken` (iOS)** / **`obfuscatedExternalAccountId`
  (Android)**. The Apple validator rejects a missing or unequal token with a terminal
  409 (`iap-validate.service.ts:305-315` — `verified.appAccountToken !== userId`), so
  **without this every Apple purchase from the new client fails validation.** Add
  both platform parameters + mocked purchase-request tests. **The `react-native-iap`
  transaction/purchase listener** (spec:110) with setup/teardown: leaving a
  transaction unfinished only enables recovery if the client installs the listener,
  so a store re-delivery after a transient validate failure or an app exit
  mid-purchase gets picked up and re-validated — without it a later delivery goes
  unvalidated and a charged rider has no refreshed entitlement until they manually
  restore. Add a **pending-transaction-after-relaunch** regression test. Beyond
  purchase / restore / entitlement-refresh, the issue must carry the
  **transaction-closeout contract** from spec:110-115: **validate before
  finishing/acknowledging**; on a **retryable** backend failure (5xx/network)
  **leave the transaction unfinished** so the store re-delivers; on an **iOS terminal
  rejection** `finishTransaction` **and** direct the rider to _cancel_ the
  subscription in the App Store (finishing alone still lets it renew and charge),
  with the backend opening a `store_billing_reconciliations` row; on an **Android
  terminal rejection never `acknowledge`** before refund/revoke (an unacknowledged
  purchase is auto-refunded by Play; acknowledging strands a charged rider with no
  entitlement). **CRITICAL exception (spec:116): an ownership/binding failure
  mutates NOTHING** — a token whose verified `obfuscatedExternalAccountId` maps to a
  different rider (or is already owned by another account) is a **409 with no
  refund, revoke, or acknowledge**; refund/revoke is reserved for purchases proven
  to belong to the authenticated caller, so the close-out order is verify →
  **account-binding check first** → refund/revoke only for own-purchase terminal
  rejections. Without this, a replayed victim token could cancel the victim's
  legitimate subscription. Missing the general rules strands a charged purchase on a
  transient outage or suppresses Play's auto-refund. **Trial eligibility (spec:120):
  backend `billing_trial_used_at IS NULL` is necessary but NOT sufficient to
  advertise/select a trial** — the paywall must combine it with **store-side**
  eligibility (iOS `Product.SubscriptionInfo.isEligibleForIntroOffer`; Android the
  offers actually returned by the Play Billing query) and advertise + buy the trial
  product only when **both** agree, else the no-trial product. Otherwise an Apple ID
  that already consumed the store trial is shown "14-day free trial" and charged the
  full annual price (or the Android purchase fails). Include these + their tests.
  **Store-management status (spec:118-120):** Settings must **show the current plan
  and a "Manage in App Store / Play Store" deep link** (store subs are managed in
  the store, not in-app) — no `managed_by` handling or store-management link exists
  under `apps/mobile/src` today, so without it a rider who subscribes via the new
  paywall has no mobile path to change or cancel. **Store-review paywall disclosures
  (spec:183-185):** the paywall must show the
  **store-localized price and period** (displayed price comes from the store, not
  the EUR-canonical config — only kept aligned to the €29.99/€49.99 intent),
  **disclose trial terms**, and provide a **restore** button and **terms / privacy**
  links. Omitting these produces misleading pricing or an App Store / Play review
  rejection; include the disclosure work + paywall tests in the delivery plan.
- **Google Play IAP** — build or explicitly de-scope. If built, the P2 scope must
  include the **durable acknowledgement contract** (spec:67, 80, 167), not just the
  client's "acknowledge after a successful validate": because the entitlement
  **commits before** the Play `acknowledge` call, acknowledgement is tracked as
  **durable server state** (an `acknowledged` flag / pending-ack marker) and
  **retried both on the next re-validate of that purchase and by a background
  sweeper**. Otherwise, if the grant commits but the response or the acknowledge is
  lost and the client never revalidates, **Play auto-refunds the unacknowledged
  purchase while Tarmoto keeps a paid `subscription_tier`**. Include the server-side
  marker, the sweeper, and the grant-committed-but-acknowledge-lost failure-path
  tests (acknowledging is idempotent, so retry-after-partial is safe). Also the
  **deferred/pending-purchase contract** (spec:85, 150, 167): `validate` **binds a
  pending token to the rider WITHOUT granting access**, and a later
  `SUBSCRIPTION_PURCHASED` RTDN **re-queries and activates** it — otherwise a
  cash/pending purchase that completes while the app is closed reaches RTDN with an
  unbound token and a charged rider is stranded on `free`. **The identity-aware
  atomic provider-claim on EVERY Google activation** (initial `validate` AND
  `SUBSCRIPTION_PURCHASED`), not a bare Play-state sync — there is **no Google claim
  today** (finding table, line 53). Without it a late Google purchase can overwrite
  an Apple/Stripe owner, or a second Google token can replace an existing one while
  **both** subscriptions keep billing. Require the atomic claim + **same-provider
  different-token rejection** + refund/revoke reconciliation for a **proven losing**
  purchase, with cross-provider and same-provider regression tests. And the **replay-safe
  Play-mutation contract** (spec:140-145, 159): the `subscriptions.v2 cancel /
refund / revoke` APIs take **no idempotency key**, so recovery is
  **re-query-then-act** hardened three ways — a **lease longer than the operation's
  worst-case execution + Play's visibility lag**, **bounded polling** of the
  terminal state before any reissue, and **already-applied responses treated as
  success** (not a retry, not a failure). Without these a reclaimed worker can
  observe stale state and double-issue, or hard-fail on an already-applied result.
  Include the pending-token binding + completion recovery, the replay rules, and
  the **accepted-but-not-yet-visible** regression test. **The full RTDN state matrix
  (spec:85), not just `SUBSCRIPTION_PURCHASED`:** `SUBSCRIPTION_RENEWED`,
  `SUBSCRIPTION_RESTARTED`/`_RECOVERED` (reactivate → re-claim), grace
  (`SUBSCRIPTION_IN_GRACE_PERIOD` — hold, keep access), `SUBSCRIPTION_ON_HOLD` /
  `_PAUSED` (drop tier → `free`, **retain provider**), cancel-before-expiry (keep
  tier + mark canceling until the re-queried state actually expires),
  `SUBSCRIPTION_EXPIRED` (terminal), `SUBSCRIPTION_REVOKED`/refund (terminal) — all
  re-query-driven and identity-guarded, with regression tests; without them a refund
  or expiry while the app is idle leaves the paid tier active, and hold/pause vs
  recovery can't correctly drop/restore access. **The RTDN endpoint must
  authenticate the Pub/Sub push** (spec:68, 85) — verify
  `TARMOTO_GOOGLE_IAP_PUBSUB_VERIFICATION_TOKEN` **before** accepting the envelope;
  otherwise any internet caller can inject arbitrary notification ids / purchase
  tokens and burn Play-API, inbox, and worker capacity. Add endpoint authentication
  and rejection tests. **Each RTDN state application runs under the existing
  per-rider subscription lock / fence** (the same one the Apple scope uses), around
  the **complete Play re-query-and-write** — re-query alone doesn't prevent stale
  writes when Pub/Sub delivers two notifications for the same token concurrently
  (worker A reads `active`, worker B reads + commits `ON_HOLD`, then A overwrites
  with its older result). Add an overlapping-notification regression test. **And the
  Google notification-inbox flow** (the `processed_store_notifications` machinery
  exists as schema + completed-row pruning only): persist the `pending` row
  **before** any Play/DB side effect, lease/resume it on redelivery or crash,
  classify dead letters, and repair/reopen on verified redelivery — otherwise a
  crash after a Play/DB effect loses a refund/expiry or a retried push repeats an
  external mutation. **Google account-deletion
  cancellation (spec:101-106, 167):** the deletion flow cancels only Stripe today
  (`account-deletion.service.ts:183-217` is `isStripeSubscriber`-gated), so a Google
  subscription would renew while the rider is locked out during the 30-day deletion
  grace. Add the **deferred Play cancel at deletion-request time** (stop the next
  renewal without forfeiting the paid period) — it **must use the
  `USER_REQUESTED_STOP_RENEWALS` cancellation type** (spec:104), which leaves the
  subscription **rider-restorable** in Play, NOT the developer-requested
  stop-payments mode (which the rider cannot restore and would make the promised
  in-window "re-enable in Play" path impossible, leaving a restored rider set to
  lapse) — durable retry, the **rider-action
  restoration copy** (Play has no server-side un-cancel — the rider re-enables /
  re-subscribes), and deletion-flow tests. **Durable retry alone is not enough — the
  retry worker and the restoration path must be serialized under the same per-rider
  lock** (`pg_advisory_xact_lock` on the user id, per the P0 pattern): otherwise a
  TOCTOU race lets the worker read `deletion_scheduled_at` as set, restoration then
  clears it, and the worker still cancels the renewal for the now-restored rider —
  and Play has no server-side inverse, so the restored rider silently lapses. The
  worker takes the lock, **re-checks `deletion_scheduled_at` under the lock** before
  the Play call, and restoration takes the SAME lock to clear it. Add a
  worker-vs-restoration race test.
- **Apple ASSN v2 lifecycle (P1b)** — the full transition set from spec:84, not
  just renew/expire/refund. **Overarching rule (spec:81): every notification
  re-queries authoritative Apple state and applies that result under the rider's
  existing serialization — the event TYPE is never applied directly.** The
  per-event notes below are the intent, not a licence to map the event name to a
  state; without the re-query a delayed/out-of-order delivery (an old
  `DID_FAIL_TO_RENEW` arriving after a `DID_RECOVER`, or an old `DID_RENEW` after a
  refund) would regress a recovered subscription or resurrect access after a refund.
  Transitions: `SUBSCRIBED` (resubscribe/reactivate → re-validate +
  re-claim), `DID_RENEW`, `DID_FAIL_TO_RENEW` (→ `past_due`, tier held only during
  a real grace window), `DID_RECOVER` (→ `active`), `GRACE_PERIOD_EXPIRED` (drop
  tier to `free` but **retain** the provider — recovery still possible for ~60d),
  `DID_CHANGE_RENEWAL_PREF` (in-group Pro↔Premium — **apply upgrades immediately,
  defer downgrades to the next `DID_RENEW`**; tier from the re-queried verified
  product, never the event), `DID_CHANGE_RENEWAL_STATUS` (**handle both subtypes** —
  OFF → keep tier + `cancel_at_period_end = true`; ON → re-query + **clear**
  `cancel_at_period_end` so a re-enabled rider isn't left marked as canceling),
  `EXPIRED`/`REFUND`/`REVOKE` (terminal — **identity-guarded**). **Every terminal
  clear must be conditional on the event's subscription identity still being the
  rider's active one** (spec:81-82): a guarded `UPDATE … WHERE
subscription_provider = :eventProvider AND <store-id> = :eventStoreId`. Resolving
  the rider by the account-linking id is necessary (a reactivation must find them)
  but is NOT sufficient authority to clear the tier — a delayed `EXPIRED`/`REFUND`
  for an OLD token, after the rider already replaced it with a new active
  subscription, resolves the same rider and an unconditional clear would wipe the
  NEW valid provider/tier. Include the guarded update + a stale-old-subscription
  test. Plus the `billing_retry` recovery + "Free + Payment issue" badge (both
  Apple-specific). **And the safety/recovery plumbing deferred alongside these
  transitions** (`iap.md:204-215`): the ASSN v2
  endpoint + `decodeNotification` with signed **bundle-id / environment**
  verification (the endpoint is unauthenticated apart from its signed payload, so a
  wrong-app or sandbox-vs-production payload must be rejected before any mapping),
  the notification inbox's **lease / dead-letter / redelivery** processing (ASSN
  retries, so a transition must survive a worker crash without being stranded or
  double-applied) — **including the inbox privacy/recovery semantics** (spec:33,
  158, 165), which the P0 cleanup does NOT yet implement (it only prunes old
  completed rows): a **completed** row immediately **NULLs its signed payload**; a
  **transiently-blocked valid** event **retains** its payload so a real
  refund/revoke/renewal can still be applied after the outage; **only a
  classified-permanent failure may be redacted** (`permanent_reject` /
  `corrupt_context`); and a **verified fresh redelivery repairs a `pending` row
  in place / re-opens a `corrupt_context` dead-letter** (never re-reads corrupt
  stored context). Without these, signed billing data lingers until pruning, or a
  prolonged dependency outage dead-letters and discards the only context needed to
  apply a real refund/revoke. **Plus ops escalation + alerting** (spec:158):
  retaining the payload is necessary but not sufficient — a **transiently-blocked
  valid** event that outlasts the automatic retry budget must **escalate to ops for
  manual replay** (not sit `pending` forever while a real refund/revoke/renewal is
  never applied), and a **classified-permanent dead-letter** must **alert ops**.
  Include the classification, redaction, and repair/reopen behaviour, the
  escalation/alert signals, and their regression coverage. Then reconciliation
  closeout, and the `store_billing_emails` delivery
  and the `store_billing_emails` delivery
  ledger **combined with an ESP-side idempotency key / status lookup** (spec:42,
  155, 158). The ledger alone is not exactly-once: if the ESP accepts a message and
  the worker crashes before the row flips `pending`→`sent`, the resumed job can't
  tell whether delivery happened — only the ESP idempotency key / status lookup
  closes that window. Include the **accepted-but-not-recorded** regression test.
  **Plus the coupled ledger-retention contract** (spec:42): a ledger row must be
  **kept while its inbox row is non-terminal** and pruned **only after** the inbox
  row reaches a terminal state **AND** the ledger's own retention window elapses —
  not on an independent horizon. A transiently-blocked notification can outlive the
  normal redelivery window; if the ledger were pruned independently, a later manual
  replay (after the ESP's idempotency record has also expired) would **re-send** the
  email with no row to dedupe against, while never pruning grows the table
  unbounded. Add the coupled retention/prune behaviour + a **delayed-replay** test.
  Or fold the whole lot into RevenueCat if chosen.
- **Stripe status→entitlement hardening** — persist the paid tier only for an
  **allowlist of entitling raw Stripe statuses** (`active`, `trialing`, and
  `past_due` during a genuine grace window) and drop it for **every other** status
  (`incomplete`, `incomplete_expired`, `unpaid`, …) — not a two-item blocklist,
  which still re-grants on `incomplete_expired`. Fix in Stripe ingestion, not by a
  resolver status gate (which would revoke founder/promo/admin grants); finding 5a.
  A live web-path bug today.
- **Stripe event-ordering hardening** — live subscription re-query applied on
  same-subscription writes (not `event.created`, which is second-granularity;
  finding 5b). Re-query alone is insufficient: `handleWebhook` derives `isDeleted`
  from the event type (`account.service.ts:394-402`), so a delayed
  `customer.subscription.updated` whose **re-queried state is terminal or missing**
  must be routed through the **identity-guarded terminal-clear path**
  (`clearStripeTerminal`), not `claimForStripe` — otherwise it retains
  `subscription_provider = 'stripe'` + the sub id and blocks a later Apple/Google
  claim even after dropping the tier to `free`. Include the **deleted-then-delayed-`updated`**
  regression test. Applies on the live web path today, independent of the mobile
  decision.
- **Store ops-enablement + sandbox E2E (P4)** — even with the mobile client and
  lifecycle handlers built, there is **no usable purchase path** until the store
  side is provisioned. The Apple endpoint ships **dark** via **two separate gates**
  (`iap.md:178-202`): (1) the boolean `AppleIapConfig.isConfigured()` gate — issuer
  id, key id, private key, bundle id, plus (in Production only) the numeric app id —
  returns a retryable `503` while any of those is missing; and (2) a **separate
  verification-path check** for `TARMOTO_APPLE_IAP_ROOT_CERT_DIR`, deliberately NOT
  folded into `isConfigured()` (`apple-iap.config.ts:28-33,71-92`). Ops must satisfy
  **both**: with the core credentials set in Sandbox, `isConfigured()` reports
  `true` **even when the root cert dir is absent**, so an ops readiness check on
  that boolean alone passes while every purchase validation still fails closed with
  a `503` on the missing trust store. Provision the root certs as a distinct
  checklist item. The approved design also assigns **store product/config setup
  and sandbox purchase loops** to P4 (`iap.md`; design spec lines ~169-175). Treat
  ops-config, App Store / Play product creation, and **full sandbox E2E loops** as
  their own delivery step — the client + handlers alone are not end-to-end. The
  sandbox run must be **purchase, renewal, AND cancellation** on **both App Store
  sandbox and Play internal testing** (spec:161), not purchase-only: a purchase-only
  pass never exercises ASSN/RTDN lifecycle ingestion, so expiry/refund/cancel/renew
  handling could stay broken while this step "passes." Assert the entitlement
  transition at each leg. (If RevenueCat is chosen, this becomes RevenueCat
  project/product config + the same purchase/renew/cancel sandbox loops.)
- **Contract-artifact regeneration (spec:173)** — every backend issue that changes
  an HTTP contract regenerates the OpenAPI artifacts **in the same PR**: `pnpm
openapi:gen` → committed `packages/openapi/openapi.yaml` +
  `packages/openapi-client/src/generated/schema.d.ts` (so generated consumers see
  `provider`/`managed_by`/trial-eligibility and the new `iap/validate` + notification
  routes), plus **Postman regeneration** where an endpoint lands. This binds the
  Google validate/RTDN work **and** the Apple ASSN route; omitting it leaves
  generated consumers unable to call the implemented routes or represent the Google
  request shape even when the runtime backend is complete.

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
