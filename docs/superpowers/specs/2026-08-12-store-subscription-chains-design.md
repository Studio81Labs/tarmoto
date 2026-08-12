# Store subscription chains — giving each store subscription its own row

**Status:** design, not yet built. Decided 2026-08-12.
**Supersedes:** the single-slot store binding in
`docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md` — that document's
open items **(f)**, **(b)** and **(h)**, and the "one nullable store id column per
provider" shape §1 assumed.

## Why this exists

RevenueCat support (ticket `ZERPGP-3L1PN`, 2026-08-12) confirmed that a Google Play
base-plan change **rebases** `original_transaction_id`: Google treats the replacement as
a new purchase with a new purchase token and order root. Their recommendation was to stop
treating that identifier as a rider's permanent link and instead _"allow the same rider to
have more than one store transaction chain."_

The rider-link half of that advice is already how this system works — §2 of the RevenueCat
design resolves riders by `app_user_id` against `users.purchase_account_token`, and the
store identifier has never been the rider link. The load-bearing half is about
**exclusivity**, and it lands on storage: `users.apple_original_transaction_id` and
`users.google_original_transaction_id` are one nullable column each, so a rider can hold
exactly one chain per provider and `claimForGoogle`'s guard
(`provider-claim.service.ts:344-350`) is equality-only.

Three open items in that document are the same single-slot assumption seen from three
angles:

| Item    | Symptom                                                                                  |
| ------- | ---------------------------------------------------------------------------------------- |
| **(f)** | A plan upgrade presents a new chain id; the equality guard rejects it as a conflict.     |
| **(b)** | With two subscriptions, the consumer can't tell which one an event refers to.            |
| **(h)** | A terminal for one subscription clears the single slot and revokes a rider still paying. |

All three are pre-launch: mobile IAP ships both stores together (product constraint,
2026-08-12), so none of them can be deferred behind an Apple-only enablement.

### The argument that decides it

The equality guard's job was to stop a rider holding two subscriptions. It cannot do that.
It only stops us **recording** the second one — Google bills the rider either way. Refusing
to write the row does not prevent double-billing; it makes us blind to it, and then the
rider pays twice while sitting on `free` because the claim returned `'conflict'`.

Recording both chains and flagging the overlap is strictly better: the rider keeps the
entitlement they paid for, and ops gets a reconciliation item that can actually be
actioned. That inverts the old rule — **detect and reconcile, do not refuse to persist** —
and it is what removes the need for the store-confirmed-supersession signal RevenueCat
cannot give us.

### The precedent this mirrors

This is the same refactor #1132 already performed one level up, and deliberately follows
its staging. `apps/backend/src/modules/account/entitlement.ts` records the reasoning:
grants and subscriptions shared `subscription_tier`, so every writer had to re-derive
_"is this tier mine to touch?"_ — a predicate that reached three spellings in one PR and
cost six review rounds. Migration 1836 gave grants their own columns and entitlement
became `higherTier(grant_tier, subscription_tier)`; the predicate disappeared because each
writer owns exactly one side.

Store chains are the same shape: every store writer currently re-derives _"is this event
about the chain I have stored?"_ against a slot that cannot represent the truth. Give each
chain its own row and that question is answered by a primary key.

## Scope: store providers only

The table holds **`apple` and `google`**. Stripe stays on the `users` row.

Stripe has no defect behind the move: a Stripe plan change keeps the same
`stripe_subscription_id` — which is precisely why the audit scopes (f) to Play — and our
Checkout flow cannot produce two simultaneous Stripe subscriptions. Migrating the
most-hardened writer in the system (PR #1123's ~32 rounds of lock, fence and lease work)
with no defect driving it is the machinery-ahead-of-workload the RevenueCat spec's §3 scope
correction exists to prevent.

The columns are nevertheless **provider-generic**, so Stripe can move in later as rows
rather than as a reshape. That is a compatibility property, not a plan.

## Storage

New table `store_subscriptions`, one row per (rider, chain).

| Column                      | Type          | Notes                                                                                                                                                                   |
| --------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | uuid pk       |                                                                                                                                                                         |
| `user_id`                   | uuid → users  | **Cascades on delete** — this is live entitlement state. The purge-safe support record required by step 6.5 is a _separate_, non-cascading table; do not conflate them. |
| `provider`                  | varchar(16)   | `apple` \| `google`                                                                                                                                                     |
| `original_transaction_id`   | varchar(1024) | RevenueCat's `original_transaction_id` — the chain identity                                                                                                             |
| `product_id`                | varchar(255)  | **New.** RevenueCat's product identifier — the (b) correlation key                                                                                                      |
| `tier`                      | varchar(16)   | What this chain entitles                                                                                                                                                |
| `status`                    | varchar(16)   | `active` \| `trialing` \| `past_due` \| `canceled`                                                                                                                      |
| `current_period_end`        | timestamptz   |                                                                                                                                                                         |
| `cancel_at_period_end`      | boolean       |                                                                                                                                                                         |
| `store_signed_date`         | timestamptz   | The ordering key (`observedAt`) — now **per chain**                                                                                                                     |
| `lock_fence`                | bigint        | Stamped from the same per-rider token; guards stay `<= :token`                                                                                                          |
| `created_at` / `updated_at` | timestamptz   |                                                                                                                                                                         |

Indexes:

- **unique `(provider, original_transaction_id)`** — replaces
  `uq_users_google_original_transaction_id` and Apple's equivalent, and preserves the
  property they were really enforcing: a chain belongs to exactly one rider. This is the
  cross-rider protection, and it must not be dropped in the move.
- `(user_id)` for the live-set read.
- partial `(user_id) WHERE status <> 'canceled'` if the resolver's plan needs it — measure
  before adding.

**`store_signed_date` moving per-chain is a fix, not just a relocation.** Today one
rider-level `users.subscription_store_signed_date` is shared by every provider, so an event
for chain B advances the ordering key that a later event for chain A is then checked
against — a late-but-valid A event is silently dropped as stale. Per-chain ordering removes
a whole class of cross-chain interference that exists in the current code and has no test.

## Entitlement

`resolveEntitledTier` stays the single seam. The subscription side becomes a max over live
chains rather than a column read:

```
higherTier(grant_tier, max(stripe side, max over LIVE store chains))
```

**Live** means an entitling status with an unexpired period. `past_due` **is** entitling —
that is existing vocabulary, not a new rule, and getting it wrong silently de-entitles
riders in billing retry.

The properties this buys, structurally rather than case-by-case:

- **(f)** — an upgrade inserts chain B alongside chain A. Nothing has to decide whether B
  is "allowed" to replace A, so the store-confirmed-supersession signal RevenueCat cannot
  provide is no longer needed. A ends on its own terminal event or period end.
- **(h)** — a terminal marks one chain `canceled`; the others are untouched and entitlement
  recomputes from what remains. The "recompute from the full re-queried set" requirement
  becomes the only thing the code can do.
- **(b)** — correlation is `(provider, original_transaction_id)` against our own table, a
  primary-key lookup. It does **not** fully close (b): verifying a chain against
  RevenueCat's subscriber API on re-query still runs into an API keyed by product id with
  no original transaction id. `product_id` exists on the row for exactly that, and the
  spike is still the thing that proves it. What changes is the blast radius — a failed
  correlation now degrades a re-query instead of corrupting a binding.

## The response projection — what a single-valued API returns for many chains

Entitlement being a max says what the rider is _entitled to_, not what the API _shows_.
`SubscriptionSnapshotResponseDto` exposes one `current_plan` (`tier`, `status`,
`renews_at`, `cancel_at_period_end`), one `provider`, one `managed_by` and one
`portal_available`, all built by `AccountService.buildSubscriptionSnapshot` from the
single-valued `users` columns. With two live chains at different tiers, periods or statuses
there is no rule for which one drives the management link or the displayed renewal — so
this design must supply one, or the companion's "unchanged" claim is false.

**The projection is defined, and the DTO does not change.** One live source is elected the
**representative**, and every single-valued field is read from it:

1. **Highest tier** — the source that actually produces the entitled tier. Anything else
   would show a rider a plan weaker than the one they hold.
2. **Latest `current_period_end`** — the access that survives longest.
3. **Earliest `created_at`**, then lowest `id` — total order, so the projection is stable
   across requests and across replicas rather than merely deterministic-looking.

**The election spans Stripe as well as store chains — "source", not "chain".** Entitlement
is `higherTier(grant, max(stripe side, max over live chains))`, so an election held only
over store chains contradicts the very value it is meant to describe: a rider on Stripe
Premium with a live Apple Pro chain resolves to Premium but would be shown Pro, and routed
to Apple to manage a plan Stripe owns. The Stripe subscription therefore enters the
election as a source like any other, ranked by the same three keys. This is not Stripe
moving into the table — it stays on the `users` row, and the election reads it there.

Field rules that do **not** simply follow the representative:

- **`cancel_at_period_end`** is true only when **every** live source is cancelling. Taking
  it from the representative alone would tell a rider their subscription is ending while
  another source silently renews — the exact failure this whole design exists to stop.
- **`status`** is the representative's, except that any live source in `past_due` surfaces
  `past_due`, so a billing-retry source is never hidden behind a healthy one.
- **`portal_available`** stays keyed to the **Stripe** side existing, not to the
  representative. A rider whose representative is an Apple chain but who also has a live
  Stripe subscription still has a real portal, and hiding it would strand them.
- **`provider` / `managed_by`** follow the representative, so the rider is sent to whoever
  actually manages the plan they are being shown — store or Stripe.

**No stickiness.** When the representative terminates, the election re-runs over what
remains live on the next read. The representative is a derived value, never persisted —
persisting it would recreate the single-slot problem one column over.

**Known limitation, accepted deliberately:** a rider with two live sources sees one
management link and can only self-manage that one. That is a _display_ limitation on a
state that is either transient (a plan replacement, retired within a period) or already
flagged by the escalation path below, and the fix for the rider is the refund that
escalation drives — not a wider DTO.
Widening `current_plan` to a list is a backend + OpenAPI + shared + companion + mobile
contract change, and it is not justified by a state we open a reconciliation item to
eliminate. Revisit only if overlaps prove common in practice.

## Account deletion must enumerate every live chain

Step 6.5 of the RevenueCat design was written against the single slot: fetch _the_ current
order identifier, cancel _the_ subscription. Under multi-chain that under-cancels — a rider
with two live Google chains gets one stopped and keeps being billed for the other, after
their local rows are gone.

- **Enumerate, don't fetch one.** Deletion reads **all** live chains for the rider and
  cancels **each** Google one via RevenueCat's v1 endpoint. Apple chains have no
  server-side cancel and stay rider-driven, exactly as 6.5 already says.
- **Erasure waits for every cancellation to succeed** — not for an attempt, and not for the
  first success. `purchase_account_token` is retained until all of them finish, because
  erasing the RevenueCat subscriber destroys the handle the retry needs.
- **⚠️ The cascade is the trap.** `store_subscriptions.user_id` cascades on user delete, so
  the moment the purge runs, the rows enumerating what still needs cancelling are gone. The
  retry state must therefore live in the **purge-safe, non-cascading** table 6.5 already
  requires — carrying one entry per still-live chain, not one per rider. A design that
  keeps only "this rider had a store subscription" cannot drive a per-chain retry.

Coverage this adds: a rider with two live Google chains has **both** cancelled before
erasure; a transient failure on the second leaves the token intact and the retry entry for
that chain alone; an Apple chain alongside a Google one does not block erasure but is
recorded for support.

## Cross-provider exclusivity — the rule that changes

"One active subscription per rider across providers" was enforced by `subscription_provider`
being single-valued. Under this model storage cannot enforce it, and should not try.

- **Purchase time** keeps the preflight already in the RevenueCat spec's step 5.
- **Ingestion time** records the chain and, when a rider ends up with more than one
  entitling chain, marks the overlap **provisional** — see the next section. It does
  **not** open a billing conflict on first observation.
- **Entitlement** is the max of what is live, so a double-billed rider is never left on
  `free` while paying.

### An overlap is only a conflict if it SURVIVES

The (f) resolution and the exclusivity rule collide if the rule fires on first observation,
and the collision hits the most ordinary case there is. A Play plan replacement inserts
chain B **while chain A is still live** — that is the whole point of the fix — so a rider
upgrading monthly → annual momentarily holds two entitling chains. A rule that opens a
`store_billing_reconciliations` row the instant it sees two would queue **every legitimate
upgrade for refund**, which is the same false-conflict failure the equality guard had, moved
one layer out.

**The discriminator is renewal, not count.** A replaced chain never bills again: Google
supersedes it, and its terminal arrives. An independent duplicate keeps billing. So:

- On observing a second entitling chain, record a **provisional overlap** — enough state to
  re-evaluate, no refund path, no operator noise.
- **Retire it silently** when the older chain reaches a terminal state. That is the
  replacement case, and it is expected to be the common one.
- **Escalate to a `store_billing_reconciliations` row** when the older chain **renews**
  while the newer is live — its `current_period_end` advances, which is store-confirmed
  proof both are really billing. That is a genuine duplicate and the refund path is correct.
- **Escalate on expiry of a bound** too, so a chain that neither renews nor terminates
  (a stalled or lost terminal) cannot park a rider in provisional forever.

This is the same store-truth discipline as the rest of the design: we do not guess which
chain supersedes which, we wait for the store to tell us — and unlike the supersession
signal RevenueCat cannot give us, **a renewal is something we already receive**.

The projection is unaffected: a provisional overlap is still two live chains, and the
representative election already covers it.

The audit's rule that an independent second purchase "is a genuine conflict and must still
be rejected" survives as **detection and refund**, not as a refused write. Rejecting the
write never stopped the billing.

## Delivery — expand-only, mirroring migration 1836

1. **Expand.** Create the table and indexes. Backfill from the `users` store columns.
   Behaviour unchanged.
2. **Readers.** `resolveEntitledTier` derives from the live set; store writers dual-write
   the table and the `users` columns.
3. **Contract.** Store writers stop touching the `users` store columns; drop
   `apple_original_transaction_id`, `google_original_transaction_id` and their unique
   indexes.

**Stages 1–2 are one release. Stage 3 is a SEPARATE, LATER release — not a later commit.**
Dropping `apple_original_transaction_id` / `google_original_transaction_id` while the
`User` entity still maps them is the rolling-deploy hazard migration 1831 documents at
length: Coolify keeps the OLD container serving while the new one boots and migrates, so
the instant a mapped column disappears every old-image `SELECT` for a `User` fails with
PostgreSQL `42703` — and rolling back to that image reintroduces the failure permanently.
Stage 3 therefore ships only once the stage-2 release is fully deployed and **no longer a
rollback target**, exactly as `docs/process/typeorm-migrations.md` → "Rename a column"
requires.

**The backfill is vacuous, and that is why stages 1–2 are cheap.** No store subscription has
ever existed in any environment: Google was never implemented, Apple's `iap/validate` was
unmounted before it had a real caller (PR #1136), and the app has never been deployed. Both
columns are NULL in every row everywhere, so there is nothing to copy and no dual-write
phase to sequence.

**Do not extend that gate to stage 3.** Migration 1833 dropped its superseded columns in one
step on the argument that the app had never been deployed, so there was no old container to
protect and no release to roll back to — true when it was written and verifiable then. It is
a statement about deployment state, not about NULL data, and this epic exists to put the app
into production. **Re-check it at the time; do not inherit it.** If the app has shipped by
then, stage 3 obeys the full expand/contract discipline above; the vacuous backfill buys
nothing here, because the hazard is the column NAME in TypeORM's select list, not the rows.

## Open sub-decisions

- **Re-query verification (b).** Whether `product_id` is sufficient to correlate an event
  to a subscriber-API entry, and what two base plans of one Play subscription report as
  their product id. The spike still earns its keep and still needs the
  two-independent-products setup.
- **Fence granularity.** Per-chain `lock_fence` stamped from the per-rider token is the
  proposal; confirm against PR #1123's lease-loss reasoning before building, since that
  machinery was hardened for a single row.
- **Notification generation.** `subscription_notify_generation` is per-rider and gates on
  exact match plus live state. Multi-chain changes what "live state" means; check it does
  not over-drop when one of two chains changes.
- **Stripe.** Stays out. Revisit only with a defect behind it.

## Coverage this must not ship without

- Play plan replacement: chain A live → chain B claimed → both rows exist → entitlement
  unchanged → A's terminal arrives → B still entitles.
- Two independent products: both live → one terminal → the other still entitles.
- **Provisional overlap — the case that must NOT fire.** A plan replacement produces two
  entitling chains and opens **no** `store_billing_reconciliations` row; the overlap retires
  silently when A terminates. The negative assertion is the point of the test.
- **Provisional overlap — the case that MUST fire.** Two independent products where the
  older chain **renews** while the newer is live escalates to a reconciliation row; and a
  chain that neither renews nor terminates escalates on the bound rather than parking
  forever.
- A late event for chain A after a newer event for chain B: A is applied, not dropped —
  the cross-chain ordering regression that per-rider `store_signed_date` causes today.
- `past_due` chain still entitles.
- Cross-rider: the same `(provider, original_transaction_id)` cannot bind to two riders.
- **Projection:** two live sources at different tiers elect the higher as representative;
  the election re-runs when it terminates; `cancel_at_period_end` is false while any live
  source still renews; a `past_due` source surfaces even behind a healthy one; the order is
  stable across repeated reads.
- **Projection across providers:** Stripe Premium alongside a live Apple Pro chain shows
  **Premium**, routes `managed_by` to **Stripe**, and keeps `portal_available` true — the
  store-chains-only election gets this wrong in all three fields.
- **Deploy safety:** stage 3 is a separate release; a test or check that fails if the
  contract migration lands in the same release as the reader change.
- **Deletion:** two live Google chains are **both** cancelled before erasure; a failure on
  the second retains `purchase_account_token` and a retry entry for that chain only; the
  retry survives the cascade that removes `store_subscriptions`.
