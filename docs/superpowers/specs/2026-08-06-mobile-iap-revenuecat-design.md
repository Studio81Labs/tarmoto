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
> **§8 now says so directly** (updated 2026-08-07); this sentence is kept as the
> reasoning trail, not as outstanding work.

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

**Processing order.** Step 1 runs on its own. **Steps 2–5 then all run inside a
single `SubscriptionMutationLockService.runExclusive(userId, …)` critical
section — the lock is acquired BEFORE the re-query, never between the re-query
and the write** (see the correction below the list). Steps 6–7 follow it.

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

**And assert the OTID lease immediately before publishing/claiming — holding two
locks means reasserting two leases.** `SubscriptionOtidLockLease` exposes its own
`assertHeld()` for exactly this, and it is **not** covered by `publishFence()`,
which reasserts only the **per-rider** lease (its doc: _"REASSERTS the rider
lease (token-checked PEXPIRE) BEFORE the fence UPDATE"_).

The gap that leaves: the OTID lease can expire **independently** after the
foreign-ownership read — the RevenueCat round trip sits inside this nesting, so
the window is not small. Another rider then legitimately acquires the OTID lock
and **also** observes the identity as unowned, while this stale callback happily
publishes its rider fence (whose own lease is still valid) and races the unique
index. That is precisely the mutation-before-ownership-conflict window the
nesting was added to close, reopened one level down.

So: `await otidLease.assertHeld()` immediately before the fence publish and the
claim, not merely at OTID-lock acquisition. Required coverage: **OTID lease lost
after the ownership read**, asserting the stale callback publishes nothing —
distinct from the rider-lease-loss case, which `publishFence()` already handles
and which a test for one does not exercise for the other.

**Inside that nesting, `await lease.publishFence()` runs after the
re-query and the foreign-ownership check, but BEFORE any guarded write.** Mutual
exclusion alone does not close the lease-loss race — if Redis heartbeat renewals
fail during the RevenueCat round trip the lease expires, another delivery
acquires the lock, and this stale callback could still write with its lower fence
token — but publishing is what closes it, and `publishFence()` **reasserts the
lease before its own UPDATE and throws a retryable 503 if it was lost**. So the
race is closed by publishing _before the writes_, not by publishing _first_.

> **⚠️ Corrected twice — read this before reordering anything.** An earlier
> revision said publishing was unnecessary (wrong: mutual exclusion is not
> enough). The fix then over-corrected to "the **first** statement inside the
> lock", copying the Stripe ordering without checking whether Stripe's rationale
> transfers. **It does not**, and the copy broke a different contract.
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
> **Why Stripe legitimately differs.** Stripe publishes before its re-read
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
> **So `publishFence()` must precede the guarded writes** — and, per the
> correction in the processing order above, must _follow_ the re-query and the
> foreign-ownership check, because publishing is itself a mutation and an
> ownership conflict must write nothing. `publishFence()` reasserts the lease
> before its own UPDATE and raises a retryable 503 if it was lost, so deferring
> it past the re-query does **not** reopen this race — the abort happens at
> publication rather than at lock entry. Required coverage: **lease lost during
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
status, an expiry — that grants something the store never granted. Identity is not
vulnerable in that way, and §4's authentication rationale already carries the
argument: a forged event naming a victim's `app_user_id` merely causes their own
real, re-queried state to be re-applied, which is idempotent. The same holds for a
forged `original_transaction_id` — it selects _which_ slot to re-apply
authoritative state to, and the claim's ownership/identity guards then reject any
attempt to point it at a slot the caller does not own.

**Step 5 must still handle the correlation**, which this does not settle: the
re-query returns subscriptions keyed by product id, so the consumer has to
establish that the entry whose state it applies is the same subscription the
event's `original_transaction_id` names. Getting that wrong would apply one
subscription's state under another's identity. Pin it with a test covering a rider
holding two Play subscriptions.

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
> rider by it; §2 makes rider resolution a primary-key lookup on `app_user_id`, so
> retention buys nothing here — and PR #1134 showed retention actively causes a
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
   id, correct while rider resolution is a PK lookup on `app_user_id` (§2). A
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

**Backend.** Webhook authentication (missing / wrong secret → 401, no inbox write);
inbox dedup on redelivered event id (and a redelivery of a still-`pending` row is
NOT short-circuited); re-query-not-event-body; the re-query happens **inside**
`runExclusive`, so a second concurrent delivery for the same rider reads only
after the first commits; an out-of-order delivery (older `request_date_ms`) does
**not** open a reconciliation row — but it is **only** an idempotent no-op when
persisted state equivalence is **proven**, so cover both branches per §4: an
**equivalent** miss completes the inbox row, while a **divergent** one (a
regressed timestamp carrying genuinely changed state — the refund case) must
leave the row **pending** and escalate, never complete. Do not write "ordering
miss ⇒ no-op" as a blanket assertion; that is the wording §4 had to correct,
and a test asserting it would bless leaving paid access active after a refund.
Cross-provider claim conflict **does** open a reconciliation row; terminal
clear is identity-guarded against a stale old-subscription event; stale-fence
contention requeues rather than completing the inbox row.

**`publishFence()` sits between the ownership check and the writes, and lease
loss during the RevenueCat API call is covered.** Three cases: (i) the fence is
published **before any guarded write** — assert the ordering, not merely that it
happens; (ii) an **ownership conflict publishes nothing** — assert
`subscription_lock_fence` is unchanged on _both_ riders' rows, which is the
assertion that catches a future "optimisation" moving publication back to lock
entry; and (iii) the **rider** lease is lost **mid-round-trip** and a newer holder publishes
a higher token, after which the stale callback's write must be **rejected**, not
applied; and (iv) the **OTID** lease is lost after the ownership read — a separate
case, since `publishFence()` reasserts only the rider lease, so a test for (iii)
does not exercise it — asserting the stale callback publishes nothing and claims
nothing. Case (ii) is what the "second delivery reads only after
the first commits" assertion silently presumes and cannot itself demonstrate — a
lost lease is precisely the situation where that presumption fails.

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

| #   | Step                                                                                                                                                                                                | Status                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | Stripe 5a — entitling-status allowlist                                                                                                                                                              | ✅ done (PR #1131)                             |
| 2   | Stripe 5b — re-query + terminal routing                                                                                                                                                             | ✅ done (PR #1131)                             |
| 3   | Unmount `iap/validate`                                                                                                                                                                              | ✅ done (PR #1131)                             |
| 4   | Backend: the Google identity column (§1's **two** corrections) + `claimForGoogle` / `clearGoogleTerminal`                                                                                           | ✅ done (PR #1134, binding corrected in #1135) |
| 8   | **Delete the native Apple path** — **resequenced, ran early**                                                                                                                                       | ✅ done (PR #1136)                             |
| 4.5 | **Provisioning spike to answer (f)** — RevenueCat project, Play products with two plans, throwaway internal-testing build, one plan upgrade observed. **Skip if RevenueCat support answers first.** | **next** — not started                         |
| 5   | Backend: RevenueCat webhook consumer + contract artifacts                                                                                                                                           | buildable — see the blocking note below        |
| 6   | Mobile: SDK, binding, paywall, preflight, purchase, poll-until-reflected, restore, one call site                                                                                                    | not started                                    |
| 7   | Ops enablement + sandbox E2E on both stores                                                                                                                                                         | not started                                    |

The numbers are kept as stable identifiers — cross-references throughout this
document say "step 8", so renumbering would break them. The **rows are in
execution order**, which is why 8 sits between 4 and 5.

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

| Item | Blocks building step 5?                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a)  | **No.** The claim shape is settled; only its identity guard's replacement branch waits on (f).                                                                                                                                          |
| (c)  | **No, but must be carried.** The three-way zero-row classification has to be rebuilt onto the converged terminal clear from this document, since #1136 deleted its only implementation. That is work inside step 5, not a precondition. |
| (d)  | **Partly.** "Mutate nothing" is settled and buildable. The **disposal mechanism** is not, and needs deciding during step 5 — see (d) for the constraints.                                                                               |
| (f)  | **No — it gates ENABLING Play purchases.** Build with the equality-only guard; settle the replacement branch when 4.5 (or RevenueCat support) answers. Apple-only enablement is not gated at all.                                       |
| (e)  | **No.** Scheduled follow-up; rides along with step 5 or any later release.                                                                                                                                                              |

So step 5 is **buildable now**, with (d)'s disposal mechanism as a decision to
make inside it and (f)'s replacement branch as the one deferred predicate.

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
> the re-query then `publishFence` under the lock (that order — see §4), the
> ordering key, the claim, the
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

**Step 4.5 — provisioning spike to answer (f).** Smallest possible slice: a
RevenueCat project, Play Console subscription products with **two** plans, an
internal-testing build carrying just enough SDK to buy and then upgrade, and one
observation of whether the resulting webhook's `original_transaction_id` changes.
It produces a **recorded answer in (f)**, not shippable code — and its SDK
integration is throwaway if step 6 later does it properly. Skip it entirely if
RevenueCat support answers the question first.

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
