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
> resolution is a primary-key lookup on the webhook's `app_user_id` (§2) — the
> store transaction id is never used to resolve the rider. The rationale was
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

## 4. Backend: the RevenueCat webhook consumer

`POST /account/subscription/revenuecat/webhook`.

**Authentication.** A shared secret in the `Authorization` header, configured
RevenueCat-side, compared in constant time against
`TARMOTO_REVENUECAT_WEBHOOK_SECRET`. Verified **before** the envelope is parsed or
persisted. A missing or wrong secret is a 401 with no inbox write.

This is a static shared secret with no per-event body signature — genuinely
RevenueCat's model, unlike Apple's signed JWS payloads. Record why the design
survives that weaker guarantee, so nobody "optimises" it away later: it holds
**only** because step 2 re-queries authoritative state from RevenueCat's own
subscriber API rather than ever trusting the event body. A caller who knows the
shared secret and forges an event carrying a victim rider's real `app_user_id`
cannot inject arbitrary state — the handler ignores the forged payload's fields
and re-fetches that same rider's actual, true subscriber state, then reapplies
it under the per-rider lock. The forged delivery degrades to an idempotent
no-op re-application of the victim's own real state, not a forgery vector. The
event body is a trigger to go look, never a source of truth. Do not later trust
fields on the event body (tier, status, dates) directly for a latency or
simplicity win — that reintroduces exactly the forgery surface this design
avoids, and it is the re-query, not the secret, doing the correctness work.

**Processing order:**

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
   handled. Treating any unique-constraint hit as "done" would silently drop
   an event that never actually applied. The insert path therefore needs an
   explicit existence-and-status check (or an `INSERT ... ON CONFLICT` that
   only short-circuits when the existing row's status is `completed`), not a
   bare "unique constraint violation means duplicate" catch. This is the
   precise rule the failure-handling paragraph and the stale-fence paragraph
   below both assume but never state outright.

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

### OPEN ITEMS — must be resolved BEFORE step 5 is planned

> **Recorded 2026-08-06, at the final review of step 4.** These are **defects in
> this spec**, not in step 4's implementation. They were found while reviewing
> `claimForGoogle` / `clearGoogleTerminal` against this section, and each one
> makes an instruction in §4 unbuildable or unsafe as written. They are recorded
> rather than fixed because every one of them is a step-5 design decision, and
> guessing at them inside step 4 would be exactly the machinery-ahead-of-workload
> the §3 scope correction warns against. **Do not code step 5 until each has an
> answer here.**

**(a) §4 step 4 routes Apple through `claimForApple`, which RevenueCat cannot
feed.** Step 4 above says the consumer calls "`claimForApple` / `claimForGoogle`".
But `claimForApple` requires a `signedDate` — Apple's JWS state stamp — plus the
three CAS baseline fields (`observedProvider`, `observedOriginalTransactionId`,
`observedSignedDate`), and returns five values. **RevenueCat provides no JWS**, by
the same reasoning §1's correction used to establish there is no Play purchase
token. After §6 step 2 deletes `IapValidateService`, the RevenueCat consumer
becomes `claimForApple`'s **only** caller, and it cannot satisfy that contract
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

**(b) ✅ RESOLVED (2026-08-07) — the binding is `original_transaction_id`.** The
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

_Still owed by step 5, and NOT covered by this resolution:_ confirm against a real
RevenueCat payload for a renewed Play subscription **which field of the chosen
transport** carries it — the webhook event body exposes `original_transaction_id`
directly, but the **subscriber API** response (which §4 step 2 re-queries as the
authoritative source) exposes `store_transaction_id` per subscription and does not
obviously surface `original_transaction_id`. If the authoritative re-query cannot
yield the original id, step 5 must either take the id from the event body (having
first justified that against §4 step 2's re-query rule) or derive it. **Do not
paper over this by falling back to `store_transaction_id`** — that is the defect
this item exists to prevent.

**(c) `clearAppleTerminal` does not satisfy §4's stale-fence rule.**
`provider-claim.service.ts:933` returns `(affected ?? 0) > 0` with no
`assertSubscriptionFenceCurrent` call, unlike `clearStripeTerminal`,
`claimForStripe`, `claimForGoogle` and `clearGoogleTerminal`. The stale-fence
paragraph directly above — that lease-loss contention is a retryable 503 rather
than an ordering no-op — is therefore **false today for the Apple terminal path**:
a lost lease silently returns `false`, and the consumer acks a real refund or
expiry that never applied. This is pre-existing and out of step 4's scope, but
step 4 makes the asymmetry load-bearing by giving the Google terminal the correct
behaviour on the same code path the same consumer will call.

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
`apple_original_transaction_id`, `google_original_transaction_id` — renamed in
step 4 and again when open item (b) was resolved, see §1 —
`subscription_store_signed_date`, the reconciliation reason) are all still used
by the RevenueCat path.

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
4. Backend: rename the Google identity column (§1 correction) + `claimForGoogle` /
   `clearGoogleTerminal`
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
