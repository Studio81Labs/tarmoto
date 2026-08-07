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

| Concern                     | Treatment                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SUBSCRIPTION_PROVIDERS`    | unchanged — `['stripe','apple','google']`                                                                                                                                                                                                                                                                                                  |
| Store identity              | Apple unchanged — `apple_original_transaction_id`. **Google column replaced by `google_original_transaction_id`, staged as expand/contract** — see the two corrections below (migration 1830 then 1831 each ADD a column plus an equivalent partial unique index; the two superseded columns and their indexes are dropped together later) |
| `SUBSCRIPTION_MANAGED_BY`   | unchanged — `app_store` / `play_store`                                                                                                                                                                                                                                                                                                     |
| Companion subscription page | **unchanged** — the store panels already render from `managed_by`                                                                                                                                                                                                                                                                          |
| Notification inbox          | unchanged — `processed_store_notifications.provider` is already `'apple' \| 'google'`, and the composite `UNIQUE (provider, notification_id)` gives RevenueCat event dedup                                                                                                                                                                 |
| Reconciliation              | unchanged — `store_billing_reconciliations`                                                                                                                                                                                                                                                                                                |

**Consequence: no shared-contract change, no companion change, and additive
column migrations only (plus a later drop — see the corrections below).** This is what
makes the option cheap, and it is the reason to prefer mapping over introducing a
`revenuecat` provider value.

> **CORRECTION (2026-08-06, before step 4 was built).** The original text of this
> section claimed **no migration at all**, and that Google identity would land in
> `users.google_purchase_token`. That was wrong, and it is worth recording why
> rather than quietly editing it away.
>
> **⚠️ SUPERSEDED IN PART by the second correction below.** Everything here about
> there being no Play purchase token, and about expand/contract being mandatory,
> stands. What this block got wrong is **which** RevenueCat identifier the binding
> stores: it named `store_transaction_id`, which advances on every renewal. The
> column is now `google_original_transaction_id`. Read both blocks together.
>
> **RevenueCat never exposes a Play purchase token** — not in the webhook event
> body, and not in the subscriber API. Verified against both. What it gives for a
> Play subscription is `store_transaction_id` (its own transaction identifier);
> the webhook additionally carries `transaction_id` / `original_transaction_id`.
> For Apple this is a non-issue: RevenueCat's `original_transaction_id` **is** the
> Apple OTID, so `apple_original_transaction_id` keeps its exact meaning.
>
> Storing an RC transaction id in a column called `google_purchase_token` would
> make the schema lie. So the Google store-identity column becomes
> `google_store_transaction_id`, on both `users` and
> `store_billing_reconciliations` (the latter's only writer passes
> `googlePurchaseToken ?? null` from the Apple path, so it too has never held a
> Google value).
>
> **That change is staged as expand/contract, not as a single `RENAME COLUMN`.**
> Backend deploys are a Coolify rolling update — the old container keeps serving
> traffic while the new one boots and runs migrations — so a rename would make
> every `SELECT` the old image issues for a `User` fail with PostgreSQL `42703`
> until traffic switches, and would leave a rollback to the previous image
> permanently broken. "The column is NULL everywhere" is true of its _contents_
> and does not help: the hazard is the column **name** in TypeORM's select list.
> See `docs/process/typeorm-migrations.md` → "Rename a column".
>
> - **Expand (migration `1830000000000`, shipped with step 4):** ADD
>   `google_store_transaction_id VARCHAR(1024)` to both tables, plus a partial
>   unique index `uq_users_google_store_transaction_id` mirroring
>   `uq_users_google_purchase_token`'s `WHERE ... IS NOT NULL` shape so it keeps
>   enforcing one-subscription-per-rider. The old columns and index stay.
> - **Switch code (same release):** the entities and the one writer map only the
>   new column; the old columns are left unmapped.
> - **Contract (a later release):** drop the old columns and index — see open
>   item (e) in §4.
>
> No backfill and no dual-write phase are needed, and their absence is
> deliberate: `google_purchase_token` has **no writer anywhere in the backend**
> (only the entity declaration — Google was never built), so it is NULL in every
> row of every environment, and the only code that writes the new column is the
> new image's `claimForGoogle` / `clearGoogleTerminal`, which the old image does
> not have.
>
> Everything else in this section survives unchanged: `request_date_ms` **does**
> exist on the subscriber response (confirmed), `store` distinguishes
> `app_store` / `play_store`, and the claim / lock / inbox / reconciliation
> envelope is untouched.

> **CORRECTION (2026-08-07, resolving open item (b), before step 5 was
> planned).** The block above pinned the Google binding to RevenueCat's
> `store_transaction_id`. **That is the wrong field, and it would have broken
> every renewal.** Verified against RevenueCat's own field documentation:
>
> - **`transaction_id`** — _"Transaction identifier from the store."_
> - **`original_transaction_id`** — _"`transaction_id` of the original
>   transaction in the subscription."_
>
> The subscriber API's per-subscription `store_transaction_id` is the **current
> period's** transaction, not the subscription's first. RevenueCat's own
> documented example value is a Google Play order id of the form
> `GPA.6801-7988-0152-76034..5` — the `..N` suffix is the renewal counter, and it
> increments on each renewal. RevenueCat support states the same directly: the
> field holds the latest transaction id, "Google Play: Generates a new
> transaction ID on renewal that increments from the original", and
> `original_transaction_id` is what to use for an identifier constant across the
> subscription's lifetime.
>
> **The binding is therefore `original_transaction_id`**, and the column is
> `users.google_original_transaction_id` (plus the sibling on
> `store_billing_reconciliations`).
>
> Why this matters concretely: `claimForGoogle`'s identity guard is
> `(google_original_transaction_id IS NULL OR = :otid)`. Fed a per-renewal id it
> matches on the initial purchase and then **rejects every renewal after the
> first** — `'conflict'` on each one, so §4 step 6 opens a reconciliation row per
> renewal while `subscription_current_period_end` stays frozen at the first
> period. The rider keeps being charged by Google and silently loses entitlement
> at the original date. Nothing self-heals it. There is a regression test for
> exactly this (`provider-claim.service.spec.ts`, "re-claims the SAME slot on a
> renewal and advances the period end"), which simulates the row against the real
> guards; it fails with `'conflict'` if the id is given a `..2` suffix.
>
> **This also makes the two stores symmetric.** RevenueCat's
> `original_transaction_id` for an App Store subscription **is** the Apple OTID —
> exactly what `apple_original_transaction_id` already holds. Both columns now
> hold the same kind of value under the same name, which is the point of the
> naming: a reader who understands one understands the other. (See open item (a)
> for what this does and does not resolve about the Apple/Google asymmetry.)
>
> **Staged as expand/contract again, for the same reason as before** — a
> `RENAME COLUMN` breaks the old container's `SELECT` with `42703` during
> Coolify's rolling update and breaks rollback:
>
> - **Expand (migration `1831000000000`):** ADD
>   `google_original_transaction_id VARCHAR(1024)` to both tables, plus the
>   partial unique index `uq_users_google_original_transaction_id` mirroring the
>   existing two. **Both** older generations — `google_purchase_token` (1822) and
>   `google_store_transaction_id` (1830) — and their indexes are left in place.
> - **Switch code (same release):** the entities and the one writer map only the
>   newest column.
> - **Contract (a later release):** drop the **two** superseded columns and their
>   indexes together — see open item (e).
>
> Three generations of this column therefore exist transiently. That is the
> accepted cost of not breaking the rolling deploy; it is not drift to be tidied
> up mid-flight. Still no backfill and no dual-write: neither older column has
> ever had a writer that ran in any environment (Google IAP is not implemented
> and the step-5 consumer does not exist yet), so both are NULL in every row
> everywhere.

### Retired by this decision

The native Apple ingestion path becomes dead weight (§6):
`iap-validate.service.ts`, `apple-billing.client.ts`, `apple-iap.config.ts`,
`dto/iap-validate.dto.ts` and their specs. **All of it is now deleted** (PR
#1136, §12 step 8) — this list is the record of what went, not a to-do.

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

`Purchases.logIn(<the rider's `purchase_account_token`>)` sets RevenueCat's
`app_user_id` at authentication time, and `Purchases.logOut()` on sign-out. The
client fetches that identifier from an authenticated endpoint; it never derives
it.

RevenueCat webhooks then carry `app_user_id` directly, so rider resolution is a
single indexed lookup on `users.purchase_account_token`. This removes the
`appAccountToken` (iOS) / `obfuscatedExternalAccountId` (Android)
purchase-parameter injection and JWS extraction that the native path required —
and which today terminally 409s every Apple purchase
(`iap-validate.service.ts:305-315`).

> **⚠️ THIS SECTION SAID `Purchases.logIn(<tarmoto user id>)` AND "primary-key
> lookup" UNTIL 2026-08-07 — do not restore either.** Rider ids are public to
> other riders via `PublicProfileDto.id`, so a modified client could call
> `logIn` with a victim's id, buy, and have RevenueCat emit an **authentic**
> webhook binding that purchase to the victim's row. No secret required, and
> every guard in §4 passes because nothing is forged. The victim's own later
> purchase then fails the identity guard — they pay and get nothing — and under
> some RevenueCat transfer settings an active subscription can be moved outright.
>
> The identifier is therefore a **backend-issued random UUID**
> (`users.purchase_account_token`, unique), served only to the authenticated
> rider.
>
> **Named for its role, not for the vendor (implementation decision, 2026-08-07).**
> This document originally called the column `revenuecat_app_user_id`; it shipped
> as `purchase_account_token`. RevenueCat is an ingestion channel, not a provider
> — `SUBSCRIPTION_PROVIDERS` stays `stripe|apple|google` — and this column is the
> successor to the native path's `appAccountToken` (iOS) /
> `obfuscatedExternalAccountId` (Android), which RevenueCat replaces with
> `app_user_id`. A UUID satisfies all three, so a future native path reuses the
> column rather than renaming it. The alternative invites a third rename:
> `google_purchase_token` → `google_store_transaction_id` →
> `google_original_transaction_id` already happened twice while that code sat
> unused, and §6 cites it as a real carrying cost. Full attack, both harms, and the ops-side transfer-behaviour requirement
> are in §4's binding correction; the work is open item **(j)**, which blocks
> steps 5 and 6.

**Anonymous-purchase guard.** The paywall is reachable only for an authenticated
rider, and the purchase call asserts a non-anonymous RevenueCat `app_user_id`
before invoking the store. A purchase made under an RC anonymous id cannot be
resolved to a rider by the webhook.

## 3. Backend: provider claim for Google

`ProviderClaimService` gains `claimForGoogle` and `clearGoogleTerminal`: a single
guarded UPDATE with an ownership/identity predicate, the ordering key written to
`subscription_store_signed_date`, a `subscription_lock_fence <= :token` guard, and
`markTrialUsed` folded into the same statement so the tier grant and the
once-per-rider trial stamp commit atomically.

> **SCOPE CORRECTION (2026-08-06, before step 4 was built).** This section
> originally said `claimForGoogle` mirrors the Apple pair "**exactly**". That was
> wrong as a scope instruction, and following it literally would have repeated the
> mistake this whole design exists to correct.
>
> `claimForApple` is **194 lines** with five return values (`claimed` /
> `conflict` / `stale` / `trial_ineligible` / `ownership_conflict`), a
> compare-and-swap baseline, two WHERE branches, and a disambiguating re-read.
> `claimForStripe` — the other sibling — is **53 lines**. Nearly all of the
> difference exists to serve **`IapValidateService`**, the sole consumer of those
> five return values, which §6 unmounts and then deletes.
>
> A RevenueCat webhook consumer does not have those needs. It is not a synchronous
> client request (so `trial_ineligible` is not a 409 to branch on), and it
> re-queries authoritative state before writing (so `stale` does not mean what it
> means on the validate path). Building the full Apple surface for it would be
> machinery ahead of a workload — the exact scope inversion the audit flagged.
>
> **`claimForGoogle` is therefore scoped to what the webhook consumer actually
> branches on**, closer to `claimForStripe`'s shape: ownership/identity guard,
> fence, atomic trial stamp, and the ordering predicate below. Return values are
> added only where §4's consumer genuinely takes a different path — a lost claim
> must still be distinguishable, because §4 step 6 opens a reconciliation row on
> it. If a later workload proves one of Apple's other guards is needed, add it
> then, with the race that motivated it named in the test.

This mirrors the mechanism, not the guarantee. For Apple, `signedDate` versions
the _state_ — it is Apple's own signed claim about what changed — so the
ordering key doubles as a true state-monotonicity check. For Google/RevenueCat,
the value written to the same column is `request_date_ms`, which versions the
_read_, not the state (§4 step 3 below explains why). The column, the guard
shape, and the atomicity are identical between the two claims; the semantic
guarantee is weaker for Google. Do not read this section in isolation and
assume `claimForGoogle` gets the same state-monotonicity property
`claimForApple` does — see §4 step 3 for the actual guarantee and why
correctness still holds without it.

`clearGoogleTerminal` **nulls** `google_original_transaction_id`, exactly as
`clearStripeTerminal` nulls `stripe_subscription_id`. Note the identifier is
RevenueCat's `original_transaction_id` — **not** a Play purchase token, and
**not** the per-renewal `store_transaction_id` — see the two corrections in §1.

> **CORRECTION (2026-08-06, final review of step 4).** This paragraph
> originally said `clearGoogleTerminal` **retains** the id "as a historical
> binding (matching `clearAppleTerminal`'s retained-OTID behaviour) so a later
> reactivation can still resolve the rider by it". That was implemented, and it
> was a **permanent entitlement lockout**.
>
> `claimForGoogle`'s identity guard is `(google_original_transaction_id IS NULL OR
= :otid)`, and — per this section's own scope correction — it has no
> equivalent of `claimForApple`'s Branch A escape hatch for replacing a
> retained-but-unowned binding. So: the Play subscription expires → the terminal
> clear nulls the provider but keeps id `A` → the rider re-subscribes (a **new**
> subscription, hence a **different** `original_transaction_id` `B`) → the provider
> guard passes (NULL) but the identity guard fails (`A` is neither NULL nor `B`)
> → 0 rows → `'conflict'` → §4 step 6 opens a reconciliation row. Every
> redelivery and every future purchase repeats it. The rider is billed by Google
> and stays on `free` **permanently**, and nothing self-heals.
>
> **The stated rationale was also factually wrong under this design.** Rider
> resolution is a single indexed lookup on the webhook's `app_user_id`, matched
> against `users.purchase_account_token` (§2) — the store transaction id is never
> used to resolve the rider. The rationale was
> inherited verbatim from `clearAppleTerminal`, whose **native** path genuinely
> did resolve by OTID; that property does not survive the move to RevenueCat.
>
> Retention also bought no guard: every stale claim the retained identity would
> have rejected is already rejected by the read-ordering guard, which the
> terminal clear advances to its own `observedAt`. Nulling additionally shrinks
> the `23505` surface in open item (d) below, since a terminal-cleared row no
> longer holds an id a transferred purchase could collide with.
>
> The §8 test line "including the retained-token binding" is superseded
> accordingly: the property to test is that a terminal-cleared slot is
> **claimable by a later re-subscribe carrying a NEW original transaction id**.
> **§8 now says so directly** (updated 2026-08-07); this sentence is kept as the
> reasoning trail, not as outstanding work.

## 4. Backend: the RevenueCat webhook consumer

`POST /account/subscription/revenuecat/webhook`.

**Authentication.** A shared secret in the `Authorization` header, configured
RevenueCat-side, compared in constant time against
`TARMOTO_REVENUECAT_WEBHOOK_SECRET`. A missing or wrong secret is a 401 with no
inbox write.

**"Before the envelope is parsed" needs bootstrap work — a guard is not enough
(2026-08-07).** `main.ts:147-149` mounts `expressJson` **globally**, and Express
middleware runs before Nest guards, so an ordinary guard-plus-controller
implementation parses first: a malformed body from a caller with no secret returns
**400**, not 401, and the parse happens on their behalf. Mount a **route-scoped
middleware above the global parser** in `main.ts` — path-scoped `app.use` is
already precedented there for the geometry body limits, and the check needs only
the `Authorization` header, so it composes cleanly ahead of any body handling.

**Mount it on the PREFIXED path:**
`/api/v1/account/subscription/revenuecat/webhook`. Express matches middleware
against the **raw URL, including the global prefix** — unlike Nest's `@Post()`,
which is relative to it — which is why every existing pre-parser mount in
`main.ts` spells out `/api/v1/…` (`/api/v1/trip-shares`, `/api/v1/map-shares`,
`/api/v1/roads/route-quality`). Mounted on the unprefixed path the middleware
silently never runs, the parser wins, and the malformed-body case returns 400
while the wrong-secret case still returns 401 — so the suite looks green.
Prefer the shared prefix constant over a literal, and **exercise the production
path in the ordering test**, not a relative one.

**The route also needs `@SkipThrottle()`.** `ThrottlerModule.forRoot`
(`app.module.ts:57-59`) limits **every** route to 60 requests/minute, and the
Stripe webhook is already exempted for this reason
(`account.controller.ts:81-82`). RevenueCat delivers from shared provider
infrastructure, so a purchase burst or a backlog replay lands in **one IP bucket
covering all riders** — and a throttled request is rejected **before an inbox row
exists**, which puts it outside every retry and sweep mechanism this design
builds. Once RevenueCat exhausts its own retries the event is simply gone.

Keep the guard as well. The middleware provides the **ordering** property; the
guard remains the authoritative check, so if the middleware is ever dropped or
remounted the endpoint degrades to 400-before-401 rather than becoming
unauthenticated. Note this is ordering-sensitive bootstrap code: moving the
`app.use` below the parser silently reverts the guarantee while every test that
only asserts "wrong secret ⇒ 401" keeps passing — which is why §8 requires the
malformed-body-without-secret case specifically.

This is a static shared secret with no per-event body signature — genuinely
RevenueCat's model, unlike Apple's signed JWS payloads. Record why the design
survives that weaker guarantee, so nobody "optimises" it away later — **and
record precisely how far the argument reaches, because it does not cover
everything.**

**For subscription state, the re-query carries it.** The design holds **only**
because step 2 re-queries authoritative state from RevenueCat's own subscriber
API rather than ever trusting the event body. A caller who knows the shared
secret and forges an event carrying a victim rider's real `app_user_id` cannot
inject arbitrary tier, status, or dates — the handler ignores the forged
payload's fields and re-fetches that same rider's actual, true subscriber state,
then reapplies it under the per-rider lock. For state, the forged delivery
degrades to an idempotent no-op re-application of the victim's own real state.
Do not later trust state fields on the event body directly for a latency or
simplicity win — that reintroduces exactly the forgery surface this design
avoids, and it is the re-query, not the secret, doing the correctness work.

> **⚠️ AND NONE OF THIS PROTECTS THE BINDING ITSELF — the `app_user_id` must not
> be the Tarmoto user id (2026-08-07).** Everything above reasons about a caller
> who holds the webhook secret. **The binding needs no secret at all.**
>
> **The attack.** A modified client calls `Purchases.logIn(<victim's user id>)`
> and buys. RevenueCat associates the purchase with that `app_user_id`, emits a
> perfectly **authentic** webhook, and returns that subscription when the backend
> re-queries. Every guard in this document passes, because nothing here is being
> forged. And the ids are not secret: `PublicProfileDto.id`
> (`users/dto/public-profile.dto.ts:19`) hands a rider's id to any other
> authenticated rider.
>
> **Two harms, and the second is worse than anything else recorded here.**
>
> 1. **Denial of entitlement.** The victim's slot now holds the attacker's
>    `original_transaction_id`, so the victim's own later purchase fails the
>    identity guard — they pay and get nothing. Same end state as (g)'s forged
>    binding, reachable with **no secret**.
> 2. **Transfer.** RevenueCat's behaviour when `logIn` targets an `app_user_id`
>    that already owns a subscription is **configurable**, and some settings move
>    the subscription to the calling device. Under those, an attacker who knows a
>    rider's id can attempt to take over their active entitlement. That is theft,
>    not gifting.
>
> **Fix: a backend-issued, unguessable, non-public RevenueCat identifier.** Store
> a random UUID per rider (`users.purchase_account_token`, unique), hand it out
> **only** to the authenticated rider from an authenticated endpoint, and have the
> client pass **that** to `Purchases.logIn` — never the Tarmoto id. §2's rider
> resolution becomes a lookup on that column instead of a PK lookup; it stays a
> single indexed read. Knowing a rider's public id then buys the attacker nothing.
>
> **Secrecy alone is not the whole fix.** Configure RevenueCat's **transfer
> behaviour** deliberately at ops enablement rather than accepting the default —
> an unguessable id makes targeting a specific victim impractical, but the
> transfer setting is what decides whether a collision does damage. Both, not
> either.
>
> Carries a migration, an entity change, an endpoint, and a mobile contract
> change. **Blocks step 5** (resolution reads the new column) **and step 6**
> (mobile must fetch the identifier rather than reuse the user id) — see open item
> **(j)**.

**For the store identity, it does not — and the secret is load-bearing.** The
`original_transaction_id` is the one field that arrives solely from the event
body and cannot be checked against authoritative state, because the subscriber
API does not return an original transaction identifier at all. On a rider whose
identity column is still NULL the claim guard's `IS NULL` branch accepts
whatever the event supplies, so a forged first binding **sticks**, and every
later legitimate renewal, expiry, or refund for that rider fails the equality
guard and cannot apply.

So this rationale justifies accepting an unsigned body **for state only**. Do
not cite it for the identity binding, and do not read "the event body is a
trigger to go look, never a source of truth" as covering the whole payload —
for the identifier, the event body _is_ the only source there is. **Step 5 must
choose a mitigation; see open item (g)**, which carries the full attack, the
options, and the one mitigating fact (a poisoned binding surfaces to ops as an
escalating conflict rather than failing silently). An implementer who reads only
this paragraph and skips (g) will ship the hole.

**Processing order.** Step 1 runs on its own. **Steps 2–5 then all run inside a
single `SubscriptionMutationLockService.runExclusive(userId, …)` critical
section — the lock is acquired BEFORE the re-query, never between the re-query
and the write** (see the correction below the list). **Step 6 is inside the
critical section too** — see the correction on its own bullet for why filing a
reconciliation row after releasing the lock can refund a valid subscription. Only
step 7 follows the lock.

**The per-rider lock is not sufficient on its own — the ownership check and the
claim must ALSO be serialized across riders by the OTID lock.** Two _different_
riders concurrently submitting the same previously-unowned store transaction hold
**distinct** per-rider locks, so both pass the foreign-ownership check, both
publish their fences, and only then does the partial unique index reject one — by
which point the loser has already mutated its own row, breaking (d)'s
mutation-free contract before the conflict is even detectable.

`SubscriptionMutationLockService.runExclusiveByOtid` exists for exactly this and
survived the native deletion for exactly this reason; its retained doc says so:
_"the race is a property of the SHARED claim + unique index — not of that one
flow — so any future ingestion path that claims an Apple OTID must take it as
well."_ It applies to Google identities equally, since they share the same
partial-unique-index shape.

**Take it INSIDE the per-rider lock — rider → OTID, never the reverse**, which is
the ordering the native path used and the one that cannot deadlock. The OTID key
hashes the identifier (SHA-256) so it never reaches a Redis key or a log line.

**And assert the OTID lease immediately before claiming — holding two locks means
reasserting two leases.** `SubscriptionOtidLockLease` exposes its own
`assertHeld()` for exactly this. Rider-lease reassertion never covered it — and
**under the acquisition-stamping candidate**, where `publishFence()` is deleted,
nothing reasserts the rider lease implicitly either. That sharpens the point
rather than weakening it: **each lock needs its own explicit assertion, and
neither is the guarantee** — both are pre-flight optimisations, and the database
mechanism does the work.

**This holds whichever mechanism the harness selects, but its second clause is
candidate-specific.** If the selected mechanism retains a publication or any other
rider-side step, the store consumer takes **that** step too — the OTID assertion
does not replace it. Do not read this paragraph as licence to omit whatever
rider-side fencing the chosen design requires; that is how a lease-lost callback
keeps an admissible fence and commits stale state.

The gap that leaves: the OTID lease can expire **independently** after the
foreign-ownership read — the RevenueCat round trip sits inside this nesting, so
the window is not small. Another rider then legitimately acquires the OTID lock
and **also** observes the identity as unowned, while this stale callback races the
unique index on a rider fence its own still-valid lease let it advance. That is
precisely the mutation-before-ownership-conflict window the nesting was added to
close, reopened one level down. (Described in terms of a _fence publish_ until
2026-08-07; the race is unchanged, and under the acquisition-stamping candidate
the fence advances at acquisition so there is no separate publish step for it to
happen around. Under another mechanism the race is the same and simply happens
around that mechanism's step instead.)

So: `await otidLease.assertHeld()` immediately before the claim, not merely at
OTID-lock acquisition.

> **This sentence read "before the fence publish and the claim" until 2026-08-07.**
> There is no fence publish — acquisition stamping deleted it. The directive is
> struck rather than reworded because following it would have an implementer
> reinstate `publishFence()` in the one position every correction in this section
> rules out: immediately before the claim, mutating the submitting rider's row
> ahead of establishing ownership.

> **⚠️ NOT SUFFICIENT ON ITS OWN (corrected 2026-08-07). `assertHeld()` is a
> point-in-time check; the window it guards is not a point.** The lease can lapse
> between the assertion and the claim — a stalled fence UPDATE is enough — after
> which the next rider acquires the OTID lock while the old callback is still
> mid-sequence. The old callback has by then already mutated its rider's fence and
> can still lose the unique-index race, which is the mutation-before-conflict
> outcome this nesting exists to prevent. A **second** assertion after publication
> does not fix it either: it would detect the loss only _after_ the forbidden
> mutation. No number of TTL checks makes a multi-statement sequence atomic.
>
> **The mechanism must be continuously valid, which means the database, not
> Redis.** This exact class was solved on the native path and the solution was
> deleted with it in PR #1136 — `iap-validate.service.ts` ran the claim inside a
> short DB transaction taking `pg_advisory_xact_lock(hashtext(otidKey))`, with
> `SET LOCAL lock_timeout` / `statement_timeout` bounding it. Its own comment says
> why, and it is the requirement restated: _"a `pg_advisory_xact_lock` on the OTID
> means two riders' claim transactions for the same OTID can never interleave even
> if a Redis lease lapsed during the store I/O above … a timeout aborts the tx
> (retryable 503) rather than committing a claim after another rider already won."_
>
> An advisory **xact** lock is held by the transaction itself and released only at
> commit or rollback. There is no TTL to lapse, so the ownership window cannot
> expire mid-sequence. The transaction holds a pooled connection for one fast
> UPDATE with no API calls inside it, so it does not pin a connection across the
> RevenueCat round trip.
>
> **And on this path the fence is not published before the claim at all.** That is
> the second half of the native solution and the reason its ownership conflict was
> mutation-free _regardless of lease timing_ — nothing is written until the claim
> itself either succeeds or matches zero rows. It also removes the ordering
> problem that produced the last several corrections: with no pre-claim
> publication there is nothing to publish too early.
>
> So the shape step 5 must implement is: re-query → ownership check → **claim
> inside an OTID-advisory-locked, timeout-bounded transaction**, with the fence
> already stamped at lock acquisition and **no fence publish anywhere in the flow**
> (see the acquisition-stamping correction below, which supersedes every earlier
> statement in this document about when to publish). `otidLease.assertHeld()`
> stays as a cheap pre-flight that avoids entering the transaction on an
> already-lost lease, but it is an optimisation, not the guarantee.
>
> **⚠️ AND THE OTID LOCK IS STILL EXCLUSION WITHOUT ORDERING (2026-08-07).** The
> acquisition-stamping correction below concluded that `pg_advisory_xact_lock`
> serialises transactions but does not order them by who currently holds the
> lease. That conclusion was applied to the rider lock and **never propagated
> here** — the OTID prescription above still relies on exactly the mechanism the
> document rejects two sections later.
>
> The concrete case: callback A loses its OTID lease after the ownership read, B
> acquires it, but A reaches the advisory transaction first. A commits the identity
> to its rider, and B — the **live** holder, with the fresher re-query — loses the
> unique-index race.
>
> **Why it cannot be fixed the same way, and the asymmetry is the point.** The
> rider fix works because a rider **is a row**, so acquisition can stamp a durable
> generation on it. An OTID is a value, frequently not yet bound to anything —
> there is nothing to stamp. The analogue does not exist for free.
>
> **What it costs, stated precisely.** The uniqueness invariant is never violated:
> `uq_users_google_original_transaction_id` is a durable constraint and enforces
> one rider per identity whoever wins. The failure is a **wrong winner** — a
> stale-lease delivery binding the identity ahead of the live one — not
> corruption. That is materially weaker than the rider case, where the loser could
> clobber committed entitlement state, and the difference matters when weighing
> the options.
>
> Two candidates, and the harness picks — not this paragraph:
>
> - **A durable OTID generation.** A small table keyed by the hashed identifier,
>   bumped at OTID-lock acquisition and checked by the claim: the direct analogue
>   of the rider fence. Correct by the same argument, at the cost of new storage
>   and a write on every store claim.
> - **Accept exclusion-only and make the loser re-derive.** Cheaper, but it moves
>   the guarantee out of the lock and into `23505` handling — which means **open
>   item (d) stops being about observability and becomes load-bearing for
>   correctness.** Today (d) records that a cross-rider `23505` files nothing at
>   all; under this option the loser must instead re-query fresh state and, if it
>   should own the binding, transfer it. Do not choose this option without
>   resolving (d) that way in the same step.
>
> **Harness:** case (iv) already races two riders for the same unowned OTID.
> Extend it to assert the **live-lease holder wins in both schedules** — including
> when the stale holder reaches its transaction first. That assertion fails
> against advisory-lock-only, which is precisely its job.
>
> **⚠️ Take the advisory lock on the RIDER as well as the OTID (added
> 2026-08-07).** Deferring publication past the claim — correct, for the
> mutation-free reason above — opens a narrower window in its place: between a
> newer holder acquiring the rider lock and that holder stamping anything, a stale
> callback whose Redis lease has lapsed can still commit its claim. The fence
> guard cannot catch it, because nothing has raised the stored token yet.
>
> Note what is _already_ atomic and does not need fixing: the claim's own UPDATE
> both stamps `subscription_lock_fence` and guards on `stored <= :mine` in **one
> statement**, so a successful claim advances the fence indivisibly. The exposure
> is purely the un-stamped gap at the start of the newer holder's section.
>
> Close it the same way the OTID case was closed — in the database, not with
> another lease check. Take `pg_advisory_xact_lock` on the **rider** as well,
> inside the same bounded transaction, **rider then OTID** (the same order as the
> Redis locks, so the two orderings cannot form a cycle). Two claim transactions
> for one rider then serialise on a lock with no TTL, and the loser observes the
> winner's committed fence and is rejected by its own guard.
>
> The Redis rider lock keeps its job — serialising the _whole flow_ including the
> external re-query, which a PG lock cannot do without pinning a connection. The
> PG rider lock covers only the _commit window_. Two locks, two jobs, and the
> distinction is worth stating because it looks redundant otherwise.
>
> **⚠️ THE LOCK IS WORTHLESS UNLESS STRIPE TAKES IT TOO (added 2026-08-07).**
> The paragraphs above describe the rider advisory lock as if it were a property
> of the rider. It is not. `pg_advisory_xact_lock` excludes only transactions that
> _also request it_, and `pg_advisory` appears **nowhere** in the backend today —
> the live Stripe writer (`account.service.ts:608`) publishes its fence and later
> calls `claimForStripe` with no advisory lock at all. Adding the lock to the
> RevenueCat transaction alone therefore serialises store-vs-store and leaves
> store-vs-Stripe — the cross-provider case this whole section exists for —
> exactly as exposed as before.
>
> **The surviving window.** A store callback loses its Redis rider lease during
> the re-query. A Stripe webhook becomes holder N+1 and enters its critical
> section, but has not yet run `publishFence()`. In that gap the stale callback
> takes an uncontested advisory lock and commits its claim — its guard reads the
> _old_ stored token, so `stored <= mine` passes. Stripe then publishes, re-reads,
> finds a store-owned slot, and under the conflict rules may cancel or refund a
> **valid** Stripe subscription on the strength of a claim whose freshness the
> system had already given up on.
>
> **What the fix cannot be.** Not "wrap Stripe's fence-publish through its claim
> in the advisory transaction". Verified against the code: `getSubscription`
> (`account.service.ts:635`) and `getSubscriptionStatus` (`:1389`) are external
> Stripe HTTP calls sitting inside that span. Holding an advisory xact lock across
> them pins a pooled connection on network I/O — the exact objection that keeps
> the Redis lock in the design.
>
> **⚠️ EXCLUSION IS NOT ORDERING — the block that stood here is superseded
> (2026-08-07).** It prescribed routing every fence-touching statement through a
> shared rider-advisory helper. That is necessary and remains true, but it does
> not close the race, and the reasoning error is worth naming: a lock guarantees
> the two transactions do not _overlap_; it says nothing about which runs
> **first**. If the lapsed store callback reaches the lock before holder N+1
> reaches its publish, it acquires cleanly, reads a stored token still at the old
> value, passes `stored <= mine`, and commits. N+1 then publishes into a
> store-owned slot and may compensate a valid Stripe subscription. Case (vi)'s
> expected rejection was resting on scheduling.
>
> **The actual defect, found by reading the lock service.** `mintFenceToken`
> (`subscription-mutation-lock.service.ts:311`) issues the token with
> `SELECT nextval('subscription_lock_fence_seq')` — a **global sequence**. It never
> touches the rider's row. `users.subscription_lock_fence` therefore keeps the
> _previous_ holder's value until somebody calls `publishFence()`, which happens
> arbitrarily far into the flow. So "who currently holds the rider lock" has no
> durable representation the claim can see. The token is a fencing token that
> nobody has fenced with yet.
>
> **The fix: stamp at acquisition, in one statement.** Replace the bare `nextval`
> with
>
> ```sql
> UPDATE users
>    SET subscription_lock_fence = nextval('subscription_lock_fence_seq')
>  WHERE id = $1
> RETURNING subscription_lock_fence
> ```
>
> Minting and stamping become the same atomic act, so the row reads N+1 from the
> moment N+1 stamps rather than from the moment it eventually publishes. That is a
> large improvement and **not** the complete guarantee this paragraph originally
> claimed — the acquire-to-stamp window survives, and the stamp must be guarded
> rather than unconditional. Read the P1 correction below before implementing any
> of this. (Rider deleted → 0 rows → fall back to a bare `nextval` so the flow
> still has a token and proceeds to its ordinary early-out, exactly as
> `publishFence()` tolerates a missing row today.)
>
> **⚠️ THE "EVERY INTERLEAVING" CLAIM ABOVE IS FALSE, AND THE UNCONDITIONAL
> STAMP IS A REGRESSION (2026-08-07, P1).** Two separate problems, both real.
>
> **1. Redis acquisition and a Postgres UPDATE cannot be made atomic.**
> `runExclusive` completes `acquire()` and only then calls `mintFenceToken`
> (`subscription-mutation-lock.service.ts:193` then `:212`). A stale callback can
> still commit inside that window. The gap shrank from _"spans the whole external
> re-query"_ to _"one DB round trip"_ — it did not close, and no arrangement of
> these two systems closes it. Delete the phrase "on every interleaving" wherever
> it appears above; it was wishful.
>
> **2. An unconditional `SET fence = nextval(...)` inverts the ordering.** The
> lock service already documents this hazard at `:197-202` — a slow mint lets the
> TTL lapse, another replica acquires and writes with a _lower_ token, and the
> late minter's _higher_ token clobbers it — and mitigates it with
> heartbeat-before-mint plus `assertHeld` immediately after. Folding the stamp into
> the mint defeats that mitigation: the stalled holder now **writes** the higher
> token to the row before `assertHeld` aborts it, leaving the row poisoned above
> the legitimate holder, which is then locked out of its own writes until it 503s
> and redelivers. A caught-and-aborted case becomes a durable one.
>
> **The root cause of both: the design keeps trying to make token order match
> lock-acquisition order across two systems.** That invariant is stated verbatim
> at `:209-211` and everything above has been an attempt to shore it up. It cannot
> be shored up.
>
> **Leading candidate: stop comparing tokens.** Guard on **equality** —
> `WHERE subscription_lock_fence = :mine`, meaning _"I am still the most recent
> stamper"_ — instead of `<=`. Ordering then becomes irrelevant, because the
> question is never "is my token higher?" but "has anyone stamped since me?", and
> stamps serialise on the `users` row lock. Whichever flow stamped last wins;
> every other flow's writes no-op. That is interleaving-independent in a way the
> `<=` comparison cannot be, because it never relies on the sequence meaning
> anything.
>
> Cost, stated honestly: seven `<=` guards in `provider-claim.service.ts`
> (`:241, :337, :407, :530, :766, :984` and the `<` in `publishFence`) plus the
> lock service, and stricter rejection means more retryable 503s under contention.
> Both are acceptable — 503s redeliver — but neither is free.
>
> **⚠️ AND THE EQUALITY CANDIDATE HAS A KNOWN HOLE (2026-08-07).** It was offered
> above as interleaving-independent. It is — in the weak sense that exactly one
> flow wins. It does **not** guarantee the **live** holder wins. Equality means
> _last stamper wins_, and under the forced acquire-to-stamp stall the harness is
> required to exercise, the stale holder can stamp **last**: A acquires and
> stalls, A's lease lapses, B acquires and stamps, A resumes and stamps. Equality
> then names A the winner.
>
> That is the same shortcoming recorded for the OTID lock — exclusion and
> uniqueness without ordering — reappearing in the rider mechanism I proposed to
> replace it. It does not disqualify the candidate; it means the candidate needs
> either additional machinery or a rejection at the stamp itself, and the harness
> must decide which. **Nothing that presumes this candidate belongs in the
> authoritative delivery row**, including deleting `publishFence()`: that deletion
> is part of the candidate, not a settled fact, and §12 now says so.
>
> **⚠️ AND THE ACCEPTANCE CRITERION ITSELF WAS THE PROBLEM (2026-08-07).** Every
> candidate below was measured against "the stale writer loses in **both**
> orderings", including the ordering where nothing durable yet distinguishes the
> two writers. That is unachievable, so each candidate failed in turn and each
> failure looked like a flaw in the candidate. INV-A has been restated in §8:
> ownership changes at a **durable handoff**, writes before it are the prior
> owner's legitimate tenure and get superseded, writes after it are rejected.
> **Re-evaluate the candidates against the restated invariant before assuming any
> of them is dead** — several were rejected for failing a test nothing could pass.
>
> **✅ SHIPPED — and `publishFence()` is GONE, replaced by `assertFenceCurrent()`
> (2026-08-08).** The app is not deployed to prod or staging, so the
> rolling-deploy staging that deferred this no longer applies and breaking
> changes are allowed. Every earlier "deferred because it touches live code"
> qualification in this section should be read in that light.
>
> The removal is not a plain delete, which is why it was worth doing rather than
> dropping the calls. `publishFence` did **two** jobs: stamp the fence, and abort
> with a retryable 503 if a newer holder was ahead. Acquisition-stamping makes the
> first redundant — it had become a no-op rewrite of the row's own value, and its
> `< token` guard rejected the legitimate holder until it was relaxed. The second
> is still worth having, as an **early** abort before the flow's external
> re-query, so a lost-lease holder stops before paying for the work rather than
> failing at its first guarded write.
>
> So the lease now exposes `assertFenceCurrent()`: Redis lease check first (a lost
> lease is decisive on its own, so the DB round trip is skipped), then a
> read-only `SELECT 1 ... WHERE subscription_lock_fence > :token`. Nothing writes.
> Both call sites — the Stripe handler and notification delivery — call it in the
> same place they used to publish.
>
> **✅ THE HARNESS HAS RUN, AND IT SELECTED ACQUISITION-STAMPING (2026-08-07,
> PR for #1138).** `test/subscription-fence-ownership.e2e-spec.ts` exists against
> real PostgreSQL and real Redis. Case (i) — a lease-lost holder writing after a
> successor has merely ACQUIRED — failed on the old mechanism with `claimed`,
> confirming the defect at last empirically rather than by argument. With the
> mint changed to `UPDATE users SET subscription_lock_fence = nextval(...)
RETURNING`, all four store-free cases pass.
>
> Two findings the harness produced that no amount of reading had:
>
> 1. **The correct outcome for a stale holder is a retryable 503, not
>    `'conflict'`.** `assertSubscriptionFenceCurrent` already fires once the
>    successor has written. Asserting `'conflict'` — as the first draft of the
>    harness did — would have encoded the misclassification this document warns
>    about, filing a reconciliation row against a valid subscription.
> 2. **`assertSubscriptionFenceCurrent`'s own doc states the flawed premise.** It
>    says `fence > token` "can only happen if our lease was lost (only the lock
>    holder ever publishes a fence)". True — but a successor that has not written
>    yet has published nothing, so the lost lease was undetectable in exactly the
>    window that mattered. The code documented its own gap.
>
> **The residual hole stands, and review sharpened what it costs.** A holder
> stalling between acquiring and stamping still stamps a later token than its
> successor — and the consequence is worse than that holder looking current: its
> stamp **fences out the live holder**, whose legitimate guarded writes then fail
> as stale, possibly after it has already committed a state transition, producing
> retries or lost transition notifications.
>
> **The cause is precise, and so is the fix.** The token comes from `nextval` at
> STAMP time, so token order is stamp order — not acquisition order. Nothing that
> orders by stamp time can fix this, including `fence + 1` on the row: a
> late-resuming acquirer stamps last and therefore highest either way. The token
> has to be issued **by the acquisition**: a Redis `INCR` performed atomically
> with `SET NX PX` in one Lua script, with the DB stamp then guarded
> (`WHERE fence < :token`) so a stale acquirer's lower token simply loses.
>
> **Its cost is a real trade-off, which is why it is a separate decision.** That
> makes correctness depend on the durability of a Redis counter: a flushed Redis
> would issue tokens below the stored fences and reject every write until the
> counter is reseeded from the row. Deciding that belongs with the rest of 4.75,
> not bolted onto the PR that already produced two regressions in this mechanism.
>
> Encoded as `it.failing` in the harness rather than left as prose — CI stays
> green while the gap is open, and the suite breaks the moment it is closed.
>
> **Step 4.75 is NOT complete.** This is the fence half only. The rider row lock
> in the claim transaction, the `sbr_resolution_check` migration, retirement on a
> successful Stripe claim, and the transaction-safe reconciliation dedup all
> remain.
>
> **⚠️ STOP DESIGNING THIS IN PROSE.** Six consecutive review rounds have now
> produced six answers, each of which found a real hole in the one before:
> Redis TTL → OTID advisory lock → rider advisory lock → reconciliation inside the
> transaction → shared helper across providers → stamp at acquisition. Every one
> looked correct when written. The equality guard above is the seventh and is
> offered as a **candidate, not a conclusion**.
>
> **Step 4.75 therefore starts with the test harness, not the fix.** Build the
> concurrency harness first — real Postgres, real Redis, both orderings of every
> case in §8, including a forced stall between `acquire()` and the stamp — and let
> it adjudicate. A design this review has been wrong about six times in a row is
> not one to settle with a seventh paragraph.
>
> **`publishFence()` then has nothing left to publish, and is deleted — IF this
> candidate is what the harness selects.** That conditional is not decoration:
> the candidate has a known stale-holder hole (recorded below), so another
> mechanism may win, and deleting the live Stripe publication path before its
> replacement is defined would remove a working guard for an unproven one. §12
> states the same condition. Note what
> that dissolves: four review rounds argued over whether it runs first, after the
> re-query, before the writes, or after the claim. All four were arguing about
> where to place a statement that should not exist — the ordering question was an
> artifact of stamping late. Nothing orders correctly because nothing needs
> ordering.
>
> Two consequences worth stating so they are not rediscovered:
>
> - **~~The rider advisory lock becomes unnecessary.~~ WRONG — corrected
>   2026-08-07, see below.** The argument was: the acquisition stamp and every
>   guarded write are single-statement UPDATEs on the same `users` row, so they
>   serialise on the row lock, and under READ COMMITTED a blocked UPDATE
>   re-evaluates its `WHERE` against the committed new row version. All true, and
>   it silently assumes the statement **matches a row**.
>
>   **A guarded UPDATE that matches zero rows takes no lock at all.** It touches
>   nothing, so it serialises against nothing. The conflict branch is exactly the
>   zero-row case: the store claim finds a Stripe-owned slot, affects 0 rows, holds
>   no lock — and then files the reconciliation row. Stripe can clear its slot and a
>   redelivery can claim successfully in that window, leaving an actionable conflict
>   row against a now-**valid** store subscription. That is the round-22 defect,
>   reintroduced by removing the lock.
>
>   The general form is worth keeping: **any decision derived from a zero-row
>   result needs explicit locking, because zero-row results are not serialised by
>   anything.** Implicit row locks protect winners; losers are unprotected, and the
>   loser is who files reconciliation.
>
>   **Take the rider row lock unconditionally instead.** Open the claim transaction
>   with a bare `SELECT 1 FROM users WHERE id = $1 FOR UPDATE` — same row, real row
>   lock, held to commit whether or not the claim matches, no separate lock
>   namespace. That makes "the row lock does the job" literally true rather than
>   accidentally true. `pg_advisory_xact_lock(rider)` is an equally valid
>   alternative; pick one in the harness, not here. Either way, **rider before
>   OTID**.
>
>   Keep the **OTID** advisory lock regardless: it protects a cross-row uniqueness
>   invariant no single row lock covers. Keep the reconciliation insert inside the
>   claim transaction (§4 step 6).
>
>   Implementation note: it must be a **bare** `SELECT … FOR UPDATE` on `users`,
>   not a TypeORM `find` with relations plus a pessimistic lock — that combination
>   fails on real Postgres and unit tests that mock the manager do not catch it.
>
> - **Every acquisition now mutates the rider's row, including flows that reject
>   mutation-free.** This was the objection that pushed publication later in the
>   first place, and it does not survive scrutiny: `subscription_lock_fence` is an
>   internal concurrency column, not entitlement state. Bumping it grants,
>   revokes, and changes nothing, and a flow that would be locked out by the bump
>   is by construction one that acquired the lock earlier and therefore holds a
>   lower token legitimately.
>
> **This changes live, merged code — it is not new step-5 code.** It rewrites
> `mintFenceToken` and — **conditional on the harness selecting this candidate** —
> deletes `publishFence()` and its call sites in the Stripe handler. Track it as its own change with its own real-Postgres concurrency test,
> and land it **before** the step-5 consumer: step 5's claim relies on the stored
> fence identifying the current holder, which is not true of the system as it
> stands today.
>
> _Worth noticing the direction of travel:_ four consecutive rounds have moved
> another piece of this guarantee from Redis to Postgres. That is a signal, not a
> coincidence — a TTL lease is the right primitive for holding a section across
> external I/O, and the wrong one for making a commit atomic. **Step 5 should
> validate this against real Postgres and Redis rather than trusting the prose**;
> it is the part of this design most likely to still be subtly wrong, and the only
> honest way to find out is a concurrent test with a deliberately expired lease.
>
> _This is the third capability lost with the native deletion_ (after (c)'s
> three-way classification and the retained-OTID handling): a solved,
> heavily-reviewed concurrency pattern whose only implementation is now in git
> history. Retrieve it with
> `git show d2d337a5:apps/backend/src/modules/account/iap-validate.service.ts`
> and read around the claim transaction rather than re-deriving it — this
> correction exists because a weaker Redis-only version was re-derived from
> scratch two rounds ago.

Required coverage: **OTID lease lost after the ownership read**, asserting the
stale callback claims nothing; and **two riders claiming the same identity
concurrently**, asserting the loser's **entitlement and identity columns** are
unmutated — the latter is the one a lease-based test cannot express, because it is
the database lock that makes it true.

> **Narrowed 2026-08-07:** this said "the loser's row is unmutated", which now
> contradicts the acquisition-stamping design — every acquisition bumps
> `subscription_lock_fence`, including flows that reject mutation-free, and §8
> requires asserting that bump. Assert on tier, status, period end, provider, and
> the store identity columns; **not** on the fence, and not with a whole-row
> comparison. Left as-is these were mutually exclusive acceptance criteria for
> step 4.75.

**Under the leading candidate there is no fence publish in this flow at all — the
fence is stamped when the lock is acquired. Under any other mechanism, the store
flow adopts whatever fence discipline that mechanism defines; it does not simply
omit one.** (Made conditional 2026-08-07 — this rule was left unconditional when
the deletion directives around it were qualified, and it is the **operative** one:
it is what an implementer follows.) Mutual exclusion alone does not close the
lease-loss race: if Redis heartbeat renewals fail during the RevenueCat round trip
the lease expires, another delivery acquires the lock, and a stale callback could
still write with its lower fence token.

What closes that race is that acquiring the rider lock **is** stamping
`users.subscription_lock_fence` — one statement, per the acquisition-stamping
correction below — with the important caveat that the acquire-to-stamp window
survives it, so the guard must ask "has anyone stamped since me?" rather than
compare token magnitudes. The claim's own UPDATE re-stamps and re-guards in one statement, so
a successful claim also advances the fence indivisibly.

Do **not** reintroduce a `publishFence()` step here in any position **while
acquisition stamping is the selected mechanism** — four review rounds argued over
where it belonged, and the answer under that candidate is that stamping late was
the defect, so the statement should not exist.

**If the harness selects something else, this prohibition lapses with it.** The
store flow must then take whatever the selected mechanism requires — including a
publication step, if that is what wins. What must never happen is the store flow
running with **no** fence discipline because a rule written for one candidate
outlived it: a lease-lost callback would keep an admissible lower token and commit
after the live holder, which is the corruption this whole section exists to
prevent. **The rule is "match the selected mechanism", not "omit the publish".**

> **This paragraph said the opposite four times before settling here** — that
> publishing was unnecessary, that it must come _first_, that it must precede the
> _writes_, then that it survived as a fallback for no-op flows. Each revision was
> corrected by the next, and the fallback claim is superseded too: the
> acquisition-stamping correction **deletes `publishFence()` outright if it is
> selected** (§12 keeps that conditional), so under it there
> is no no-op-flow case left for it to serve — under that candidate the fence
> advances at acquisition, whether or not the flow writes anything.
>
> Retaining it "just for no-op flows" would keep the late-stamping path alive and
> with it the whole lease-loss/ordering problem the redesign exists to remove.
> There is no placement of this call that is correct; that is the point.

> **⚠️ WHOLLY SUPERSEDED — kept only as the record of a four-round argument about
> where to put a call that is now deleted.** Nothing below prescribes anything.
> The reasoning is preserved because the JSDoc it quotes is still in the tree and
> a future reader will hit it; the conclusion is not.
>
> `SubscriptionLockLease.publishFence()` documents its own placement: _"call it
> once the flow has COMMITTED to acting (i.e. AFTER its mutation-free rejects:
> verification, account binding, foreign-ownership). It is NOT published at lock
> acquisition, so a request that rejects mutation-free never writes the row (the
> ownership-conflict contract)."_
>
> Publishing first would therefore write `subscription_lock_fence` on the
> **submitting** rider's row before the consumer can discover the transaction
> belongs to **someone else** — directly violating (d)'s requirement that an
> ownership conflict mutate neither rider's row. That requirement is not
> incidental: the whole reason a foreign-ownership case must touch nothing is
> that the submitter is not proven to own the purchase.
>
> **Why Stripe legitimately differed** (historical — step 4.75 removes the
> difference by deleting the publish on both sides). Stripe publishes before its re-read
> because its decisions rest on that **database** re-read, which a lower-token
> straggler could corrupt between the read and the publish. The RevenueCat
> consumer's decisions rest on the **RevenueCat re-query** — external state no
> straggler can alter — and its only DB reads are the guards inside the atomic
> UPDATEs themselves. Stripe also has no foreign-ownership case: a Stripe
> subscription belongs to the customer already resolved. The Apple path, which
> _did_ have foreign OTIDs, deferred publication for exactly this reason, and
> RevenueCat inherits that hazard via (d)'s transfer case.
>
> So both constraints hold simultaneously, and neither needs weakening.

> **⚠️ THE INBOX CANNOT RECOVER AN EVENT IT NEVER RECEIVED — scheduled
> reconciliation is required and was omitted (2026-08-07, P1).** Everything in this
> section, and the lease and sweeper added above it, assumes an inbox row exists.
> If the backend or database is unavailable for the whole of RevenueCat's retry
> schedule, **step 1 never runs**: no row, nothing to sweep, no dead letter, no
> alert. The event is simply gone, and with it a purchase that keeps billing
> without entitlement, or an expiry or refund that leaves paid access live
> indefinitely.
>
> **The audit already required this and the design carried three of its four
> parts.** It asks for "pending-before-processing persistence, dedup,
> exhausted-retry alerting, and a **scheduled reconciliation**"
> (`payments-subscriptions-audit.md:271-272`), precisely because a managed provider
> does not make Tarmoto's own consumer reliable. The first three are here; the
> fourth appeared nowhere in this document.
>
> **Client polling and restore do not cover it.** Both re-read _Tarmoto's_ state;
> neither causes the backend to re-query RevenueCat, so a rider whose event was
> lost sees the wrong answer no matter how often the app asks.
>
> Two mechanisms, and the cheap one is not sufficient alone:
>
> - **Scheduled drift reconciliation (required).** Periodically re-query
>   authoritative RevenueCat state for riders whose local state is suspect —
>   store-provider riders whose `subscription_current_period_end` has passed
>   without an event, and riders holding an entitlement with no recent event —
>   and apply it through the same claim path. Bounded and rate-limited; this is a
>   backstop, not a polling architecture. **These cohorts only cover riders with
>   existing local store state — see the first-purchase correction below.** Whether
>   RevenueCat exposes a changed-since or event-replay listing is a **fourth
>   question for the step-4.5 spike**, and not merely a cost question.
> - **Client-triggered repair (cheap, targeted, not a substitute).** When the
>   mobile SDK reports an entitlement the backend does not have, or the reverse,
>   let the client call an authenticated endpoint that forces a re-query for that
>   rider. This turns the next app open into a repair for exactly the affected
>   riders. It cannot stand alone: it never fires for a rider who has stopped
>   opening the app, which is precisely the rider still being billed for
>   entitlement they cannot see.
>
> **⚠️ NEITHER MECHANISM AS WRITTEN CAN REPAIR A LOST _FIRST_ PURCHASE
> (2026-08-07, P1).** Both cohorts above — store-provider riders past their period
> end, and riders holding an entitlement with no recent event — presuppose the
> rider **already has store state locally**. A rider whose very first purchase
> event was lost is still `free`, with no provider and a NULL identity, so neither
> cohort selects them. And discovery alone would not be enough: `claimForStore`
> needs an `original_transaction_id`, the subscriber API does not return one, and
> the local column is NULL. **Both halves fail — the rider is invisible, and
> unclaimable even once seen.** That is also the worst case in the set: a rider
> billed from day one who never receives anything.
>
> So the backstop needs a **discovery-and-identity source**, and it must be
> **server-side**. The client-supplied path below is an **accelerant, not an
> alternative** — a point this block already makes about client-triggered repair
> and then contradicted by listing it as one of two options (corrected
> 2026-08-07). If the rider closes the app and never returns, a client-driven
> mechanism never fires, and that rider is exactly the one still being billed for
> entitlement they cannot see.
>
> **Server-side, one of these — required:**
>
> - **A RevenueCat changed-since or event-replay listing.** Webhooks carry
>   `original_transaction_id`, so a replay API would supply both discovery and
>   identity in one. This was listed above as a **cost optimisation** for the
>   sweep; it is not — for first purchases it is the mechanism. Its spike question
>   is correspondingly load-bearing: if RevenueCat has no such surface, this option
>   is gone rather than merely more expensive.
> - **A purchase-intent ledger, written before the store call.** If RevenueCat has
>   no replay surface, this is the fallback that does not depend on one: the client
>   registers "this rider is about to buy product P" with the backend **before**
>   invoking the store, creating a durable row. A webhook that never arrives then
>   leaves an **outstanding intent** — precisely the discovery signal the cohorts
>   lack, and it exists whether or not the rider ever reopens the app. Needs an
>   expiry for abandoned purchases (most intents never complete, and that is
>   normal), and costs one round trip before purchase.
>
>   **⚠️ It solves DISCOVERY and not IDENTITY, and nothing server-side solves both
>   without a replay source (2026-08-07).** A row written before the purchase
>   cannot contain an `original_transaction_id` — the purchase has not happened.
>   And there is no server-side way to obtain one afterwards: the subscriber API
>   omits it, and both stores' own lookup APIs are themselves keyed by an
>   identifier we do not have (Apple by original transaction or order id, Play by
>   purchase token). That is a genuine constraint, not a gap in this paragraph.
>
>   **So the degraded path, when there is no replay source:** discovery finds the
>   rider via the outstanding intent, the re-query confirms **that they are
>   entitled** even though it cannot say **what the subscription is called**, and
>   the repair **grants the entitlement with a NULL identity binding**. The next
>   store event for that rider — a renewal arrives within one billing period —
>   binds the identity through the claim's `IS NULL` branch.
>
>   Two things must be said about that plainly. It **restores the rider's access**,
>   which is the failure being repaired and strictly better than leaving a paying
>   rider on `free`. And it leaves the slot unbound for up to one period, which is
>   **exactly the lazy-rebind hole recorded in (h)** — a terminal event arriving in
>   that window matches nothing. It must be closed the same way (h) requires, and
>   this path must not ship before it is.
>
>   This makes the replay-source question **the difference between full repair and
>   a bounded-exposure workaround**, not a cost question — which is why the spike
>   records a missing identity field as a negative answer.
>
> **And separately, as an accelerant only:**
>
> - **A client-supplied claim.** The device already holds the identity — StoreKit 2
>   exposes the transaction's `originalID`, Play Billing the purchase details — so
>   an authenticated endpoint can accept it and repair the rider directly. §5's
>   poll-until-reflected already detects the failure; today it only waits, and this
>   gives it somewhere to escalate to. It makes recovery **fast** for a rider still
>   in the app; it cannot make recovery **guaranteed**, so it does not discharge the
>   server-side requirement above.
>
>   **But it is the forged-binding surface of open item (g), by construction:** a
>   client-supplied identifier for a rider whose identity column is NULL is exactly
>   the poisoning case (g) records. It must be authenticated, and the backend must
>   confirm against its own re-query that this rider genuinely holds an entitling
>   subscription before binding anything the client asserted. **(g)'s chosen
>   mitigation governs this path too** — do not build it as an independent
>   endpoint with its own rules.
>
> **Coverage, corrected:** an outage lasting past the provider's retry window,
> asserting the rider converges to correct state **with no webhook ever
> delivered** — run for a **renewal** (local store state exists) _and_ for a
> **first purchase** (nothing local at all). The first-purchase case must converge
> **with no subsequent client call** — that is the only version of the test a
> client-only mechanism fails, and therefore the only one that proves the
> server-side source exists. It stays unimplementable until that source is chosen,
> which is deliberate: the gap should surface as a failing test rather than as an
> untested path.

1. **Persist `pending` before any side effect.** Insert into
   `processed_store_notifications` keyed `(provider, notification_id)` where
   `provider` is derived from the event's `store` and `notification_id` is
   RevenueCat's event `id`. A duplicate delivery of an event whose row has
   already reached `completed` hits the unique constraint and short-circuits
   as already-seen.

   This must distinguish `completed` from `pending` at the retry boundary:
   **a redelivery of an event whose inbox row is still `pending` is NOT
   already-seen and must remain re-claimable, never short-circuited.** A
   `pending` row means the prior attempt crashed, timed out, or is a
   concurrent in-flight delivery of the same event — not that the event was
   handled.

   > **⚠️ "Re-claimable" means CLAIMED UNDER THE LEASE, not simply processed
   > (2026-08-07).** The row already carries `locked_by` and `lease_expires_at`
   > backing a lease-based worker claim
   > (`processed-store-notification.entity.ts:45-49`, indexed by
   > `idx_psn_status_lease`), and this rule never mentioned them — so as written,
   > two overlapping deliveries of the same event both proceed. A late **failing**
   > handler can then overwrite a successful handler's `completed`/redacted row
   > with a failure, resurrecting an event that already applied.
   >
   > The pending branch therefore splits in two, and only the second is a retry:
   >
   > - **Lease live** (`locked_by` set and `lease_expires_at` in the future) — a
   >   handler is genuinely in flight. Do **not** process, and **respond
   >   retryably — never acknowledge.** Redelivery _is_ the recovery mechanism: if
   >   this duplicate returns success and the in-flight original then crashes,
   >   RevenueCat has no reason to send the event again, the row stays `pending`
   >   forever, and the purchase, expiry, or refund never applies. (Corrected
   >   2026-08-07: this branch said "acknowledge or requeue", which permitted
   >   exactly that.)
   > - **Lease absent or expired** — claim it atomically (`UPDATE … SET
locked_by = :me, lease_expires_at = … WHERE id = :id AND (locked_by IS NULL
OR lease_expires_at IS NULL OR lease_expires_at < now())` — the shared,
   >   null-safe predicate, see the sweeper note below — proceeding only on a
   >   non-zero row count), and
   >   **condition every completion, failure, and dead-letter update on
   >   `locked_by = :me`** so a handler whose lease expired mid-flight cannot write
   >   the outcome of work someone else has since redone. This is the same
   >   own-the-write discipline the fence applies to `users`, on a different table.
   >
   > **And a pending-row sweeper is required, because redelivery is finite.**
   > Verified: the only inbox job is `pruneCompletedInbox`
   > (`jobs/processors/store-reconciliation.processor.ts:212-229`), which deletes
   > `completed` rows past retention and explicitly retains `pending`. Nothing
   > reclaims an expired lease — `lease_expires_at` is read **nowhere** in the
   > backend outside the entity and its migration, so today it is dead metadata.
   >
   > A retryable response covers the window while RevenueCat is still retrying;
   > once it exhausts its schedule, only a sweeper recovers the row. Step 5 adds
   > one: select `status = 'pending'` with an **absent or expired** lease, re-claim
   > under the same atomic predicate as a fresh delivery, and process. Without it,
   > the "expired-lease row is reclaimed" test passes only when another delivery
   > happens to arrive — which is not a guarantee, it is luck.
   >
   > **Absent, not just expired — `lease_expires_at < now()` alone is a bug
   > (corrected 2026-08-07).** Postgres evaluates `NULL < now()` as **unknown**, so
   > that predicate silently skips every row whose lease was never established —
   > and that state is reachable: both lease columns are nullable and a process can
   > crash after inserting the inbox row but before claiming it. Those rows would
   > sit `pending` forever once RevenueCat stops redelivering, which is precisely
   > the failure the sweeper was added to prevent.
   >
   > **Use one predicate, defined once, in both places.** The claim branch and the
   > sweeper drifted because the same condition was written twice; express it as
   > `(locked_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())`
   > and share it. Phrasing the null check on `lease_expires_at` keeps
   > `idx_psn_status_lease` usable — btree indexes store NULLs, so an
   > `IS NULL OR <` disjunction on the indexed column stays index-backed, which a
   > check on `locked_by` alone would not be.
   >
   > §8's requirement is correspondingly not "every pending row is retried" — that
   > phrasing is what let the live-lease branch go unwritten. Add **two concurrent
   > deliveries of one event**, asserting exactly one processes and that the loser
   > cannot overwrite the winner's completed row. Treating any unique-constraint hit as "done" would silently drop
   > an event that never actually applied. The insert path therefore needs an
   > explicit existence-and-status check (or an `INSERT ... ON CONFLICT` that
   > only short-circuits when the existing row's status is `completed`), not a
   > bare "unique constraint violation means duplicate" catch. This is the
   > precise rule the failure-handling paragraph and the stale-fence paragraph
   > below both assume but never state outright.

2. **Re-query authoritative state — with the per-rider lock already held.** Call
   RevenueCat's subscriber API for the `app_user_id` and apply **that**, never
   the event body. This is the audit's overarching ordering rule: the event type
   is a trigger, not a state.
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

4. **Apply under the per-rider lock.** The lock is already held — entered ahead
   of step 2 — so this step is the guarded UPDATE itself: **`claimForStore(provider,
originalTransactionId, fields)`** with the lease's `fenceToken`. Exclusivity,
   the fence, and the atomic trial stamp come for free.

   **Not `claimForApple` / `claimForGoogle`.** Open item (a) collapses both into
   one converged claim, and this list named them until the review of PR #1136.
   `claimForApple` in particular **cannot** be fed by this consumer at all: it
   requires Apple's JWS `signedDate`, which RevenueCat never carries, and
   aliasing the read-time `request_date_ms` into that parameter is explicitly
   forbidden — it would silently downgrade a documented state-monotonicity
   guarantee while the method's own doc kept claiming it. Implementing this list
   literally would therefore either not compile or quietly reintroduce that lie.
   See (a) for what `claimForStore` keeps and drops, and (f) for the one part of
   its identity guard that is still unsettled.

5. **Terminal states** (expiry, refund, revoke, billing-issue exhaustion) route
   through the **converged terminal clear** — identity-guarded, never an
   unconditional clear, and **nulling** the store identity for both providers
   (§3's correction; retention is what caused the re-subscribe lockout PR #1134
   fixed). Not `clearAppleTerminal` / `clearGoogleTerminal`, for the same reason
   as step 4 — and note (c): the three-way zero-row classification that
   `IapValidateService` used to provide must be rebuilt onto this converged clear,
   because #1136 deleted the only implementation of it.
6. **Lost claims are reconciled, not swallowed.** When the atomic claim loses —
   Stripe or another store already owns the slot — open a
   `store_billing_reconciliations` row rather than acknowledging a no-op. A
   proven-losing purchase that keeps billing with no entitlement is the failure
   this prevents. Read "loses" strictly as **exclusivity/ownership**: a zero-row
   result from the read-ordering predicate is not a lost claim and must not be
   filed here — see the correction below. The cross-rider `23505` case is a third
   thing again, and files nothing at all (open item (d)).

   > **⚠️ This step runs INSIDE THE ADVISORY-LOCKED CLAIM TRANSACTION — not
   > merely inside `runExclusive` (corrected 2026-08-07, superseding the earlier
   > same-day correction below).** The list originally placed steps 6–7 outside
   > the critical section, treating reconciliation as post-processing. It is not
   > — it is a decision that concurrent state can invalidate.
   >
   > The race: the claim loses, the lock releases, and **before** the row is
   > filed a Stripe terminal event clears the slot and a store redelivery claims
   > it successfully. The first callback then files an `exclusivity_conflict`
   > against a purchase that is now the rider's **valid, entitling**
   > subscription — and under the audit's closeout rules an operator draining
   > that queue may refund or revoke it. Nothing cleans the row up, because a
   > later successful claim has no reason to look for one — **and that omission is
   > the real defect, not the width of the window; see the retirement correction
   > below.**
   >
   > **`runExclusive` alone does not close it.** That was this correction's first
   > answer and it was wrong for the same reason the claim's own atomicity
   > correction was needed: the Redis lease can lapse mid-flow, and the rider
   > advisory lock is held only for the duration of the claim transaction. A
   > conflicting claim commits nothing and stamps no fence, so that transaction
   > ends and releases both PG locks while this callback is still notionally
   > "inside" a Redis critical section it may no longer own. The window the
   > correction set out to close reopens in full.
   >
   > **The insert must therefore be issued on the same `manager` as the claim,
   > before that transaction commits** — inside `pg_advisory_xact_lock(rider)`,
   > which no TTL can expire and which the winning claim must also hold. The
   > classification and the row it produces then commit together or not at all,
   > and any flow that could invalidate the classification is serialised behind
   > the same lock. It is a fast local write with no external I/O, so it does not
   > meaningfully extend the transaction.
   >
   > Concretely, the transaction body is: **rider row lock** (`SELECT 1 FROM users
WHERE id = $1 FOR UPDATE`, or `pg_advisory_xact_lock(rider)` — the harness
   > picks) → OTID advisory lock → `claimForStore` → **if `'conflict'`, insert the
   > reconciliation row** → commit. `claimForStore` returning `'conflict'` must not
   > throw, or the insert rolls back with it.
   >
   > **The rider lock is not optional here, and not redundant with the row lock the
   > claim's own UPDATE takes.** A conflicting claim matches **zero rows** and
   > therefore takes no lock at all, so without an explicit one the conflict branch
   > runs unserialised — Stripe clears its slot, a redelivery claims it, and this
   > transaction files an actionable conflict against a now-valid subscription.
   > Taking the lock unconditionally at the top is what makes the classification and
   > the row it produces genuinely atomic. See the zero-row correction in the P1
   > block above.
   >
   > **⚠️ AND THE EXISTING DEDUP CANNOT BE REUSED AS-IS INSIDE THAT TRANSACTION
   > (2026-08-07).** Moving the insert inside the claim transaction broke the
   > mechanism that made it idempotent, and the breakage is silent at the type
   > level.
   >
   > `openConflict` (`store-reconciliation.service.ts:132-168`) inserts, catches
   > `23505` from `uq_sbr_open_apple_otid_reason`, and re-queries with
   > `findOpen(..., manager)` to return the winner's row. That works in autocommit.
   > **Inside a transaction it cannot**: Postgres marks the transaction aborted on
   > the unique violation, so the recovery query fails with `25P02` — the
   > notification then retries instead of committing its classified conflict, which
   > is the opposite of the no-op the design promises. `openConflictWith`, the
   > transaction-bound variant the account-deletion path uses, has **no dedup at
   > all** and simply propagates, so it cannot be reused here either.
   >
   > Two rules the replacement must satisfy, both load-bearing:
   >
   > 1. **The transaction must never be poisoned** — the duplicate cannot raise at
   >    all, or must be contained so the manager stays usable.
   > 2. **Narrowness is preserved.** The current catch is deliberately scoped to
   >    the Apple dedup identity the index actually covers, so a `23505` from any
   >    other constraint still propagates rather than being silently swallowed.
   >    That property must survive; a blanket suppression would lose it.
   >
   > Two mechanisms satisfy both, and the choice belongs with the same
   > real-Postgres harness as everything else in step 4.75 — not with this
   > paragraph:
   >
   > - **`INSERT … ON CONFLICT (…) WHERE … DO NOTHING`** with the inference clause
   >   matching the partial index for that provider (the insert knows its
   >   provider, so it can select the right target). No error path exists, which
   >   is strictly more robust than recovering from one.
   >
   > **⚠️ The Google index this assumes does not exist (2026-08-07).** Verified:
   > migrations 1830 and 1831 create `uq_users_google_store_transaction_id` and
   > `uq_users_google_original_transaction_id` — both on **`users`**. On
   > `store_billing_reconciliations` the only unique constraint is
   > `uq_sbr_open_apple_otid_reason`, which is **Apple-only**
   > (`store-billing-reconciliation.entity.ts:23-30`).
   >
   > So today two concurrent Google callbacks filing the same conflict hit **no
   > constraint at all**: neither `ON CONFLICT` nor a savepoint recovery can
   > trigger, both inserts succeed, and the duplicate actionable rows can each be
   > drained — refunding or revoking twice. The dedup mechanism above is moot for
   > Google until the constraint exists.
   >
   > **Step 5 must add it explicitly**: the partial unique index, the matching
   > `@Index` entity metadata, and the migration. This is the **same migration
   > decision** as the inference-target problem — either two per-provider partial
   > indexes (and per-provider `ON CONFLICT` inference), or one index over a
   > coalesced identity column (and a single inference target). Decide once.
   >
   > And the concurrency coverage must be **per provider**. An Apple-only
   > concurrent-insert test passes on the current schema while Google duplicates
   > silently — which is exactly the state this document was in until now.
   >
   > - **`SAVEPOINT` around the insert**, rolling back to it on `23505` so the
   >   transaction becomes usable again, then re-querying exactly as today. Keeps
   >   the existing narrow scoping verbatim and needs no index-inference work.
   >
   > **Do not settle this here.** §8 requires a test that discriminates: two
   > concurrent conflict inserts in **real** transactions, asserting the loser is a
   > no-op **and its transaction commits**. A mocked manager cannot express
   > `25P02` and would pass against the broken version.
   >
   > **Step 7 stays outside — now necessarily, not just permissibly.** Completing
   > the inbox row records that _this event_ was processed; it is not a judgement
   > about slot state, cannot be invalidated by a concurrent flow, and must not
   > extend the advisory-locked transaction. A crash between the two leaves the
   > row `pending`, the event redelivers, and reconciliation dedups on redelivery
   > (`findOpen` fast-path plus the `23505` no-op), so the retry is safe.
   >
   > **⚠️ THE LOCK WAS NECESSARY AND IS NOT SUFFICIENT — the row must also be
   > retired (2026-08-07).** Everything above serialises the _write_. It does not
   > address what line 809-810 already admits: nothing ever cleans the row up. Move
   > the race one millisecond later — Stripe clears the slot just **after** this
   > transaction commits, and a later RevenueCat event claims it successfully — and
   > the open `exclusivity_conflict` is stale in exactly the same way, against a
   > now-valid subscription an operator may refund or revoke. Locking cannot reach
   > this; the commit boundary is not the end of the story.
   >
   > **The principle, because it generalises past this row:** _a persisted
   > judgement about mutable state is stale the instant it commits._ Atomicity at
   > write time makes the judgement correct **when made**. Only revalidation at
   > act time makes it correct **when used**. Rounds 22–27 of this review all
   > tried to fix a use-time problem with write-time machinery.
   >
   > Two changes, and both are wanted — the first is prompt, the second is the
   > actual guarantee:
   >
   > 1. **Successful claims retire matching conflicts, with a caller-supplied
   >    resolution.** A claim that succeeds calls
   >    `StoreReconciliationService.resolveWith(manager, …)` **in its own
   >    transaction**, closing any `status = 'open'` row for that rider and store
   >    identity. `resolveWith` already exists and is transaction-bound precisely so
   >    a resolve cannot race a concurrent write — this is what it is for.
   >    Same-transaction matters: retiring after the commit reintroduces the window
   >    in miniature.
   >
   >    **The resolution is a parameter, not a constant.** The claim path takes a
   >    `retireWith` argument — `superseded_by_claim` for a webhook-driven claim,
   >    `claimed_on_drain` when the drain is the caller. Without it the two rules
   >    collide: the drain's empty-slot branch calls the same claim, generic
   >    retirement stamps `superseded_by_claim`, and the drain can only reach
   >    `claimed_on_drain` by overwriting it or by resolving outside the atomic
   >    transaction — both of which give up the property the retirement was added
   >    for. One atomic write, label chosen by the caller; no exemption, no second
   >    write.
   >
   >    Keep the two labels distinct rather than collapsing them: they answer
   >    different operational questions — _"a later webhook made this moot"_ versus
   >    _"the drain itself had to fix it"_ — and a rising `claimed_on_drain` rate
   >    means webhooks are failing to land, which `superseded_by_claim` would hide.
   >
   > 2. **The drain re-derives the ACTION, not the predicate.** Before an open row
   >    is presented or drained, re-query current ownership _and decide what should
   >    happen now_. Three outcomes, and only one of them is "close it":
   >
   >    | Slot now                    | Drain does                                                                                                                                                         |
   >    | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   >    | Owned by this row's subject | resolve `stale_on_drain` — the claim already succeeded elsewhere                                                                                                   |
   >    | Owned by another provider   | **leave open** — still genuinely actionable                                                                                                                        |
   >    | **Empty**                   | **re-query the store and attempt the claim.** Success → `claimed_on_drain`; purchase no longer active upstream → `purchase_inactive`; only these two close the row |
   >
   >    This is the safety net that does not depend on having enumerated every path
   >    that can invalidate a row — and after seven rounds of enumerating paths, that
   >    independence is the point.
   >
   >    > **⚠️ The empty-slot row was written as auto-resolve first, and that was a
   >    > rider-facing bug** (caught in the next review round). An empty slot does
   >    > not mean the conflict evaporated — it means the store purchase is **still
   >    > active, still billing, and now has nowhere to land**. Step 7 has already
   >    > completed and redacted the originating inbox row, so this conflict row is
   >    > the **only durable record** that the purchase exists. Closing it leaves a
   >    > paying rider on `free` with nothing left to reconcile from.
   >    >
   >    > The general error is worth naming, because it is subtler than the one it
   >    > replaced: revalidation must re-derive the **action**, not re-test the
   >    > **predicate that filed the row**. "Does Stripe still own the slot?" is the
   >    > predicate; answering "no" and closing is precisely the bug. The row exists
   >    > because a purchase needs a home, not because Stripe was in the way.
   >
   > **⚠️ THESE FOUR RESOLUTIONS DO NOT EXIST IN THE SCHEMA — step 4.75 must add
   > them (2026-08-07).** Verified: `sbr_resolution_check`
   > (`1822000000000-AddIapFoundation.ts:95-97`) permits exactly `rider_canceled`,
   > `refunded`, `expired`, `server_canceled`; no later migration widens it; and the
   > entity union (`store-billing-reconciliation.entity.ts:70-76`) matches. Every
   > value invented above would be rejected by Postgres.
   >
   > The `superseded_by_claim` write is the dangerous one: it is issued **inside the
   > claim transaction**, so a CHECK violation does not merely fail the retirement —
   > **it rolls back the successful claim**, turning a schema oversight into a rider
   > losing entitlement they paid for.
   >
   > Step 4.75 therefore carries, in the same change:
   >
   > - the entity union extended with `superseded_by_claim`, `stale_on_drain`,
   >   `claimed_on_drain`, `purchase_inactive` (longest is 26 chars, inside the
   >   existing `VARCHAR(32)` — no column widening);
   > - a migration dropping and re-adding `sbr_resolution_check` with all eight
   >   values, following the precedent migration 1825 set for `sbr_reason_check`.
   >
   > **Naming:** the new values deliberately carry no `resolved_` prefix, matching
   > the existing four — `status` already says `resolved`, so the prefix is
   > redundant on a column only ever non-null on resolved rows. (They were drafted
   > with the prefix and corrected here.)
   >
   > **Rollback hazard, called out because this document treats it as first-class:**
   > widening a CHECK is safe under the rolling deploy — the old container never
   > writes the new values — but `down` cannot restore the narrower constraint once
   > any row carries one. It must resolve those rows to an existing value or refuse.
   > Do not write a `down` that simply re-adds the four-value constraint; it fails on
   > a populated table, which is the failure the expand/contract staging elsewhere in
   > this document exists to avoid.
   >
   > The drain can do this: the row carries `user_id` and the store identity
   > (`apple_original_transaction_id` / `google_original_transaction_id`), which
   > is everything the claim needs. Do not redact those on completion.
   >
   > Change 1 alone is not enough: it only covers invalidation by a **claim**. A
   > Stripe terminal clear that leaves the slot empty invalidates the row too and
   > calls nothing. Change 2 covers both, and every case neither of us has thought
   > of.
   >
   > **This is a genuine gap in the merged Apple/Stripe reconciliation path, not
   > only in step 5's design** — `store_billing_reconciliations` has always filed
   > without retirement. Track it with step 4.75; it has the same
   > touches-live-code character.
   >
   > **Fifth round on this one step.** It has been outside the lock, inside
   > `runExclusive`, inside the claim transaction, briefly unprotected again when
   > the rider lock was wrongly declared redundant, and now inside an
   > unconditionally-locked claim transaction. Each move followed the same
   > guarantee one layer further down. Step 4.75's harness must prove this against
   > real Postgres and Redis — a fifth prose revision is not evidence.

7. **Complete the inbox row and NULL its payload** immediately on success.

> **CORRECTION (2026-08-07, review of PR #1136): the lock is acquired BEFORE the
> re-query, and an ordering-guard miss is NOT a lost claim.** The list above
> originally acquired the lock at step 4, _after_ steps 2–3 had already read
> RevenueCat and derived the ordering key. That contradicted open item (a)'s
> resolution — which rests on the consumer "re-querying and writing inside
> `runExclusive`" — and it was the weaker design. Two concurrent deliveries for
> the same rider would both read RevenueCat outside the lock; the one whose read
> started earlier then loses the read-ordering predicate, and step 6 as written
> would misread that zero-row result as a **lost claim**, opening a
> reconciliation row against a perfectly valid subscription — which, under the
> audit's closeout rules, an operator can drain into a refund or revoke.
>
> **Holding the lock across the RevenueCat API call is the established pattern
> here, not a compromise.** `SubscriptionMutationLockService` is Redis-backed
> _precisely_ so external I/O can run inside the critical section: a Redis lock
> holds no DB connection, waiters poll holding nothing, and the winner's DB work
> runs on the pool manager (a connection acquired and released per statement,
> none held across an API call). Its own header comment says so, and the lease
> TTL is sized for it. The **Stripe path already does exactly this** —
> `handleSubscriptionUpdated` wraps the whole event in `runExclusive` and issues
> finding 5b's live `getSubscription` re-query _inside_ it. **Do not "optimise"
> the re-query back out of the lock**; that is the defect this block corrects,
> and a PG advisory lock is not a substitute (it would pin a pooled connection
> across the round-trip).
>
> **⚠️ SUPERSEDED — this block's headline was wrong. `publishFence()` must come
> before the WRITES, not before the re-query.** Read the corrected rule in the
> processing order above and at the end of this block; the reasoning here about
> _why publishing at all is necessary_ stands, but its ordering conclusion was
> replaced the same day, because publishing before the foreign-ownership check
> mutates the submitting rider's row on an ownership conflict — see (d).
>
> _Original text, kept for the reasoning:_ The sentence above cited the Stripe
> path as precedent but described it incompletely, and the omission is the whole
> race. Stripe does not
> merely re-query inside the lock — it calls `await lease.publishFence()`
> **first**, and its comment (`account.service.ts:598`) says why: _"Publish this
> holder's fence FIRST — before the re-read below — so a lower-token straggler
> (an older flow that lost its Redis lease and stalled) can't land its guarded
> UPDATE between the read and the fence publish."_
>
> Being inside `runExclusive` is **not sufficient on its own.** The lease is a
> Redis lock with a TTL and heartbeat renewal; if renewals fail during the
> RevenueCat round trip — the window this design deliberately widens by putting a
> network call inside the critical section — the lease can expire while the
> callback is still running. Another delivery then legitimately acquires the
> lock, and the stale callback can still land a write with its **lower** fence
> token before the new holder publishes its own, interleaving the very
> read/decide/write sections the serialisation exists to separate.
>
> **This block's conclusion is ALSO superseded** — it said `publishFence()` must
> precede the guarded writes. It must not: it runs **after the claim commits**,
> per the advisory-transaction correction in the processing order. What survives
> here is only the argument that publishing at all is necessary, and that
> publishing is itself a mutation an ownership conflict must not perform.
> Required coverage: **lease lost during
> the RevenueCat API call**, asserting the stale callback's write is rejected
> rather than applied.
>
> This also makes the ordering-guard argument immediately below **weaker than it
> states**: that argument assumes the first delivery commits before the second
> re-queries, which is exactly what a lost lease breaks. Under lease loss it is
> the **fence**, not the read ordering, that holds.
>
> Worth naming the failure: this ordering was already ruled on once, for the
> Stripe re-query in PR #1131, and it did not transfer here when the RevenueCat
> re-query moved inside the lock. "Under the lock" is not one property but two —
> mutual exclusion **and** fence publication — and only the first comes free.
>
> _What this does to the ordering guard._ With lock-then-re-query, a second
> delivery re-queries only **after** the first has committed, so it necessarily
> observes both newer state and a newer `request_date_ms`. An ordering miss
> should therefore not arise for RevenueCat at all, which makes the
> `subscription_store_signed_date <= :observedAt` predicate
> **defence-in-depth rather than load-bearing** — serialisation is what orders
> the consumers now. **Keep the guard** (it costs nothing and it is the backstop
> if the section is ever re-ordered), but treat a miss as a signal that something
> unexpected happened — a clock anomaly upstream, or a lease lost mid-section —
> and **never report it into step 6 as a lost claim.** Step 6 exists for a
> purchase that provably lost the slot to another provider; filing a valid
> subscription there is how a rider gets refunded for nothing.
>
> _Step 5 owes the distinction, because the current signature cannot express it._
> `claimForGoogle` returns `'claimed' | 'conflict'` and collapses **both** the
> ordering miss and the genuine exclusivity/ownership conflict into `'conflict'`
> (a stale fence is already separated out — it throws a retryable 503). So the
> consumer cannot tell them apart from the return value alone. `claimForStore`
> (open item (a)) is already gaining a distinct ownership result for (d); it must
> separate the ordering case too — ownership/exclusivity ⇒ step 6; ordering miss
> ⇒ **neither step 6 nor an unconditional completion**, see immediately below.
>
> **⚠️ An ordering miss must NOT simply complete the inbox row (corrected
> 2026-08-07).** An earlier revision said "ordering miss ⇒ idempotent no-op,
> complete the inbox row and log it as anomalous". That does not follow from this
> spec's own semantics, and it can drop a real refund.
>
> The reasoning that breaks it is the one §4 step 3 already establishes:
> `request_date_ms` versions the **read**, not the state. So a stored value
> higher than the incoming one does **not** prove the persisted entitlement is
> newer — it proves only that some earlier read was issued later. If RevenueCat
> returns a regressed timestamp for **genuinely changed** state (a different API
> node's clock after a refund or an expiry is the obvious way), the guard rejects
> the write, the row completes, redelivery stops, and **paid access survives a
> refund** until some unrelated later event happens to correct it. "Idempotent
> no-op" was an assumption about state smuggled in through a timestamp that this
> spec explicitly says cannot carry it.
>
> **Rule: complete only on proven state equivalence.** After an ordering miss,
> compare the re-queried authoritative state against what is persisted:
>
> - **Equivalent** — tier, status, period end and cancel flag all already match
>   what this event would have written. Nothing to apply; complete the row. This
>   is the genuinely idempotent case (a duplicate delivery), and it is provable
>   without trusting the timestamp.
> - **Divergent** — the event carries state the row does not have. The miss is
>   **anomalous**: do **not** complete. Retain the row, retry under the existing
>   inbox semantics, and **escalate to ops past the retry budget** — the same
>   treatment a transiently-blocked valid event gets, because that is what this
>   is. It is emphatically not a classified-permanent failure, so it must not be
>   redacted.
>
> Required coverage: a **regressed `request_date_ms` carrying a terminal state**
> (refund or expiry) against a live paid row, asserting the row is **not**
> completed and the entitlement is not left standing.

**Failure handling** follows the existing inbox semantics: a transiently-blocked
valid event **retains** its payload and escalates to ops past the retry budget; only
a classified-permanent failure is redacted and alerted; leases allow crash
recovery.

**Stale-fence contention** (`claimFor*` affecting zero rows because the lease was
lost) is a retryable 503 / requeue, **not** an ordering no-op — the inbox row must
not complete without applying real state.

### OPEN ITEMS — see §12's per-item blocker table for what each one actually gates

> **Recorded 2026-08-06, at the final review of step 4.** These are **defects in
> this spec**, not in step 4's implementation. They were found while reviewing
> `claimForGoogle` / `clearGoogleTerminal` against this section, and each one
> makes an instruction in §4 unbuildable or unsafe as written. They are recorded
> rather than fixed because every one is a step-5 design decision, and guessing at
> them inside step 4 would be exactly the machinery-ahead-of-workload the §3 scope
> correction warns against.
>
> **This heading previously read "must be resolved BEFORE step 5 is planned", and
> the directive here was "do not code step 5 until each has an answer"** — both
> superseded (2026-08-07). §12's per-item blocker table is authoritative and is
> considerably more granular: (a), (c), and (e) do not block; (d) blocks only its
> disposal mechanism; (f) gates **enabling Play purchases**, not building; (g)
> blocks **completing** step 5 rather than starting it. A blanket "resolve
> everything first" left two valid-looking delivery orders for anyone entering the
> document through §4, and the stricter-looking one is the wrong one. **Read each
> item here for the constraints; read §12 for when it bites.**

**(a) §4 step 4 routes Apple through `claimForApple`, which RevenueCat cannot
feed.** Step 4 above says the consumer calls "`claimForApple` / `claimForGoogle`".
But `claimForApple` requires a `signedDate` — Apple's JWS state stamp — plus the
three CAS baseline fields (`observedProvider`, `observedOriginalTransactionId`,
`observedSignedDate`), and returns five values. **RevenueCat provides no JWS**, by
the same reasoning §1's correction used to establish there is no Play purchase
token. §6 step 2 has since deleted `IapValidateService` (PR #1136), so
`claimForApple` currently has **no caller at all** and the RevenueCat consumer
would be its **only** one — and it cannot satisfy that contract
without passing `request_date_ms` as `signedDate` — which would silently downgrade
that method's documented state-monotonicity guarantee to mere read-ordering while
its doc comment continues to claim the stronger property. Step 5 must either
define exactly what the consumer passes for each of those fields, or collapse
Apple onto the Google shape (a single `claimForStore(provider, storeId, fields)`).
Do not resolve this by quietly aliasing the two timestamps.

> **NARROWED (2026-08-07) by the resolution of open item (b) — but NOT resolved.**
> Binding **both** stores on RevenueCat's `original_transaction_id` removes the
> _identifier_ half of this asymmetry: RC's `original_transaction_id` for an App
> Store subscription **is** the Apple OTID that `apple_original_transaction_id`
> holds, so `apple_original_transaction_id` and
> `google_original_transaction_id` now hold the same kind of value and a
> `claimForStore(provider, originalTransactionId, fields)` collapse has one fewer
> obstacle.
>
> What remains open is the whole of the hard part: `claimForApple`'s `signedDate`
> (Apple's strictly-monotonic per-**state** JWS stamp, which RevenueCat does not
> provide) versus Google's `observedAt` (`request_date_ms`, which versions the
> **read**), and the three CAS baseline fields plus the five-value return that
> have no Google counterpart. **Do not read the narrowed identifier as licence to
> collapse the two methods** — the ordering semantics are still genuinely
> different, and aliasing the timestamps is exactly what this item forbids.

**(b) ⚠️ PARTIALLY RESOLVED (2026-08-07) — the FIELD is settled; the Play
replacement case is NOT.** The field question below is closed: the binding is
`original_transaction_id`, not the per-renewal `store_transaction_id`. But
"resolved" was too strong a word for the identity contract as a whole — see
**open item (f)**, which carries the case where a valid Play plan replacement may
present a _different_ `original_transaction_id` while the current subscription
still owns the slot. The equality guard as built would reject that. Read (b) and
(f) together before implementing the consumer.

The
reasoning is kept rather than deleted, because the trap is easy to fall into
again.

_The open question was:_ the spec never pinned WHICH RevenueCat identifier is the
binding, and the wrong choice breaks every renewal. §1's first correction said
RevenueCat gives `store_transaction_id`, and additionally that the webhook carries
`transaction_id` / `original_transaction_id`. That left an asymmetry: for
**Apple** the binding was RC's `original_transaction_id` (stable across the whole
subscription), for **Google** it was the **latest transaction's** id.

_Verified against RevenueCat's field documentation:_

- **`transaction_id`** — _"Transaction identifier from the store."_ It **changes
  on each renewal.**
- **`original_transaction_id`** — _"`transaction_id` of the original transaction
  in the subscription."_ **Stable across the subscription's lifetime.**

The subscriber API's per-subscription `store_transaction_id` is the **current
period's** transaction. Corroborated by RevenueCat's own documented example value,
`GPA.6801-7988-0152-76034..5` — a Google Play order id whose `..N` suffix is the
renewal counter — and by RevenueCat support, who state the field holds the latest
transaction id ("Google Play: Generates a new transaction ID on renewal that
increments from the original") and recommend `original_transaction_id` when a
constant per-subscription identifier is needed.

_So the risk was real, not hypothetical._ Fed the per-renewal id,
`claimForGoogle`'s `(google_original_transaction_id IS NULL OR = :otid)` guard
matches the initial purchase and then rejects **every renewal after the first**: a
reconciliation row per renewal and a `subscription_current_period_end` frozen at
the first period, with the rider still being charged.

_Resolution:_ **the binding is RevenueCat's `original_transaction_id`**, stored in
`users.google_original_transaction_id` (migration `1831000000000`, expand half of
a second expand/contract — see §1's second correction). `claimForGoogle` and
`clearGoogleTerminal` take an `originalTransactionId` parameter and guard on that
column. This also **removes** the Apple/Google asymmetry noted above: RC's
`original_transaction_id` for an App Store subscription **is** the Apple OTID, so
both columns hold the same kind of value. A regression test simulating the row
against the real guards pins the renewal case
(`provider-claim.service.spec.ts`, "re-claims the SAME slot on a renewal and
advances the period end").

_The transport question, now settled (2026-08-07)._ The concern above was that the
authoritative re-query might not carry the stable id. **It does not.** The
subscriber API's per-subscription entry exposes exactly these fields —
`auto_resume_date`, `billing_issues_detected_at`, `expires_date`,
`grace_period_expires_date`, `is_sandbox`, `original_purchase_date`,
`ownership_type`, `period_type`, `purchase_date`, `refunded_at`, `store`,
`store_transaction_id`, `unsubscribe_detected_at` — and **no** original
transaction identifier of any kind. The only stable identifiers it offers are
`store_transaction_id` (which is per-renewal, i.e. the wrong one) and
`original_purchase_date` (a timestamp, not an id).

So the stable id exists **only in the webhook event body**.

**Resolution: identity from the event, state from the re-query.** These are
different questions and §4 step 2's rule addresses only the second. The rule
exists because a stale or forged event body could assert a _state_ — a tier, a
status, an expiry — that grants something the store never granted. A forged event
naming a victim's `app_user_id` merely causes their own real, re-queried state to
be re-applied, which is idempotent **as far as state goes** — read the correction
immediately below before concluding the delivery was harmless, because the
identity it carries is not covered by that argument.

> **⚠️ CORRECTION (2026-08-07) — the same does NOT hold for the identity, and the
> original text of this paragraph was wrong.** It claimed a forged
> `original_transaction_id` is equally harmless because "the claim's
> ownership/identity guards reject any attempt to point it at a slot the caller
> does not own". **They do not, when the slot is empty.** The guard is
> `(<identity column> IS NULL OR <identity column> = :otid)` — on an **unbound**
> row the `IS NULL` branch accepts **any** identifier the event supplies.
>
> And the re-query cannot compensate: as this same item establishes, RevenueCat's
> subscriber API **does not return an original transaction identifier at all**.
> So the identifier is the one field that arrives solely from the event body and
> is structurally unverifiable against authoritative state. The re-query validates
> what the subscription _is_; nothing validates what it is _called_.
>
> **The attack.** A caller holding the webhook secret targets a rider whose
> identity column is still NULL and supplies a fabricated
> `original_transaction_id`. It binds. Every later **legitimate** event for that
> rider — renewal, expiry, refund — carries the _real_ identifier, fails the
> equality guard, and cannot apply. The rider's entitlement can therefore survive
> an expiry or a refund, which is the same end state as the ordering-miss defect
> corrected above, reached by a different route.
>
> **So the shared secret is load-bearing for identity**, which §4's
> authentication rationale originally missed by reasoning only about state.
> **§4 has since been rewritten to say so directly** (2026-08-07) — it now
> justifies accepting an unsigned body for _state_ because state is re-queried,
> and explicitly denies covering the identity binding, which is not re-queryable.
> Both statements must stay narrowed; if either is ever widened back to "the
> event body is never a source of truth", this hole reopens silently.
>
> **Step 5 must choose a response — this is recorded, not resolved** (see open
> item (g)). Not invented here, because the honest options differ in cost and the
> right one depends on what a first-binding flow can actually correlate.
>
> One mitigating fact worth keeping: a poisoned binding is **detectable, not
> silent**. Later legitimate events conflict rather than applying, and under the
> corrected ordering rules a divergent conflict must not complete the inbox row —
> it escalates. So the failure surfaces to ops rather than rotting quietly. But
> detection is not prevention, and recovery is manual.

**Step 5 must still handle the correlation**, which this does not settle: the
re-query returns subscriptions keyed by product id, so the consumer has to
establish that the entry whose state it applies is the same subscription the
event's `original_transaction_id` names. Getting that wrong would apply one
subscription's state under another's identity. Pin it with a test covering a rider
holding two Play subscriptions.

> **Now tracked where it binds (2026-08-07).** This paragraph asserted the
> requirement and nothing enforced it: §12's blocker table omitted **(b)**
> entirely — concluding only (d) and (g) needed decisions during step 5 — and §8
> had no two-subscription case. The requirement existed only here, in the item
> that records it. (b) is now a blocker row (**blocks completing step 5**, the
> same shape as (g)) and §8 carries the regression test.

**Do not paper over any of this by falling back to `store_transaction_id`** — that
is the defect this item exists to prevent.

**(c) ❌ WITHDRAWN as originally written — `clearAppleTerminal` is NOT defective.
The real item is that its stale-fence handling lives in the CALLER, and step 5
inherits it.**

> **This item was recorded wrongly (2026-08-07) and the correction is kept
> because the mistake is instructive.** It was raised by comparing method bodies —
> `clearAppleTerminal` returns a bare `(affected ?? 0) > 0` while
> `clearStripeTerminal`, `claimForStripe`, `claimForGoogle` and
> `clearGoogleTerminal` all call `assertSubscriptionFenceCurrent` — and concluding
> the Apple path silently swallows a lost lease. **Nobody read the caller.**

`IapValidateService` already handled the zero-row case — _past tense: the file was
deleted on 2026-08-07, see the note below the three outcomes_ — and handled it
**more richly than a throw inside the method could**. After a `false` return it
re-read the row fresh and distinguished three outcomes:

1. `subscription_lock_fence > lease.fenceToken` → a genuinely stale fence →
   throws the retryable 503. This is exactly what `assertSubscriptionFenceCurrent`
   would do, so §4's stale-fence rule **is** satisfied for the Apple path today.
2. The row is still this OTID's and is **entitling** → a concurrent NEWER recovery
   won the ordering guard, so the rider really is entitled → returns that snapshot
   as an idempotent **success**.
3. Otherwise → a non-owner submitted a terminal transaction.

Folding `assertSubscriptionFenceCurrent` into `clearAppleTerminal` would collapse
case 2 into a 503, so a rider whose subscription a concurrent recovery just
restored would be told to retry forever instead of being handed their live
snapshot. The bare return is deliberate: the method reports whether the guarded
UPDATE applied, and the caller — which alone knows what the three outcomes mean
for its response — classifies. **Do not "fix" the method.**

_What IS owed, and why this item stays open:_ that classification **lived** in
`IapValidateService` — **past tense as of 2026-08-07: §6's deletion has run (PR
#1136) and the file is gone**, so `clearAppleTerminal` now has no caller at all
and the behaviour above exists nowhere in the codebase. The three cases and the
prose in this item are the only surviving specification of it. So step 5 must
either (i) replicate the three-way classification at its own call site, or (ii)
build it into the converged terminal clear — which then needs a richer return
type than `boolean`, because collapsing case 2 into a throw is the bug described
above. Either way it is now a **reconstruction from this text**, not a lift of
working code; read the three cases above before writing the method.

Note this makes the Apple and Google terminals genuinely asymmetric rather than
one of them being wrong: `clearGoogleTerminal` throws internally because it has no
caller yet to classify for it, while `clearAppleTerminal` defers. Step 5 should
converge them, and (ii) is the likelier shape.

> **✅ RESOLVED (2026-08-07) — collapse Apple onto the Google shape.** Step 5
> builds a single `claimForStore(provider, originalTransactionId, fields)` and a
> single terminal clear, both with the Google semantics, and uses them for **both**
> stores. `claimForApple` / `clearAppleTerminal` are not adapted; they are removed
> by this collapse, which is when their replacement exists — see the sequencing
> note at the end of this block.
>
> **⚠️ "Resolved" here means the SHAPE, not the GUARD SEMANTICS — (f) is still
> open and this is not independently buildable.** (Noted 2026-08-07, review of PR
> #1136; the same overclaim already had to be walked back on (b).) What is settled
> is that there is **one** claim method taking one stable `originalTransactionId`,
> with Google's ordering key and return shape, for both stores. What is **not**
> settled is what that method's identity guard accepts: **(f)** carries the case
> where a store-confirmed Play plan replacement may present a _different_
> `original_transaction_id` while the current subscription still owns the slot,
> and it requires a sandbox observation before Play purchases are **enabled**
> (§12 corrects the earlier "before the consumer is built" framing — only the
> replacement branch depends on it). An equality-only guard and a guard with a
> supersession escape path are different methods. **Do not read this block as
> licence to settle that branch before (f)
> is answered** — and note that if (f) turns out to need the escape path, it is
> **Play-only**, so the collapsed method takes a per-provider branch there rather
> than a shared one.
>
> _Why the hard part dissolves rather than needing a translation._ Each of
> `claimForApple`'s extra mechanisms exists to serve something RevenueCat
> ingestion does not have:
>
> - **`signedDate`.** Apple's per-state JWS stamp is simply **unavailable** under
>   RevenueCat — for Apple exactly as for Google. There is no honest translation,
>   which is why aliasing `request_date_ms` into it was explicitly forbidden above.
>   The consequence is that state-monotonicity ordering is not on offer for
>   **either** store under this ingestion channel. That is acceptable for the same
>   reason §4 step 3 already argues for Google: correctness rests on always
>   applying freshly re-queried authoritative state **under the per-rider lock**,
>   with the read-time key ordering concurrent consumers. Apple does not get a
>   weaker guarantee than it "should" — it gets the same one Google gets, because
>   the stronger one requires a JWS this channel never carries.
> - **The three CAS baseline fields.** Branch A's compare-and-swap guards a
>   read-then-write window in a **synchronous client request** racing other
>   flows. The RevenueCat consumer has no such window: it re-queries and writes
>   inside `runExclusive`, so there is no unserialised gap to compare against.
> - **The five return values.** They exist to shape `IapValidateService`'s HTTP
>   responses — a 409 versus a 400 versus a retryable 503. A webhook consumer has
>   no such response to shape; it needs "did the claim apply", plus the distinct
>   ownership case in (d).
>
> _One behaviour change this locks in, deliberately:_ the converged terminal clear
> **nulls** the store identity for both providers, as `clearGoogleTerminal` does.
> `clearAppleTerminal` retains the OTID because the **native** path resolved the
> rider by it; §2 resolves riders by `app_user_id` against
> `users.purchase_account_token`, so retention buys nothing here — and PR #1134 showed retention actively causes a
> permanent lockout when a re-subscribe presents a new lineage. The retained-OTID
> tombstone machinery (and its `provider IS NULL` broadening) goes with it.
>
> _Sequencing — UPDATED 2026-08-07, because the native deletion has since run._
> This block originally said the collapse "does not require §6/step 8 to have run
> first" and that the native methods "can sit unused from step 5 until step 8
> deletes them". **§6's deletion is now done** (PR #1136 — see §12), and it
> deliberately did **not** take `claimForApple` / `clearAppleTerminal`: they live
> in the shared `ProviderClaimService`, not in the deleted native files. So they
> are dead code with **no caller at all** today, and **this collapse is what
> removes them** — there is no later step waiting to do it.
>
> _Consequence for (c), and it is not a happy one._ (c) says step 5 must either
> replicate the three-way zero-row classification or move it onto the converged
> clear. The **move option is gone**: that classification lived in
> `IapValidateService`, which PR #1136 deleted. (c)'s own prose in this document
> is now the surviving specification of the behaviour, so step 5 **reconstructs**
> it from there rather than lifting working code. Re-read (c)'s three cases
> carefully before building the terminal clear — case 2 (a concurrent newer
> recovery won the ordering guard, so the rider really is entitled) is the one
> that is easy to lose, and losing it turns an entitled rider into a permanent
> retry loop.
>
> **⚠️ But do not restore case 2 as the native path had it (2026-08-07).** Case 2
> and a **divergent terminal miss** present identically at the zero-row result:
> both are "the guard rejected me and the persisted row is entitling under the
> same identity". A regressed `request_date_ms` carrying a **refund** has exactly
> that shape, and classifying it as case 2 completes the inbox row and leaves
> refunded access live — the failure §4's equivalent-versus-divergent rule exists
> to prevent.
>
> So the converged classifier tests **persisted-state equivalence first**, and
> only reaches case 2 when equivalence holds. One shortcut makes this cheap and
> should be stated as a rule rather than rediscovered: **a terminal event whose
> persisted state is entitling is divergent by construction** — one says access
> should end, the other says access is live, and no comparison can make those
> equivalent. Terminal + entitling persisted ⇒ divergent ⇒ the inbox row stays
> **pending** and escalates. It is never case 2.
>
> This is why (c) says _reconstruct_ rather than _restore_: the native
> classification predates the ordering rules and is wrong under them.

**(h) Simultaneous subscriptions: a terminal event must not revoke a rider who
still has an active one.** Recorded 2026-08-07, from the review of PR #1136.
`users` carries a **single** `subscription_provider`, a single store identity and
a single `subscription_tier`. So when a rider holds two store subscriptions and
one goes terminal, "apply the terminal state" and "preserve the other" cannot both
be done field-by-field — the converged clear would null the identity and drop the
tier to `free` while the surviving subscription keeps billing.

The fix is a reframing rather than new storage, and it follows the architecture
already in place: **the terminal path must recompute the rider's entitlement from
the full re-queried subscriber set, not apply the event's terminality.** The
re-query already returns every subscription; the defect is treating a terminal
_event_ as a terminal _outcome_. If any subscription remains entitling, the rider
stays entitled and the slot rebinds to it; only an empty entitling set clears.

Two things step 5 must settle, neither of which is obvious:

1. **The identity switch is blocked by the guards — and worse, there is no
   identifier to switch TO.** Both the claim and the clear match
   `(<identity> IS NULL OR = :otid)`, so moving the binding from A to B fails.
   Clear-then-claim in one transaction would solve _that_ (the clear nulls the
   identity, the claim takes the `IS NULL` branch) — **but it needs B's
   `original_transaction_id`, and nothing has it**: the subscriber API does not
   return that field, the event body names **A**, and the `users` row stores
   **A**. Prescribing clear-then-claim without saying where `:otid` comes from was
   the gap (corrected 2026-08-07).

   Two ways out, both with real costs:
   - **A durable per-subscription identity map** — rider × product ×
     `original_transaction_id`, populated from webhook events, which _do_ carry
     the field. Failover then looks B's identifier up. Correct, and it is new
     storage plus a write on every store event.
   - **Rebind lazily: clear the identity to NULL, keep the tier selected from the
     re-queried set, and let B's own next event bind via the `IS NULL` branch.**
     No new storage — but the rider then sits entitled with an **unbound** slot,
     and a terminal for B arriving in that window matches nothing (the clear
     guards `identity = :otid` against NULL), leaving entitlement standing
     wrongly. That hole must be closed before this option is viable.

   > **Third time a missing RevenueCat identifier has invalidated a design in this
   > document** — after the forged first binding (g) and the Play cancellation
   > token (6.5). The pattern is worth stating: **before prescribing any step that
   > needs an identifier, name where it comes from.** RevenueCat's subscriber API
   > returns far less identity than its webhooks do, and the webhook is the only
   > source for the original transaction id.

2. **A deterministic winner when more than one remains entitling** — otherwise
   consecutive events flap the rider between subscriptions. Highest tier first,
   then latest period end, is the obvious rule; pick one and test it.

**Blocks completing step 5.**

> **⚠️ And the identity map IS permitted — including its migration (corrected
> 2026-08-07).** This paragraph used to end "multi-subscription storage is
> explicitly _not_ the answer here", which ruled out the only option that works:
> the map is per-subscription storage, and the lazy-rebind alternative leaves a
> hole this item itself records. Step 5 was left with no permitted mechanism to
> obtain B's identifier and therefore no way to pass its own required failover
> test.
>
> The distinction I collapsed, and which the exclusion was reaching for:
>
> - **Multi-subscription _entitlement_ storage — still out of scope.** Making
>   `users` hold several concurrent subscriptions and tiers, so that every
>   entitlement consumer must reason about a set. That is the schema change beyond
>   the vertical.
> - **A per-subscription _identity_ map — in scope, with its migration.** A narrow
>   side table (rider × product × `original_transaction_id`) whose only job is to
>   answer "what is B's identifier". Entitlement stays exactly as it is: one slot
>   on `users`, one tier, one binding. Nothing downstream changes.
>
> The second is small and does not leak into the entitlement model, which is what
> the scope rule was protecting.

**(i) A divergent terminal miss must terminate in an ACTION, not in retries.**
Recorded 2026-08-07, from the review of PR #1136. The ordering rules say a
terminal event whose persisted state is entitling is divergent by construction, so
the inbox row stays `pending` and escalates. But the guarded update already matched
zero rows _because_ `request_date_ms` regressed, and a retry re-queries and can get
**the same regressed value** and fail identically. Retrying forever does not revoke
refunded access, so §8's "entitlement is not left standing" is unsatisfiable by the
machinery as described.

Escalation has to lead somewhere. Candidates:

- **Bounded retries, then a reconciliation work item** carrying the divergence, so
  an operator acts on it. Safe, and it makes revocation manual and slow.
- **A guarded repair path** that applies the authoritative terminal state with an
  explicit, audited override of the ordering guard — justified because a
  terminal-versus-entitling divergence cannot be a benign ordering artifact: it is
  not two views of one state, it is two different states.

**One asymmetry should weigh on the choice.** Applying a terminal state wrongly is
**self-correcting** — a later renewal event re-grants the tier. Leaving a refund or
expiry unapplied is **not**: nothing later says "this should have been revoked", and
the rider keeps paid access indefinitely. That argues for the override direction,
which is why the option exists rather than defaulting to the safe-looking one.

Whichever is chosen, the retry must be **bounded** — an unbounded loop against a
persistently regressed timestamp is the current design and it is the defect.
**Blocks completing step 5**; it is the terminal half of the ordering rules, and
those rules are what step 5 builds.

**(j) The `app_user_id` must be a backend-issued secret, not the Tarmoto user
id.** Recorded 2026-08-07, from the review of PR #1136. The full attack, the two
harms, and the fix are in §4's binding correction. In short: rider ids are public
to other riders (`PublicProfileDto.id`), a modified client can call
`Purchases.logIn` with someone else's, and every guard in this design passes
because the resulting webhook is authentic. Mint an unguessable
`users.purchase_account_token`, serve it only to the authenticated rider, resolve
on it, and set RevenueCat's transfer behaviour deliberately.

**Blocks step 5 and step 6.** Unlike the other open items this one is not a
decision to make during implementation — the design is settled; it is work that
must be in scope. It is listed here so it cannot be missed, not because anything
about it is undecided.

**(d) `claimForGoogle` has no `23505` handling.**
`uq_users_google_original_transaction_id` is a cross-row partial unique index.
RevenueCat's **subscription-transfer** case (a rider re-registers, the app calls
`Purchases.logIn(newUserId)`, and RevenueCat transfers the purchase) can put the
same store transaction on two riders' rows. `claimForGoogle` does not catch the
resulting `QueryFailedError`, so it escapes as an untyped 500 — and RevenueCat
retries a 5xx indefinitely, making it a poison-pill event whose inbox row is stuck
`pending` forever (which §4 step 1 correctly refuses to short-circuit as
already-seen). `claimForApple:716-729` already handles exactly this and maps it to
a distinct `'ownership_conflict'`. Nulling the id (correction in §3) **shrinks**
this window — a terminal-cleared row no longer holds a colliding id — but does not
close it for an **active** subscription transferred between riders. Step 5 must
decide the consumer's behaviour on `23505`: a reconciliation row, an
`'ownership_conflict'`-style return, or an explicit transfer flow. **Do not
implement this in step 4** — the right answer depends on how the consumer models
transfers, which does not exist yet.

> **⚠️ PARTIALLY RESOLVED (2026-08-07) — "mutate nothing" is settled; the
> DISPOSAL mechanism is NOT.** This block originally read "✅ RESOLVED — a
> distinct ownership result, then a classified permanent dead-letter", and it
> over-prescribed: it jumped to a dead letter without checking what survives the
> inbox's redaction rule. The half it got right is kept below; the half it
> guessed at is reopened underneath.
>
> **Settled.** `claimForStore` (per (a)) catches the unique violation and returns
> a distinct `'ownership_conflict'`, exactly as `claimForApple` already does, and
> the consumer does **nothing to either rider's row**.
>
> _Why nothing is mutated._ This is the audit's account-binding rule, and it is
> the one case where the usual "close out a losing purchase" reflex is wrong: a
> `23505` means the store transaction is **already owned by a different rider's
> row**. The purchase is not proven to belong to the caller, so refunding or
> revoking it would act on a **victim's** live subscription. The audit is explicit
> that an ownership failure opens **no actionable reconciliation row** either —
> the victim's store id must never become a drainable work item, or an operator
> draining the queue cancels a subscription that was always legitimate.
>
> _Also settled: it cannot be left to retry._ A two-rider collision is not
> transient, and §4's inbox deliberately refuses to short-circuit a `pending` row
> as already-seen, so an event that is never disposed of retries until RevenueCat
> gives up — the poison pill this item describes. Whatever step 5 picks below, it
> must be terminal.
>
> **STILL OPEN — the disposal mechanism.** The original resolution said
> "dead-letter it as a classified-permanent failure (`dead_letter_reason:
'permanent_reject'`) with an ops alert". **That does not survive contact with
> the inbox's own semantics.** §4's failure-handling rule redacts the payload of a
> classified-permanent failure, and `processed_store_notifications` carries
> `provider`, `notification_id`, `status`, `event_type`, `payload`, `locked_by`,
> and the lease / attempt / failure-class columns — and **no rider id and no store
> transaction id** (verified against
> `apps/backend/src/entities/processed-store-notification.entity.ts`). Redaction
> therefore destroys exactly the two facts an operator needs, and the alert
> arrives naming a collision it cannot locate.
>
> _Constraints any step-5 answer must satisfy_ — recorded instead of picked,
> because picking is what went wrong the first time:
>
> - an operator must be able to identify **which two riders** and **which store
>   transaction** collided;
> - that context must survive the redaction rule. Redaction exists for real
>   privacy reasons — a raw store event body is rider-identifying data retained
>   indefinitely on a dead-lettered row — so it must not simply be exempted for
>   this case without saying why in writing;
> - the **losing/former** account must not silently retain stale entitlement while
>   the collision waits for a human. "Mutate nothing" protects the victim's row;
>   it is not licence to leave a wrongly-entitled row untouched and unnoticed;
> - it must be terminal, per the paragraph above.
>
> _Options, none chosen._ Each has a real cost, and the choice depends on how step
> 5 models transfers — which does not exist yet, the same reason this item was
> opened.
>
> - **A non-payload identity column on the inbox** (e.g. the resolved `user_id`
>   and the store original transaction id as first-class columns, outside the
>   redacted `payload`). Cheapest to query, but it widens the inbox schema for one
>   case and moves rider-identifying data into a column the redaction rule does
>   not cover — so it needs its own retention answer.
> - **A distinct, explicitly non-drainable investigation record**, separate from
>   `store_billing_reconciliations` so it can never be drained into a refund or
>   revoke (the whole point of "no actionable reconciliation row" above). Keeps
>   the inbox unchanged, but adds a table and an ops surface for a case that may
>   be rare.
> - **A recoverable transfer-specific state** — model the transfer rather than
>   dead-lettering it, so a legitimate RevenueCat account transfer resolves itself
>   under the per-rider lock and only genuine collisions reach a human. Strictly
>   the best outcome and strictly the most work; it is the follow-up the original
>   block already gestured at.
>
> _What none of them changes:_ this item does not implement subscription transfer.
> Until one of the above exists, a genuine RevenueCat transfer — a rider who
> legitimately moved their purchase to a new account — lands here. Whichever
> mechanism is chosen, it must be **visible** rather than silent, and loosening
> the `23505` guard is not on the menu.

**(e) The expand/contract is unfinished — the contract migration is still owed,
and it now drops TWO superseded column generations.** Unlike (a)–(d) this is not
a spec defect or an open design question; it is a scheduled follow-up recorded
here because this block is what a step-5 planner reads.

Two expand halves have now shipped, each deliberately additive:

- **Migration `1830000000000`** (step 4) ADDed `users.google_store_transaction_id`,
  `uq_users_google_store_transaction_id` and
  `store_billing_reconciliations.google_store_transaction_id`, leaving
  `google_purchase_token` (migration 1822) on both tables and
  `uq_users_google_purchase_token` in place.
- **Migration `1831000000000`** (resolving open item (b)) ADDed
  `users.google_original_transaction_id`,
  `uq_users_google_original_transaction_id` and
  `store_billing_reconciliations.google_original_transaction_id`, leaving **both**
  earlier generations in place.

So **three** generations of this column exist transiently. That is the accepted
cost of not breaking Coolify's rolling update (and of keeping each release a
viable rollback target); it is not drift to be tidied up mid-flight.

Only the newest generation is mapped by an entity. The other **six** objects are
**unmapped and NULL in every row**, and every release makes the older images less
plausible rollback targets. Ship **one** contract migration dropping all of them
together — each index before its column:

- `uq_users_google_purchase_token`, `users.google_purchase_token`,
  `store_billing_reconciliations.google_purchase_token`
- `uq_users_google_store_transaction_id`, `users.google_store_transaction_id`,
  `store_billing_reconciliations.google_store_transaction_id`

Ship it in step 5 or any later release, once migration 1831's release is deployed
and no longer a rollback target. Do **not** fold it into 1831's own release: that
would collapse expand and contract back into the single-step rename the staging
exists to avoid.

**(g) The FIRST identity binding is unverifiable, so a forged event can poison an
empty slot.** Recorded 2026-08-07; see the correction in the transport-resolution
block of (b), which has the full attack.

Short form: the identity guard's `IS NULL` branch accepts any event-supplied
identifier on an unbound row, RevenueCat's subscriber API returns no original
transaction identifier to check it against, and a poisoned binding then makes
every later legitimate event — including expiry and refund — fail the equality
guard. Entitlement can outlive a refund.

_Options for step 5, none chosen here:_

1. **Correlate before binding.** Bind only when the re-queried subscriber
   plausibly corresponds to the event — e.g. the event's `product_id` appears in
   the subscriber's `subscriptions`, with a matching `original_purchase_date`.
   This does not authenticate the _identifier_, but it does stop a binding for a
   subscription the rider does not hold, which is the part that enables the
   attack. Cheapest, and testable.
2. **Treat first binding as privileged.** Require a stronger signal for the
   NULL-slot transition specifically — for instance only accepting an initial
   purchase event type, or requiring the mobile client's own purchase
   confirmation to have been seen — rather than letting any event type bind.
3. **Compensating transport controls.** Secret rotation, and whatever RevenueCat
   offers for authenticating the sender beyond a static header. Necessary
   regardless, but on its own it only reduces the population of callers who can
   mount the attack; it does not make the binding verifiable.

(1) and (2) compose, and neither closes the case where a caller with the secret
targets a rider who genuinely holds the subscription in question. Whether that
residue is acceptable is a product decision, and it should be **stated** rather
than inherited by silence.

_Required coverage either way:_ a NULL-slot binding from an event whose identifier
does not correspond to any subscription the re-query returns must be **rejected**,
and the rejection must not be reported as a lost claim into step 6.

**(f) A store-confirmed Play plan replacement may present a DIFFERENT
`original_transaction_id` while the current subscription still owns the slot —
and `claimForGoogle` would reject it.**

> **Read with (a).** (a)'s resolution settles the _shape_ of step 5's unified
> `claimForStore`; this item settles what its identity guard **accepts**. Neither
> is independently complete. This one gates the other's **identity guard**, not
> its construction: `claimForStore` can be built with the equality-only guard —
> correct for every case except a possible one — and the replacement branch
> settled when the observation below is in. See §12's circularity correction;
> requiring the whole method to wait was a deadlock, since nothing in the repo
> could produce the observation.

`claimForGoogle`'s identity guard is equality-only:
`(google_original_transaction_id IS NULL OR google_original_transaction_id = :otid)`.
A live Google-owned row with a stored id therefore accepts only that same id.

The audit requires the opposite for one specific case
(`docs/reference/payments-subscriptions-audit.md:436-448`): _"even a live owner
must accept a store-confirmed in-place replacement … a valid **Play
subscription-replacement** issues a **different token while the current
subscription still owns the slot** — that supersedes the old subscription and must
be **accepted**, not refunded/revoked as a conflict."_ It is explicit that this is
**Play-only**: an Apple in-group upgrade keeps the **same** OTID and is a product
change, so a different Apple OTID is a genuinely separate subscription and must
**not** be accepted as a replacement.

If a Play replacement does present a new lineage, an upgrading rider hits
`'conflict'` — a reconciliation row, and under the audit's closeout rules
potentially a refund or revoke issued against a subscription they legitimately
just upgraded to.

_What is actually unknown, and must be settled before Play purchases are enabled
(not before the consumer is built — see §12):_
**whether RevenueCat surfaces a Play plan change as a new `original_transaction_id`
at all.** RevenueCat has a `PRODUCT_CHANGE` event supported on Google Play, but
its documentation does **not** state whether the original transaction id changes,
and it may normalise the replacement onto the same RC subscription entity — in
which case the equality guard is already correct and no escape path is needed.
Verify against a real Play upgrade in sandbox; the answer decides whether this is
a bug or a non-issue.

_Deliberately NOT pre-emptively fixed._ Adding a replacement escape path to the
identity guard on a guess would **weaken** the cross-provider exclusivity
guarantee — the guard's job is to stop a second, independent subscription taking
a slot that is already owned, and a bypass built for a case that may not exist is
exactly the speculative hardening this design was written to avoid. Establish the
behaviour first, then build only what it requires.

_If it turns out a new lineage is issued,_ the escape path must accept **only** a
**store-confirmed supersession** — not any different id. The audit's own
distinction is the test: an Android Pro holder submitting an independent Premium
purchase, leaving the first product still renewing, is a genuine conflict and must
still be rejected. Required coverage: an **active-plan → store-confirmed
replacement** acceptance test, alongside the existing terminal-old → new-id
repurchase case.

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

- the other **twelve** `UpgradePrompt` call sites — enumerated with line numbers
  so a follow-up issue cannot miscount them again: `MapScreen:720`,
  `RideDetailScreen:370,924`, `TripsScreen:308`, `GroupRideScreen:662,669,830`,
  `TripCreateScreen:762`, **`OfflineRegionsScreen:208,423`**, `CommuteScreen:367`,
  `TripDetailScreen:537`. (Corrected 2026-08-07: this said "nine" and was wrong
  twice — the enumeration as written summed to eleven, and `OfflineRegionsScreen`
  carries **two** prompts, `:208` for the locked feature and `:423` for the
  region-limit cap, but was listed once. Thirteen production instances exist; the
  vertical wires `SettingsScreen:329`, leaving twelve. A prompt missed here keeps
  rendering the disabled "Coming soon" CTA.)
- the Premium tier
- trial eligibility (backend `billing_trial_used_at` combined with store-side
  eligibility) — the vertical sells the **no-trial** product only
- store-management deep links and `managed_by` display on mobile
- the full lifecycle transition matrix beyond initial purchase and expiry
- store-review paywall disclosures (trial terms, terms/privacy links)
- account-deletion store cancellation — **out of scope for the vertical, but a
  hard blocker on production enablement; see §12 step 6.5**

Each is a real requirement; none is needed to prove the vertical.

> **⚠️ Account-deletion store cancellation is not merely deferred — it is a
> charged-but-locked-out defect the moment purchases go live (2026-08-07, P1).**
> Verified: `requestDeletion` creates cancellation work only under
> `isStripeSubscriber` (`account-deletion.service.ts:183-216`) and
> `purgeStillDueUser` calls only `cancelStripe` (`:770`). No store cancellation
> exists anywhere in that service.
>
> So an Apple or Google subscriber who requests deletion is locked out
> immediately and **keeps renewing** through the 30-day grace and beyond. The
> audit already records this and its shape
> (`payments-subscriptions-audit.md:301-309`); what was missing is that §12
> assigned it no step, leaving it as a bullet in an out-of-scope list where it
> reads as optional polish.
>
> It is now §12 **step 6.5**, blocking step 7. The two stores need different
> handling and neither is a small change:
>
> - **Google** — a durable request-time stop-renewal
>   (`USER_REQUESTED_STOP_RENEWALS`) with retry, serialised with restoration under
>   the per-rider lock, modelled on the existing `deletion_cancel_failed` work item
>   rather than a best-effort call. **But see the blocker immediately below: with
>   the identity this design retains, that call cannot currently be made.**
> - **Apple** — **there is no server-side cancel.** Only the rider can cancel, in
>   their Apple ID settings. So this is a product-surface requirement, not an API
>   call: the deletion flow must tell the rider their subscription keeps billing
>   until they cancel it themselves, and the state must be durable enough for
>   support to see. Do not plan Apple as "the Google path with a different
>   client".
>
> **⚠️ TWO MORE THINGS STEP 6.5 MUST CARRY, BOTH FOUND 2026-08-07 (P1).**
>
> **1. The Apple "durable state for support" does not survive the purge.**
> `store_billing_reconciliations.user_id` is `REFERENCES users (id) ON DELETE
CASCADE` (`1822000000000-AddIapFoundation.ts:83`), and finalisation deletes the
> `users` row (`account-deletion.service.ts:801`). So if an Apple rider never
> cancels, the record evaporates at exactly the moment it becomes useful: 30 days
> on, the subscription is still renewing, the binding is gone, and support has
> nothing to work from.
>
> Step 6.5 needs a **purge-safe** record — its own table with no cascading FK (or
> `ON DELETE SET NULL`), written when deletion is requested.
>
> **Keep it minimal, and treat that as a requirement rather than tidiness:** this
> is a record about someone who asked to be erased. Store the store-side facts
> needed to recognise a still-billing subscription — provider, product,
> `original_transaction_id`, when it was last seen active — and **no Tarmoto
> personal data**: no name, no email, no user id once the row is gone. Give it an
> explicit retention limit tied to the subscription's own lifetime, not an
> unbounded one.
>
> **One deliberate exception: `purchase_account_token`, held only until erasure
> succeeds (corrected 2026-08-07, P1).** The retry in (2) below cannot identify the
> subscriber without it — that handle lives on the `users` row and disappears with
> it — so as first written, **every transient RevenueCat deletion failure became
> permanent third-party retention**. The work item therefore carries the opaque
> identifier, and **deletes it the moment erasure is confirmed**, leaving the
> minimal record behind.
>
> That is not a hole in the minimisation rule, it is the rule applied properly:
> the identifier is retained _for the sole purpose of completing the erasure the
> rider asked for_, and for no longer. A record that cannot finish the job it
> exists to do is not the privacy-preserving option.
>
> **2. Nothing erases the RevenueCat subscriber.** The purge deletes the Stripe
> customer (`account-deletion.service.ts:948`) and has no RevenueCat counterpart —
> so the local `users` row and its `purchase_account_token` disappear while the
> subscriber record created under that identifier, and queried for subscription
> history, remains at a third party. That is the same GDPR gap the Stripe
> deletion exists to close, on the newer provider.
>
> Step 6.5 adds a RevenueCat subscriber delete/anonymise call to finalisation,
> ordered after cancellation — **after it SUCCEEDS, not after it is attempted
> (corrected 2026-08-07, P1).**
>
> "After any cancellation attempt" was wrong in a way that reintroduces the exact
> failure step 6.5 exists to prevent. If the first stop-renewal call fails
> transiently and erasure runs anyway, the subscriber and its handle are gone —
> and the purge-safe item drops `purchase_account_token` once erasure is confirmed
> — so the durable cancellation retry can never fire and **the deleted rider keeps
> being charged indefinitely.**
>
> The two workflows are therefore ordered by outcome, not by sequence position:
>
> - **A server-side cancellation path exists** (the RevenueCat-proxy option):
>   erasure is **gated on cancellation success**. The work item keeps the handle
>   and retries until stop-renewal succeeds, then erases, then drops the handle.
> - **No server-side cancel is possible** (the rider-driven path, and Apple
>   always): there is no success to wait for, so erasure is not gated. The
>   purge-safe record carries the still-billing subscription for support, which is
>   what that record is for.
>
> **The local purge is never blocked by either.** The rider's own data is erased on
> schedule; it is the _third-party_ erasure that waits, as a durable work item that
> already outlives the row. A rider's right to erasure cannot be held hostage to a
> provider API, and equally cannot be used as a reason to leave them billed. One difference from the Stripe path
> is deliberate: Stripe's failure logs and continues, but an unerased subscriber is
> a standing data-protection gap, so a failure here must leave a **durable retry
> item**, not a log line. It must not block the local purge — the rider's erasure
> cannot wait on a third party — so the retry has to outlive the row that
> triggered it, which is the **same purge-safe storage as (1)**. Build them
> together.
>
> **⚠️ THE GOOGLE HALF IS NOT IMPLEMENTABLE AS WRITTEN (2026-08-07, P1).**
> "Else the store API directly" has no key to call with.
> `purchases.subscriptionsv2.cancel` is addressed by the **Play purchase token**,
> and §1 records — verified against both the webhook body and the subscriber API —
> that **RevenueCat never exposes it**. The schema agrees emphatically: migration
> 1830 renamed `google_purchase_token` → `google_store_transaction_id` precisely
> because the old name asserted something about its contents that was untrue, and
> what we store today is `google_original_transaction_id`. There is no token.
>
> So step 6.5's Google half needs one of these decided, not assumed:
>
> 1. **RevenueCat proxies a cancellation.** I wrote "where it proxies one" without
>    confirming one exists. This must be **verified in the step-4.5 provisioning
>    spike** — which makes that spike load-bearing for step 6.5, not only for open
>    item (f).
> 2. **Capture the purchase token client-side.** Play Billing hands the token to
>    the Android client at purchase time, so mobile could send it at binding and
>    the backend store it. That is a new contract, a new column, and a **sensitive
>    credential to hold** — this design already hashes the OTID so it never reaches
>    a Redis key or a log line, and a purchase token warrants at least that care.
> 3. **Rider-driven, exactly like Apple.** No new contract — but **not** "no new
>    storage": exactly like Apple means it inherits Apple's **purge-safe record**
>    too. A Google rider who never cancels is still renewing after the `users` row
>    and the RevenueCat subscriber are erased, and support then has no binding to
>    identify the charge — the same failure, on the other store. If this option is
>    selected, step 6.5's minimised, retention-bounded purge-safe record covers
>    **both** providers, not Apple alone. (Corrected 2026-08-07: it said "no new
>    storage", which made the cheap option look cheaper than it is.)
>
> **Note what (3) costs, because it contradicts something this document said one
> round earlier:** the Apple/Google split above warns "do not plan Apple as the
> Google path with a different client". If (3) wins, the reverse happens — Google
> becomes the Apple path, and the asymmetry that justified splitting them
> disappears. That is an acceptable outcome; it is not an acceptable surprise.
> Decide it in the spike.

## 6. Narrowing the native Apple path

**✅ BOTH STEPS ARE DONE (2026-08-07).** Step 1 shipped in PR #1131 (§12 step 3);
step 2 shipped in PR #1136 (§12 step 8) after the resequencing recorded below.
The original text is kept for its reasoning, but read "now" / "after sandbox" as
history, not as instructions — **§12's table is the authoritative order.**

~~Two steps, sequenced by risk.~~

**Step 1 — ~~now~~ ✅ done (PR #1131).** Unmount `POST
/account/subscription/iap/validate` from `AccountController`
(`account.controller.ts:142`) and drop its controller tests. The endpoint is
authenticated, reachable in every environment, and has zero callers; it is a live
surface with no purpose. One-line removal plus test updates.

**Step 2 — ~~after the vertical passes sandbox on both stores~~ ✅ done (PR
#1136), ahead of sandbox — see the resequencing block below.** Delete
`iap-validate.service.ts` (1,141) and its spec (2,573),
`apple-billing.client.ts` (779) and its spec (1,204), `apple-iap.config.ts`
(153) and its spec (310), `dto/iap-validate.dto.ts` (73), and unwire them from
`AccountModule` — roughly 6,200 lines.

_As executed the sweep was slightly wider than that list_: it also took
`test/fixtures/apple/transactions.ts` and `docs/reference/iap.md`, both dead once
their only importer went, and dropped the now-unused
`@apple/app-store-server-library` dependency — 6,233 lines total.

Migrations 1822–1825 are **not** reverted: their columns (`subscription_provider`,
`apple_original_transaction_id`, `google_original_transaction_id` — renamed in
step 4 and again when open item (b) was resolved, see §1 —
`subscription_store_signed_date`, the reconciliation reason) are all still used
by the RevenueCat path.

> **⚠️ STEP 2 RESEQUENCED (2026-08-07, product decision): delete NOW, not after
> sandbox.**
>
> The original text below argued that deleting before sandbox proof would discard
> a working fallback. **That argument was weaker than it was written.** The native
> path was never a usable fallback: it has no mobile client, no ASSN v2 lifecycle,
> and its endpoint is unmounted. If RevenueCat disappointed in sandbox, nothing
> here could be switched on — the "fallback" was ~6,200 lines that would still
> need a purchase client and a lifecycle consumer built before they did anything.
>
> Against that, the carrying cost turned out to be real and recurring. The Google
> identity column was renamed twice while this code sat unused, and `IapValidateService`
> is the direct source of the mis-recorded open item (c) — a reviewer compared
> `clearAppleTerminal` against its siblings, nobody read the caller that only
> exists to serve the dead path, and the "fix" would have introduced a bug. Dead
> code in a live file is a standing tax on every change in the area.
>
> So step 2 ran as its own PR (#1136), ahead of step 5. `claimForApple` /
> `clearAppleTerminal` were **not** included in it — they live in the shared
> `ProviderClaimService` and are removed by step 5's `claimForStore` collapse
> (open item (a)), which is when their replacement exists. They therefore sit in
> the tree today with **no caller at all**; that is expected, and open item (c)
> records the one behaviour that went down with `IapValidateService` and must be
> rebuilt rather than moved.

### Keeping a native implementation possible

Deleting the native path must not mean **locking in** RevenueCat. A future native
implementation stays open, and the architecture already protects that: §1's whole
premise is that **RevenueCat is an ingestion channel, not a provider**. Everything
that would survive a switch back is deliberately channel-agnostic:

- `SUBSCRIPTION_PROVIDERS` stays `['stripe','apple','google']`. There is no
  `revenuecat` provider value, and there must never be one — the moment a
  provider enum names the ingestion vendor, the vendor is load-bearing in the
  domain model.
- The identity columns (`apple_original_transaction_id`,
  `google_original_transaction_id`), `subscription_provider`,
  `SUBSCRIPTION_MANAGED_BY` (`app_store` / `play_store`) and the companion's store
  panels all describe the **store**, not the channel.
- `ProviderClaimService`, `SubscriptionMutationLockService`, the notification
  inbox, `store_billing_reconciliations` and the entitlement resolver are
  untouched by the choice of channel.

**What a return to native would have to rebuild**, recorded honestly so it is a
known cost rather than a discovery:

1. **Receipt verification** — the Apple JWS verifier, trust store and App Store
   Server API client. This is the bulk of the deleted lines.
2. **A state-time ordering key.** Native Apple has `signedDate`, a per-**state**
   JWS stamp; RevenueCat only offers a read-time key (open item (a)). The
   `subscription_store_signed_date` column holds either, but the guard's
   _semantics_ would tighten from "orders concurrent consumers" back to "state
   monotonicity". That is a strengthening, so it composes safely — a native path
   can reintroduce it without invalidating rows written by the channel-era.
3. **Identity retention on terminal clear.** The converged clear nulls the store
   id, correct while rider resolution goes through `app_user_id` (§2). A
   native path resolving riders by OTID would need retention back — and, with it,
   the tombstone-matching that PR #1134 showed is a lockout hazard unless the
   claim has a matching escape.
4. **Lifecycle ingestion** — ASSN v2 and RTDN endpoints, which were never built.

Points 2 and 3 are the ones to watch: they are _semantic_ reversals, not just
missing code, and both are recorded at their call sites rather than only here.

_Original reasoning, superseded:_ Deleting before sandbox proof would repeat the
mistake the audit flagged in the opposite direction — discarding a working
fallback ahead of evidence. Unmounting first removes the liability; deletion
removes the weight once it is safe.

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

**Backend.** **Cross-account binding (open item (j)): an authentic webhook naming
another rider's identifier must not be resolvable** — assert that a Tarmoto user
id supplied as `app_user_id` resolves to **no rider** once the binding moves to
`purchase_account_token`, and that the identifier endpoint returns only the
caller's own. This is the one authentication test that does not involve the
webhook secret. Then: webhook authentication (missing / wrong secret → 401, no inbox write;
**malformed JSON body with no secret → 401, not 400** — the case that proves the
auth middleware is mounted above the global `expressJson` and that fails silently
if someone reorders `main.ts`; **and a burst above 60 requests/minute from one IP
that is NOT throttled**, proving `@SkipThrottle()` is present — a decorator whose
absence is invisible until a real backlog replay drops events;
plus the **forged-body** pair that keeps §4's narrowed rationale honest — a valid
secret with forged _state_ fields applies the re-queried state and not the body,
while a valid secret with a forged `original_transaction_id` on an unbound rider
exercises whatever mitigation open item (g) selects. The second test cannot be
written until (g) is decided; if (g) is still open when step 5 starts, that is the
blocker to raise, not a test to skip);
inbox dedup on redelivered event id (and a redelivery of a still-`pending` row is
NOT short-circuited — but see the lease split in §4: assert a **live-lease** row is
not processed concurrently **and responds retryably rather than acknowledging**,
that an **expired-lease** row is reclaimed **by the sweeper with no further
delivery arriving**, that a **never-leased** `pending` row (crash between insert
and claim, both lease columns NULL) is reclaimed the same way — the case
`lease_expires_at < now()` silently drops — and that a handler whose lease lapsed cannot overwrite the
winner's `completed` row); re-query-not-event-body; the re-query happens **inside**
`runExclusive`, so a second concurrent delivery for the same rider reads only
after the first commits; an out-of-order delivery (older `request_date_ms`) does
**not** open a reconciliation row — but it is **only** an idempotent no-op when
persisted state equivalence is **proven**, so cover both branches per §4: an
**equivalent** miss completes the inbox row, while a **divergent** one (a
regressed timestamp carrying genuinely changed state — the refund case) must
leave the row **pending** and escalate, never complete. Do not write "ordering
miss ⇒ no-op" as a blanket assertion; that is the wording §4 had to correct,
and a test asserting it would bless leaving paid access active after a refund.
Cross-provider claim conflict **does** open a reconciliation row — and that row
must be written **inside the claim's advisory-locked transaction**, not after it
(§4 step 6): assert that a claim transaction rolled back after a conflict leaves
**no** reconciliation row, which is the assertion that catches a future move of
the insert back outside. Add the **zero-row** case explicitly — **sequenced, not
simultaneous**:

1. Hold the store claim's transaction open on a conflict (it has the rider row
   lock, and by §4 step 6 it has already inserted its conflict row).
2. **Start** the competing Stripe clear and the store redelivery. They block on
   the lock; that is the lock working, so do not wait on them.
3. Release the first transaction. Assert its **conflict row commits** — the insert
   is inside the locked transaction by design.
4. Let the clear and the redelivery proceed, and assert the redelivery's
   successful claim **retires** that row (`superseded_by_claim`), leaving **no
   open actionable row**.

> **Corrected 2026-08-07: the earlier version was unrunnable and asserted the
> wrong thing.** It had the clear and redelivery complete _while_ the first
> transaction was blocked, then asserted no conflict row was filed. With the
> unconditional rider lock they cannot complete — they wait — so the test either
> deadlocks or contradicts the lock it exists to validate. And §4 requires the
> insert **before** commit, so the row is written; the correct expectation is that
> it is **retired afterwards**, not never created.
>
> The end state is what matters and it is unchanged: **no open actionable row
> against a valid subscription.** Two mechanisms produce it together — the lock
> makes the classification and its row atomic, and retirement handles the
> invalidation that happens after commit, which no lock can reach. A test written
> against only the lock, as this one was, expects prevention where the design
> gives repair.

**Multi-subscription correlation (open item (b)).** A rider holding **two** Play
subscriptions, with an event naming one of them: assert the consumer applies that
subscription's state and leaves the other untouched — then repeat with the event
naming the _other_, so a consumer that simply picks the first entry fails. The subscriber API returns no original transaction identifier, so the correlation
cannot be verified from the response — this test is the only thing that pins it.

**Then the terminal case, which is a different problem: entitlement failover
(open item (h)).** An expiry for A while B is still active. Do **not** assert
"A's terminal state applies and B is untouched" — the `users` row holds one
provider, one store identity and one tier, so that is unsatisfiable, and it is
what this requirement said until 2026-08-07. Assert instead that the rider stays
**entitled on B**, that the store identity now names **B**, and that the tier
matches B's product. Then the same event with **no** other active subscription →
cleared to `free`.

**Conflict rows are retired, not just filed.** Every case below states the slot
state it sets up, because the resolution follows from the slot and nothing else —
writing the expected resolution without pinning the slot state is how case (b)
went wrong once already.

(a) **Slot claimed by this row's subject, during the claim.** A successful claim
resolves any matching open row **in the same transaction** with
`superseded_by_claim` — assert the row is `resolved`, not merely that entitlement
is correct.

(b) **Slot cleared by Stripe _after_ the conflict transaction commits, purchase
still active.** The point of this case is that no write-time lock can reach a
post-commit invalidation. The slot is now **empty**, so the drain must re-query
and **re-claim**: assert `claimed_on_drain` and an **entitled** rider — _not_
`stale_on_drain`, and not a closed row.

(c) **Slot empty, purchase still active, no later delivery.** Same expectation as
(b) by a different route: the drain re-queries, claims, resolves
`claimed_on_drain`, rider entitled.

(d) **Slot empty, purchase expired upstream.** `purchase_inactive`, rider stays
`free`, row closed. This is the only empty-slot case where closing is right.

(e) **Slot owned by another provider.** Row stays **open** — still actionable.

(f) **Slot owned by this row's subject at drain time** (claimed by some other
delivery in between). `stale_on_drain`. This is the _only_ case that resolution
covers.

Cases (b)-(f) must be asserted separately; an implementation that collapses them
into "conflict gone ⇒ close" passes a naive single test and strands paying riders.

(g) **The drain's re-claim records `claimed_on_drain`, not `superseded_by_claim`.**
Assert the label, not merely that the row closed — a claim path that hardcodes the
generic resolution passes (b) and (c) on every other assertion while silently
erasing the signal that the drain, rather than a webhook, did the work.

(h) **Two concurrent conflict inserts, both inside real claim transactions.**
Assert the loser is a **no-op** _and_ that its transaction **commits** — not that
it merely returned a row. This is the case that separates a working dedup from
`openConflict`'s current catch-and-requery, which poisons the transaction with
`25P02` and turns the promised no-op into an endless retry. A mocked manager
cannot produce `25P02`, so this one is meaningless off real Postgres. Terminal clear is identity-guarded against a stale
old-subscription event; stale-fence contention requeues rather than completing
the inbox row.

**Fence ownership — stated as invariants, because step 4.75 has not picked a
mechanism yet.** These eight cases are the acceptance criteria and must hold
whatever the harness selects. Do **not** write them against acquisition-stamping
or the equality guard: those are §4.75's leading candidate, not its conclusion,
and assertions that presuppose them would reject a safer design the harness might
prove necessary. (This block previously did exactly that — it hard-coded stamping
before `fn` and a fence bump on rejection.)

The invariants, and the cases that exercise them:

- **INV-A — ownership changes at a DURABLE HANDOFF, and no prior owner may commit
  after it.**

  > **⚠️ RESTATED 2026-08-07 — the previous wording was unsatisfiable, and that is
  > why every mechanism proposed in this review failed against it.** It said: a
  > writer that is no longer the current owner cannot commit, **tested in both
  > orderings** — including the ordering where the stale callback reaches its
  > transaction _before_ the new holder has recorded anything. At that instant
  > **nothing in the database distinguishes them**: Redis acquisition and a
  > PostgreSQL write cannot be made atomic, so there is no durable fact for a guard
  > to test. No correct design can pass that, and ten rounds of candidates failed
  > it in turn — not because each was wrong, but because the criterion was.
  >
  > **The ordering that looked like a bug is legal.** If the prior owner commits
  > before the handoff is durable, it committed while it was still the only owner
  > the database knew about. That write is not corruption; it is a write by the
  > then-current owner, and the incoming holder's own re-query supersedes it with
  > fresh state moments later. What must never happen is a prior owner committing
  > **after** the handoff is durable.

  So ownership must be **defined in the database, not in Redis** — either by making
  acquisition itself the durable write, or by naming an explicit handoff point and
  treating everything before it as the prior owner's legitimate tenure. Redis then
  serialises the flow; it does not decide who owns the rider.

  (i) The **rider** lease is lost mid-round-trip and a newer holder takes over.
  Assert: once the handoff is durable, the prior owner's write is **rejected**;
  and a write it committed **before** the handoff is **permitted and then
  superseded** by the new holder's re-queried state — assert the final persisted
  state is the new holder's, not that the earlier write never happened. Run both
  orderings **relative to the handoff**, which is now a well-defined instant.
  (iii) The **OTID** lease is lost after the ownership read — a separate case,
  since rider ownership says nothing about OTID ownership — asserting the stale
  callback claims nothing once OTID ownership has durably moved.

- **INV-B — a flow that rejects on ownership changes no rider-visible state.**
  Two cases, because there are two distinct ownership rejections and only one of
  them is same-rider:
  - **(ii-a) Same-rider exclusivity.** A Stripe claim against a rider whose slot
    is store-owned. `claimForStripe` guards `id = :id` plus
    `(subscription_provider IS NULL OR = 'stripe')`
    (`provider-claim.service.ts:231-236`), so this is the rejection it can
    actually produce. Assert **that rider's** entitlement columns are unchanged —
    tier, status, period end, provider, subscription id.
  - **(ii-b) Cross-rider store identity.** Two riders, one store identity, the
    loser rejected by the partial unique index (`23505`). Assert **both** riders'
    entitlement and identity columns. This needs `claimForStore`.

  Deliberately not a whole-row comparison in either: internal concurrency columns
  are the mechanism's business, and asserting on them is how this block became
  mechanism-coupled last time.

  > **Split 2026-08-07.** These were one case asserting "no change on either
  > rider", assigned to 4.75. That was unbuildable there: `claimForStripe` has no
  > cross-rider dimension at all — no store-identity guard, no `23505` path — so
  > seeding a store-owned slot produces a same-rider conflict with no second rider
  > to assert on. The cross-rider contract would have been silently untested while
  > a green test claimed otherwise.

- **INV-C — exactly one of two concurrent claims for the same store identity
  succeeds; WHICH one depends on the durable handoff.** After the handoff, the
  live-lease holder wins. Before it, the pre-handoff claimant wins and the live
  holder is the loser. The unconditional form — "the live-lease holder succeeds" —
  contradicted the split below it and is corrected here (2026-08-07); an
  implementation keyed to the headline alone received mutually exclusive criteria.
  (iv) **Two
  different riders claim the same previously-unowned OTID concurrently** — the
  cross-row uniqueness case that motivated the OTID mechanism, and which (iii)
  does **not** cover: (iii) is one stale callback losing its lease, not two riders
  racing for an empty identity. Assert exactly one wins, the loser's entitlement
  and identity columns are unmutated, and the loser's outcome is a **classified**
  conflict or retry — never a silent no-op. **Then run it again with one holder's
  OTID lease lapsed, in both schedules relative to the DURABLE OTID HANDOFF** — and
  assert the two schedules **separately**, because they have different winners:
  - **Handoff precedes the stale claim** → the **live holder wins**; the stale
    claim is rejected.
  - **Stale claim precedes the handoff** → the **pre-handoff owner wins** and the
    live holder becomes the `23505` loser, disposed via open item (d).

  > **Split 2026-08-07 — as one assertion it was self-contradictory.** It required
  > the live holder to win _and_ permitted the stale pre-handoff commit. Those
  > cannot both hold: the two callbacks are different riders, the binding is
  > exclusive, and the unique index makes whoever committed first the owner. So the
  > live holder is not merely "not superseding" — it is the loser, and must be
  > routed through (d) like any other cross-rider collision.

  > **Made handoff-relative 2026-08-07, for the same reason INV-A was.** This said
  > the live holder must win "even when the stale one reaches its transaction
  > first", which is unachievable before the new holder has recorded anything: the
  > database cannot distinguish two callbacks when neither has a durable
  > generation. A correct handoff-based design would have failed it.
  >
  > **But identity does not resolve the way state does, and that asymmetry is the
  > point.** INV-A can permit a pre-handoff write because the new holder's
  > re-query **supersedes** it on the same row. Here the two callbacks are
  > **different riders**, the binding is exclusive, and the unique index blocks
  > overwriting — so a pre-handoff binding cannot be superseded.
  >
  > **⚠️ And it must NOT go through §4 step 6's drain either — corrected within the
  > same day.** The first version of this paragraph sent the loser there. That
  > contradicts the ownership-safety rule this document states twice: a cross-rider
  > `23505` means the transaction is **already owned by another rider's row**, so
  > it "files nothing at all" and the victim's store id must **never** become a
  > drainable work item — an operator draining that queue would cancel or refund a
  > subscription that was always legitimate. Routing INV-C's loser into the drain
  > would have violated the contract INV-C exists to protect.
  >
  > The pre-handoff collision therefore takes **open item (d)'s non-drainable
  > disposal path** — whatever that turns out to be. Assert the loser mutates
  > **neither** rider's row and produces **no actionable reconciliation row**;
  > assert the disposal artifact (d) selects, once it selects one.
  >
  > **This makes (d) load-bearing a second time.** It already gained weight if the
  > OTID mechanism goes exclusion-only; now INV-C's pre-handoff branch needs it
  > too. (d) is no longer a tidy-up — two separate correctness paths terminate in
  > it, and neither can be finished until it is decided.
  >
  > So: **state supersedes, identity disposes.** Not "reconciles" — the drain is
  > the one place this must not go. A design that treats identity like state
  > leaves the binding with whichever rider committed first, permanently; a design
  > that treats it like an ordinary lost claim refunds a stranger. (v) **Two concurrent claim transactions for one rider**,
  > one of which has lost its Redis lease: exactly one commits, and the loser's
  > reconciliation row does not survive.

- **INV-D — cross-provider exclusivity holds in both directions.** Two cases,
  because the providers are **not symmetric implementations** — the Stripe writer
  lives in `account.service.ts` and takes no lock, the store writer is new in step
  5, and that asymmetry is the entire reason step 4.75 exists. Each also runs
  **both transaction orderings**.
  Both are **relative to the durable handoff**, exactly as INV-A and INV-C are —
  this was the third place carrying the impossible "both orderings" wording, and it
  was left behind when those two were corrected.
  - **(vi-a) Stale store, newer Stripe.** A store callback with a lapsed lease
    races a Stripe webhook that has become the newer holder. **After** the handoff
    is durable: the store claim is **rejected** and Stripe does **not** compensate.
    **Before** it: the store write is permitted **and stands** — Stripe cannot
    supersede it (see below); assert Stripe takes the ordinary **cross-provider
    conflict** path, which is correct behaviour and not a failure.
  - **(vi-b) Stale Stripe, newer store — the mirror.** A Stripe callback loses its
    rider lease to a newer store callback. **After** the handoff: the stale Stripe
    claim is rejected, the store purchase remains valid, no reconciliation row is
    filed against it, and no compensation is issued. **Before** it: the Stripe
    write is permitted **and stands**, and the later store claim takes the
    cross-provider conflict path.

    **Assert compensation by ROLE, not a blanket absence (corrected 2026-08-07).**
    The earlier wording — "no compensation was issued" — was aimed at the winner
    and written as an absolute, which would have blessed a rider left charged for
    an unusable store subscription:
    - **The winner is never compensated.** No cancel, no refund against the
      pre-handoff owner's valid subscription on the strength of anything
      downstream. This is the half the original sentence meant, and a refund
      genuinely cannot be undone.
    - **The loser IS closed out.** A proven-losing purchase that keeps billing with
      no entitlement is precisely what §4 step 6 exists to prevent, and the Stripe
      mirror already does this (`account.service.ts:1585-1612` treats a
      foreign-owned slot as cross-provider double-billing rather than a safe silent
      return). Closeout goes through the **revalidating** drain, not a blind
      cancel — the slot can change again after the row is filed.

    **And the two roles are not symmetric across providers.** A losing **Stripe**
    subscription can be cancelled and refunded server-side. A losing **store**
    subscription mostly cannot — Apple has no server-side cancel at all — so its
    closeout is the reconciliation row plus the rider-action path, the same
    asymmetry §12 step 6.5 carries. Asserting "the loser is closed out" therefore
    means different observable outcomes per provider, and the harness must expect
    the provider-appropriate one rather than a refund in both directions.

  > **⚠️ "The later holder supersedes" was wrong here, and asserting it would have
  > forced exclusivity to be weakened to pass (corrected 2026-08-07).**
  > `claimForStripe` accepts only a NULL or Stripe-owned row
  > (`provider-claim.service.ts:231-237`), and the store claim rejects Stripe
  > ownership symmetrically. So once either side owns the slot, the other **cannot**
  > overwrite it — it lands in the exclusivity-conflict path by design.
  >
  > **The unifying rule, since this is now the third place it bit:** _supersession
  > is only available where the later writer is permitted to overwrite._ Within one
  > provider's ownership of one rider, a re-query supersedes (INV-A). **Across
  > providers (INV-D) and across riders (INV-C), ownership is exclusive — so the
  > pre-handoff writer wins and the later one is conflicted or disposed.** A harness
  > that expects supersession in those two cases fails every correct
  > implementation.

  **"Both orderings" is not "both directions", and conflating them is how (vi-b)
  went missing.** Ordering permutes which transaction reaches its writes first;
  direction permutes which provider is the stale one. Only the latter exercises
  the other writer's code path, and (vi-b)'s failure mode — a valid store purchase
  refunded because a stale Stripe claim beat it — is the one with a rider-visible
  cost.

  Both fail against the system as it stands today and must keep failing until
  step 4.75 lands.

Write all eight **before** the fix. Step 4.75 is harness-first precisely because
six prose answers in a row were wrong, and a harness written after the fix tends to
encode the fix rather than test it.

**But they cannot all RUN in 4.75 — split by which writer they need (corrected
2026-08-07).** 4.75 is store-free by construction (§12), so a case needing
`claimForStore` cannot exercise the real implementation there. This is the same
circularity the drain split already fixed, reintroduced when the cross-provider
cases were added.

| Case                                     | Needs                              | Runs in |
| ---------------------------------------- | ---------------------------------- | ------- |
| (i) rider ownership lost mid-flow        | lock service + Stripe writer       | 4.75    |
| (ii-a) same-rider exclusivity reject     | Stripe writer, foreign-owned slot  | 4.75    |
| (ii-b) cross-rider store-identity reject | `claimForStore` + unique index     | **5**   |
| (v) two claim transactions, one rider    | two Stripe deliveries              | 4.75    |
| (iii) OTID ownership lost after the read | `runExclusiveByOtid` + store claim | **5**   |
| (iv) two riders, same unowned OTID       | `claimForStore`                    | **5**   |
| (vi-a) stale store vs newer Stripe       | both writers, concurrent           | **5**   |
| (vi-b) stale Stripe vs newer store       | both writers, concurrent           | **5**   |

**What 4.75 proves, and what it does not.** The fence mechanism lives in the lock
service and is provider-agnostic, so 4.75's three cases select it on real evidence
— two concurrent Stripe deliveries exercise ownership, lease loss, and commit
ordering completely. What they cannot exercise is the **asymmetry**: two writers
with different structure racing each other. So 4.75 selects the mechanism, and
**step 5 is not complete until (ii-b), (iii), (iv), (vi-a) and (vi-b) pass against
both real writers** — the same shape of gate as open item (g).

**One legitimate fixture, one illegitimate one.** Seeding a store-owned slot
directly in the database is fine for (ii-a): the Stripe writer is real, and
foreign-owned state is just its input. It is **not** fine for (vi-a)/(vi-b), which
test what the store writer _does while racing_ — a fixture cannot race. If those
two ever appear to pass in 4.75, they are passing against a synthetic path and
proving nothing.

**Mechanism-specific assertions — add these only once the harness has selected a
design, never before.** If acquisition-stamping plus the equality guard is what
survives: assert the rider's fence equals the new holder's token **before `fn`
runs**; assert an ownership-rejecting flow still leaves that bump (correct, not a
leak); and add a grep-level guard that no `nextval('subscription_lock_fence_seq')`
call exists outside the acquisition statement, so nobody reintroduces a
mint-without-stamp. If a different mechanism wins, these are wrong and its own
equivalents replace them.

**All eight must run against real Postgres and Redis, not mocks.** Every one is a
claim about what two concurrent transactions do at commit time; a mocked manager
returns whatever the test author expected and proves nothing — the same trap
`[[typeorm-lock-join-gotcha]]` records for pessimistic locks with relations. Six
consecutive review rounds moved this guarantee from a Redis TTL lease to an OTID
advisory lock, then a rider advisory lock, then the reconciliation insert inside
the transaction, then a shared cross-provider mechanism, then acquisition
stamping. Prose review found every one of them; prose review is exhausted.

For the **converged `claimForStore` and terminal clear** (open item (a)) — these
requirements were written against `claimForGoogle` / `clearGoogleTerminal` and
carry over to their replacement unchanged, since the collapse keeps the Google
semantics: the guard-level properties the Apple claim suite covers —
ownership/identity rejection, the read-ordering predicate, the fence, the atomic
once-per-rider trial stamp — **plus** the renewal case (same
`original_transaction_id` re-claims the same slot and advances the period end),
**plus** coverage for **both** providers rather than Google alone, since one
method now serves both.

**Not** the five-value return surface: per §3's scope correction the converged
claim deliberately follows `claimForStripe`, so a test asserting Apple's extra
returns would be testing machinery the consumer does not have. Two additions the
collapse brings with it: the terminal clear **nulls** the store identity for both
providers (assert it, and assert a subsequent re-subscribe with a **new**
`original_transaction_id` claims the freed slot — that is the #1134 lockout), and
the ordering miss must be **distinguishable from a genuine ownership conflict**
in the return value (open item (a)'s note), so assert they are not collapsed.

> **CORRECTION (2026-08-07, review of PR #1136).** This section previously
> required the pair to "mirror the existing Apple claim suite **including the
> retained-token binding**". That is superseded — retention is exactly the
> behaviour PR #1134 removed, because `claimForGoogle`'s equality-only identity
> guard has no escape hatch for a retained-but-unowned binding, so a retained id
> permanently locks out a re-subscribe (§3's correction has the full trace). The
> replacement property is that a terminal clear **nulls**
> `google_original_transaction_id`, and therefore that **a terminal-cleared slot
> is claimable by a later re-subscribe carrying a NEW original transaction id.**
>
> This is not weakened coverage. The old line pinned a storage detail; the new one
> pins the rider-visible outcome that detail was supposed to protect, and it is
> the assertion that would have failed on the shipped lockout bug. Keep the
> existing terminal-old → new-id repurchase test as its concrete form, and note
> that (f) owes a second one — **active-plan → store-confirmed replacement** —
> once sandbox settles whether Play issues a new lineage at all.

**Mobile.** Preflight disables purchase for an occupied provider slot;
purchase-then-delayed-webhook polls until the server reflects the entitlement and
does not report success early; poll exhaustion surfaces a recoverable state rather
than a silent failure; restore path; anonymous `app_user_id` blocks purchase.

**Sandbox E2E.** Purchase on **both** App Store sandbox and Play internal testing,
asserting the entitlement transition server-side at each leg.

**Renewal and cancellation are out of scope for the VERTICAL and are prerequisites
for ENABLEMENT — those are different things, and this paragraph used to blur them
(corrected 2026-08-07, P1).** It deferred both to "the lifecycle follow-up", which
named no step: §12 ended at 7, so the follow-up did not exist and step 7 could
enable real purchases with renewal and cancellation neither implemented nor tested.

The audit is explicit that this is not acceptable: enablement must run **purchase,
renewal, AND cancellation** loops on **both** stores, because "a purchase-only pass
never exercises lifecycle ingestion, so expiry/refund/cancel/renew handling could
stay broken while this step 'passes'"
(`payments-subscriptions-audit.md:684-689`).

So the deferral now names a real step — **§12 step 6.75, blocking step 7** — and
step 7's sandbox run covers **all three legs on both stores**, asserting the
entitlement transition at each. The vertical stays thin; enablement does not
inherit its thinness.

**"Assert the entitlement transition" is not enough for the cancellation leg —
name the required outcome.** A rider who turns off auto-renew mid-period has
**already paid** for the rest of it. Cancellation must therefore **preserve the
paid tier**, set `cancel_at_period_end`, and keep `current_period_end`; the tier
drops only when the period actually expires. The claim contract carries
`cancelAtPeriodEnd` (`provider-claim.service.ts:52`) for exactly this, and an
implementation reading "reflect the cancellation" as "clear the tier" would satisfy
a transition assertion while revoking access a rider bought.

The sandbox leg must therefore assert the **intermediate** state — cancelled,
still entitled, flag set, period end unchanged — **before** the expiry leg asserts
the drop. A test that only checks the end state passes on both the correct and the
broken implementation.

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

| Risk                                                                                 | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RevenueCat is a third party in the payment path                                      | Entitlements remain resolved from Tarmoto's own `users.subscription_tier`; RevenueCat is ingestion only. A RevenueCat outage stops _new_ purchases reaching us; it does not revoke existing riders.                                                                                                                                                                                                                                                                                                                     |
| 1% of tracked revenue above $2,500 MTR                                               | Free at current stage. Revisit at scale; the domain model stays store-native, so a later move back to direct ingestion changes the consumer, not the schema.                                                                                                                                                                                                                                                                                                                                                            |
| ~~Deleting ~6,200 hardened lines~~ **— DONE 2026-08-07, and the mitigation changed** | ~~Deletion gated behind sandbox proof (§6, step 2). Fallback preserved until then.~~ **Superseded**: the deletion ran ahead of sandbox (§6's resequencing block, §12 step 8), because the native path was never a usable fallback — no mobile client, no ASSN v2 lifecycle, endpoint unmounted. The real mitigation is that the domain model is channel-agnostic, so a future native implementation stays open: §6 → "Keeping a native implementation possible" records the four things a return would have to rebuild. |
| Webhook delay leaves a charged rider on `free`                                       | Bounded polling in the client (§5) plus the reconciliation row on a lost claim.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Sandbox provisioning blocks both platforms at once                                   | Ops items in §9 are tracked as their own delivery step, per the audit's P4 finding.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 12. Delivery sequence

**This table is the single authoritative delivery order.** Where any other
section still reads as a sequence — §6's "two steps, sequenced by risk", §11's
risk table, the open items' "step N" references — it defers to this. Each
numbered step is its own PR.

| #    | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 1    | Stripe 5a — entitling-status allowlist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ✅ done (PR #1131)                             |
| 2    | Stripe 5b — re-query + terminal routing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ✅ done (PR #1131)                             |
| 3    | Unmount `iap/validate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ✅ done (PR #1131)                             |
| 4    | Backend: the Google identity column (§1's **two** corrections) + `claimForGoogle` / `clearGoogleTerminal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ✅ done (PR #1134, binding corrected in #1135) |
| 8    | **Delete the native Apple path** — **resequenced, ran early**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ✅ done (PR #1136)                             |
| 4.5  | **Provisioning spike — four required outputs: (f) identity across a plan upgrade, **(b)** correlation with two simultaneous subscriptions, step 6.5's Google cancellation mechanism, and **whether RevenueCat exposes a replay source supplying BOTH rider discovery AND `original_transaction_id`** — a subscriber listing satisfies "a listing exists" while omitting the identity, which discovers the billed rider and still cannot call `claimForStore`; **either field missing is a NEGATIVE answer**, which forces the server-side fallback (a purchase-intent ledger written before the store call) — client-supplied repair is an accelerant and does not satisfy this. **The ledger is a DEGRADED substitute, not an equal one:** it supplies discovery but cannot supply `original_transaction_id`, so the repair grants entitlement with a **NULL identity binding** that the next renewal binds. Taking that route therefore also requires **(h)'s NULL-binding terminal strategy and its coverage** — a terminal arriving before the rebind matches nothing — so a negative answer here creates work in (h) as well, and must not be read as the question being closed (§4: without a discovery-and-identity source, scheduled reconciliation cannot find or claim a rider whose first webhook was lost — a negative answer forces choosing another mechanism **before** step 5, it does not defer).** RevenueCat project and a throwaway internal-testing build, with **two setups**: two base plans of one subscription for (f)'s replacement flow, and **two independent subscription products** for (b) — a second base plan replaces the first, so it can never produce the two simultaneously live subscriptions (b) needs — the subscriber response is keyed by product id and carries no original transaction identifier, so there is nowhere else to check it cheaply. **Record all four before teardown.** Skip only if RevenueCat support answers **all four** first — and for this one, only if the answer covers **both fields**. | **next** — not started                         |
| 4.75 | **Fence ownership + conflict retirement, harness-first — store-free half only.** Build the real-Postgres + real-Redis concurrency harness (both orderings, plus a forced stall between `acquire()` and the stamp), then land the fix it validates. Leading candidate: stamp the fence at acquisition and guard on **equality** (`fence = :mine`) instead of `<=`, dropping the untenable cross-system "token order = acquisition order" invariant; `publishFence()` **is deleted** — the harness selected acquisition-stamping, and the lease now exposes read-only `assertFenceCurrent()` in its place (shipped). Plus the unconditional rider row lock in the claim transaction, the `sbr_resolution_check` migration + entity union, and retirement-on-successful-claim **for `claimForStripe`**, which exists today. Touches live merged code. Runs harness cases (i)/(ii-a)/(v) only — the five needing a store writer run in step 5, which is not complete until they pass. **Blocks step 5.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **not started — newly required 2026-08-07**    |
| 5    | Backend: RevenueCat webhook consumer + **scheduled drift reconciliation** (an audit requirement the design had omitted — the inbox cannot recover an event that never arrived) + contract artifacts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | buildable — see the blocking note below        |
| 6    | Mobile: SDK, binding, paywall, preflight, purchase, poll-until-reflected, restore, one call site                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | not started                                    |
| 6.5  | **Account-deletion store cancellation — blocks production enablement.** Google: **mechanism undecided** — `subscriptionsv2.cancel` needs a Play purchase token RevenueCat never exposes, so this is a durable stop-renewal only if the step-4.5 spike finds an RC proxy or mobile starts capturing the token; otherwise it is rider-driven like Apple. Apple: no server-side cancel exists, so this is rider-action product copy plus **purge-safe** state for support — `store_billing_reconciliations` cascades on user delete, so the record must live in its own non-cascading, minimised, retention-bounded table. Also adds **RevenueCat subscriber erasure** to finalisation (the purge deletes the Stripe customer and has no RC counterpart), with a durable retry that outlives the purged row. **Where server-side cancellation exists, erasure waits for cancellation SUCCESS — not merely an attempt — and the work item retains `purchase_account_token` until both finish, then drops it.** Erasing after a transient stop-renewal failure destroys the handle the retry needs and leaves the deleted rider renewing indefinitely. Where no server-side cancel is possible (rider-driven, and Apple always), erasure is not gated. The local purge is never blocked by either. Today `requestDeletion` (`account-deletion.service.ts:183-216`) and `purgeStillDueUser` (`:770`) handle Stripe only, so a store subscriber who deletes is locked out and keeps being charged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **not started — newly required 2026-08-07**    |
| 6.75 | **Lifecycle transitions — renewal and cancellation, blocking step 7.** The work the vertical deferred as "the lifecycle follow-up", which until 2026-08-07 named no step at all. Covers the transitions that advance a paid rider's period and reflect a cancellation, on both providers, plus their ingestion paths. **Cancellation before period end must PRESERVE the paid tier** — set `cancel_at_period_end` and keep `current_period_end`; the tier drops only at expiry. Treating cancellation as terminal revokes access a rider has already paid for, and the claim contract carries `cancelAtPeriodEnd` precisely to prevent that. Without it step 7 can enable real purchases with renewal and cancellation neither implemented nor tested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **not started — newly required 2026-08-07**    |
| 7    | Ops enablement + sandbox E2E on both stores — **purchase, renewal AND cancellation legs**, entitlement transition asserted at each (audit: a purchase-only pass leaves lifecycle ingestion untested). Blocked by 6.5 and 6.75.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | not started                                    |

The numbers are kept as stable identifiers — cross-references throughout this
document say "step 8", so renumbering would break them. The **rows are in
execution order**, which is why 8 sits between 4 and 5.

**Step 4.75 excludes anything needing a store round trip — and that boundary was
a correction, not the original scope** (2026-08-07). As first written it also
promised revalidate-on-drain, which is circular: the drain must re-query the store
and attempt a claim, and neither a RevenueCat backend client nor `claimForStore`
exists at this commit (verified) — step 5 introduces both, and step 5 is blocked on
4.75. So the split is by dependency, not by theme:

| Work                                                                  | Step     |
| --------------------------------------------------------------------- | -------- |
| Fence ownership, rider row lock, concurrency harness                  | **4.75** |
| `sbr_resolution_check` migration + entity union                       | **4.75** |
| Retirement on a successful **Stripe** claim (`claimForStripe` exists) | **4.75** |
| Retirement on a successful **store** claim (`claimForStore`)          | **5**    |
| Drain revalidation — the three-outcome table, needs a store re-query  | **5**    |

Note what this leaves open in the interim: until step 5's drain lands, a conflict
row can still go stale. That is the **status quo**, not a regression 4.75
introduces — but do not read 4.75 as having closed the retirement gap. It closes
the write-side half.

**Step 4.75 was added after the design was otherwise settled** (review of PR
#1136). It is the only step that modifies already-merged production Stripe code
rather than adding new code, so it carries a different risk profile from
everything around it and does not belong folded into step 5. Its rationale is in
§4's acquisition-stamping correction: `mintFenceToken` issues tokens from a global
sequence without ever touching the rider's row, so `users.subscription_lock_fence`
names the last holder that got as far as publishing rather than the current one.
Its first framing — route every provider through a shared advisory-lock helper —
was superseded within the same review: mutual exclusion prevents overlap but does
not decide order, and the stale holder wins whenever it arrives first.

**Step 8 is done, not outstanding.** It originally sat last, gated on step 7's
sandbox proof; that gating was withdrawn by the product decision recorded in §6,
and the deletion shipped as its own PR ahead of step 5. It did **not** take
`claimForApple` / `clearAppleTerminal` — those live in the shared
`ProviderClaimService` and are removed by step 5's `claimForStore` collapse (open
item (a)).

Steps 1–3 were independent of everything else. Step 6 depends only on the `GET
/account/subscription` preflight contract, which already exists — so once step
5's route shape is agreed, mobile (6) and backend (5) can proceed in parallel.
Step 7 gates on 5 and 6 both being merged.

**What actually blocks step 5, item by item.** The earlier blanket "step 5 does
not start until the open items have answers" was wrong — it is what produced the
circularity corrected below. As of 2026-08-07:

| Item | Blocks building step 5?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a)  | **No.** The claim shape is settled; only its identity guard's replacement branch waits on (f).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| (c)  | **No, but must be carried.** The three-way zero-row classification has to be rebuilt onto the converged terminal clear from this document, since #1136 deleted its only implementation. That is work inside step 5, not a precondition.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| (d)  | **Partly.** "Mutate nothing" is settled and buildable. The **disposal mechanism** is not, and needs deciding during step 5 — see (d) for the constraints. **Two other paths now terminate in it:** INV-C's pre-handoff collision (§8) and, if the OTID mechanism goes exclusion-only, the loser's re-derivation (§4). It is no longer a tidy-up.                                                                                                                                                                                                                                                                                                                           |
| (f)  | **No — it gates ENABLING Play purchases.** Build with the equality-only guard; settle the replacement branch when 4.5 (or RevenueCat support) answers. Apple-only enablement is not gated at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| (b)  | **Blocks COMPLETING step 5, not starting it.** The identity field is settled; the **correlation** is not. The subscriber API keys subscriptions by product id and does not return an original transaction identifier, so with two Play subscriptions the consumer cannot verify which entry the event's `original_transaction_id` names. Applying the wrong entry writes one subscription's active-or-terminal state under the other's identity. Likely rule — match on the event's `product_id`, which keys the subscriber response — but **verify it in the 4.5 spike rather than assuming**, and land the two-subscription regression test in the same PR as the claim. |
| (g)  | **Blocks COMPLETING step 5, not starting it.** The NULL-identity branch accepts any event-supplied identifier and the re-query cannot verify it, so shipping the equality-only claim without a response leaves a poisonable first binding — and a poisoned one rejects the rider's own later expiry/refund, leaving entitlement active. Choose a response from (g) and land its regression coverage **in the same PR as the claim**, not after.                                                                                                                                                                                                                            |
| (h)  | **Blocks COMPLETING step 5.** A terminal event for one of a rider's two store subscriptions would clear the single identity slot and drop the tier to `free` while the other keeps billing. The terminal path must recompute entitlement from the full re-queried set rather than apply the event's terminality, switch the binding atomically (the `IS NULL OR = :otid` guards block a direct A→B move), and pick a deterministic winner when several remain entitling.                                                                                                                                                                                                   |
| (i)  | **Blocks COMPLETING step 5.** A divergent terminal miss currently only retries, and a retry can re-read the same regressed `request_date_ms` and fail identically — so refunded access stays active. Escalation must terminate in an action: bounded retries then a reconciliation item, or an audited override that applies the terminal state. Note the asymmetry — applying a terminal state wrongly self-corrects on the next renewal; leaving one unapplied never does.                                                                                                                                                                                               |
| (j)  | **Blocks BUILDING step 5 and step 6.** Not a decision — settled work that must be in scope. Rider ids are public via `PublicProfileDto.id`, so a modified client calling `Purchases.logIn(<victim id>)` binds its purchase to another rider's row with an authentic webhook and no secret: denial of entitlement at minimum, subscription transfer at worst. Mint an unguessable `users.purchase_account_token`, serve it only to the authenticated rider, resolve on it, and set RevenueCat's transfer behaviour deliberately.                                                                                                                                            |
| (e)  | **No.** Scheduled follow-up; rides along with step 5 or any later release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Except that (j) must land first** — it is not a decision but settled work: the
`app_user_id` cannot be the Tarmoto user id, so the resolution column, its
migration, the authenticated endpoint, and the mobile contract are all in scope
before the consumer resolves a rider at all.

So step 5 is otherwise **buildable now**, with **five** decisions to make inside it before
it can be called complete — (b) multi-subscription correlation, (d)'s disposal
mechanism, (g)'s first-binding response, (h) entitlement failover across
simultaneous subscriptions, and (i) the action a divergent terminal miss
terminates in — and (f)'s replacement branch as the one predicate that may be
deferred past merge, because (f) gates _enabling_ Play purchases whereas the other
five gate shipping correct behaviour at all.

> **This enumeration listed only (d) and (g) until 2026-08-07** — stale against
> the table directly above it, which had already gained (b), (h) and (i). A plan
> derived from it would have shipped without multi-subscription correlation
> (applying the wrong subscription's state), without failover (revoking a rider
> who is still being billed), and without a terminal-divergence action (retaining
> refunded access). Note that the warning below already said exactly this, and the
> paragraph went stale anyway: **updating the table is not enough — the prose that
> summarises it is a second copy and must move with it.**

> **Every new open item must be added to this table AND to the summary beneath it,
> in the same commit that creates it — and the same rule binds every OTHER row
> here.** _This rule was written after three such failures and did not stop the
> next two: the 4.5 and 6.5 rows both went stale again in a single commit, hours
> after it was added._ Treat that as evidence about the **shape**, not about
> diligence — a row that restates a decision is a copy, and copies drift. Where a
> row can carry the decision-relevant constraint and point at §4–§8 for the rest,
> prefer that to restating the argument.\*\* Each §12 row is a second copy of a decision argued somewhere in §4–§8:
> the 4.5 spike, the 4.75 fence work, the 6.5 cancellation scope. Changing the
> argument without changing its row leaves a planner reading the authoritative
> table a version that was corrected hours ago. That has now happened to the 4.5
> row, the 4.75 row, and this summary, each after the detailed section was already
> right.\*\* This table has now gone stale four times — twice against the
> delivery order, once against the blocker list — each time because a correction
> was written where the argument was and not where the decision is read. An item
> that exists only in §4 is invisible to anyone planning from §12.

> **⚠️ CIRCULARITY, and how it is broken (2026-08-07).** The paragraph above, read
> with the table, deadlocks: **(f)** demands a real Play sandbox upgrade before
> step 5 may be built, but the RevenueCat SDK lands in step 6 and store
> provisioning in step 7 — which itself gates on 5 and 6. Nothing in the repo can
> produce that observation today, so under a literal reading **(f)** can never be
> answered and step 5 can never start.
>
> Two corrections, and the second matters more than the first:
>
> **1. A provisioning spike runs BEFORE step 5** — inserted below as step **4.5**.
> It is the smallest slice of steps 6–7 that can produce the observation, not a
> full delivery of either.
>
> **2. (f) does not actually gate BUILDING the consumer — it gates ENABLING Play
> purchases.** This is the part the earlier wording got wrong by treating one
> unsettled predicate as a block on the whole step. Everything else in §4 —
> webhook authentication, the inbox with its pending/completed distinction,
> the re-query then the claim under the lock, with **whatever fence discipline the
> step-4.75 harness selects** (see §4 — acquisition stamping with no publish step
> is the leading candidate, not a settled fact, and this summary must not be read
> as prescribing it), the ordering key, the claim, the
> terminal clear, reconciliation on a lost claim — is entirely independent of how
> a Play _replacement_ presents its lineage. Only the identity guard's
> replacement branch depends on (f), and it is **equality-only today**, which is
> correct for every case except a possible one.
>
> So step 5 proceeds, with the replacement branch as its single deferred
> decision, and (f) must be answered before Play purchases are enabled for real
> riders rather than before the first line is written. An Apple-only enablement
> is not blocked by (f) at all — the Apple in-group upgrade keeps the same OTID
> (see (f)), so the equality guard is known-correct there.
>
> **A cheaper path than a sandbox loop may settle (f) outright:** RevenueCat
> support has already given a precise, quotable answer on the closely-related
> `store_transaction_id` renewal behaviour (see (b)). Asking them directly whether
> a Play plan replacement changes `original_transaction_id` may resolve this with
> no build at all. Try that first; the spike is the fallback, not the default.

**Step 4.5 — provisioning spike, answering (f) AND step 6.5's cancellation
mechanism.** Smallest possible slice: a RevenueCat project, Play Console
subscription products with **two** plans, an internal-testing build carrying just
enough SDK to buy and then upgrade, and one observation of whether the resulting
webhook's `original_transaction_id` changes.

**Second required output, added 2026-08-07:** whether RevenueCat exposes a
**cancellation / stop-renewal** operation it can proxy to Play. §12 assigns step
6.5's Google mechanism to this spike, and the spike as originally written never
looked — so it could have been completed and torn down with 6.5 still impossible,
because the Play API needs a purchase token RevenueCat does not expose. Settle it
here: check the API surface, and ask RevenueCat support directly, since a negative
answer is as decisive as a positive one and forces step 6.5 to the rider-driven
option. **Record both outputs before tearing the project down** — reprovisioning
to answer a question the spike was already assigned is pure waste.

**Third required output: the multi-subscription correlation (open item (b)) — and
it needs a DIFFERENT setup from (f).** (b)'s blocker row already says "verify it in
the 4.5 spike"; the spike did not list it.

**Two plans is the wrong shape for this.** Buying a second **base plan** of the
same Play subscription **replaces** the first — that is precisely the
upgrade/replacement flow (f) exists to observe, and it never yields two
simultaneously live subscriptions. Correlation is unexercised, and the spike can
record its outputs as complete while (b) is untouched.

So the spike provisions **two independent subscription products**, buys them
**separately**, and observes how an event identifies which subscriber entry it
refers to — the response is keyed by product id and carries no original
transaction identifier, so this is the only cheap place the rule can be checked.
Run it as its **own flow**, not as a step of the replacement experiment. Same
teardown rule: record it first.

**Fourth required output: whether a replay source exists that supplies BOTH rider
discovery AND the stable store identity** (§4's first-purchase correction —
load-bearing, not a cost question).

**"Does a changed-since listing exist" is the wrong question, and would be
answered yes by something useless.** If the listing returns **subscribers**, it
carries what the subscriber API carries — and that API does not return
`original_transaction_id`. The sweeper would then discover the billed rider and
still be unable to call `claimForStore`. Only a source that replays **events**, or
otherwise exposes the identifier, answers this.

So the spike records the answer as positive **only if both fields are present**,
and treats **either one missing as a negative answer** — which, per the delivery
row, forces choosing another discovery mechanism before step 5.

It produces **recorded answers in (f), (b), 6.5 and the replay question**, not
shippable code — and its SDK
integration is throwaway if step 6 later does it properly. Skip the build entirely
if RevenueCat support answers **all four** questions first.

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
