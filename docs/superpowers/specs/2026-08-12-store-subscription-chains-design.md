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

## Cross-provider exclusivity — the rule that changes

"One active subscription per rider across providers" was enforced by `subscription_provider`
being single-valued. Under this model storage cannot enforce it, and should not try.

- **Purchase time** keeps the preflight already in the RevenueCat spec's step 5.
- **Ingestion time** records the chain and, when a rider ends up with more than one
  entitling chain, opens a `store_billing_reconciliations` row — the same row the
  `'conflict'` path opened, now carrying an accurate picture instead of a rejected write.
- **Entitlement** is the max of what is live, so a double-billed rider is never left on
  `free` while paying.

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

**The backfill is vacuous, and that is the whole reason this is cheap.** No store
subscription has ever existed in any environment: Google was never implemented, Apple's
`iap/validate` was unmounted before it had a real caller (PR #1136), and the app has never
been deployed. Both columns are NULL in every row everywhere — the same gate migration 1833
used to run its contract half immediately. This refactor looks expensive and is mostly not.

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
- Two independent products: both live → one terminal → the other still entitles, and a
  reconciliation row exists for the overlap.
- A late event for chain A after a newer event for chain B: A is applied, not dropped —
  the cross-chain ordering regression that per-rider `store_signed_date` causes today.
- `past_due` chain still entitles.
- Cross-rider: the same `(provider, original_transaction_id)` cannot bind to two riders.
