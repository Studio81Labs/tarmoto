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

**Live means the PERIOD is unexpired — status is not an allowlist.** A chain entitles while
`current_period_end` is in the future, whatever its status says. Two statuses are worth
spelling out, because they are easy to get wrong in opposite directions:

- **`past_due` entitles.** Existing vocabulary, not a new rule; treating it as terminal
  silently de-entitles riders in billing retry.
- **`canceled` entitles until the period ends.** A mid-period cancellation sets the status
  to `canceled` while the rider keeps paid access to `current_period_end` — the lifecycle
  contract in the RevenueCat design, not a special case here. Writing this predicate as a
  status allowlist (`active` / `trialing` / `past_due`) is the natural mistake, and it
  revokes access the instant a rider cancels, from a period they have already paid for. It
  would also retire any overlap involving that chain early, while it is still
  billing-relevant.

**Immediate revocation is expressed by TRUNCATING the period, not by a status.** A refund or
store revocation must stop entitlement at once even though the period would otherwise run
on, so those events set `current_period_end` to the revocation instant. One predicate then
covers both endings and no reader has to know which statuses are terminal — the property
that keeps this from drifting apart across the resolver, the overlap rules and the
projection.

### Every reader must see the chain contribution, and the seam stays synchronous

`resolveEntitledTier` cannot express that formula as written: it is **synchronous** and
takes `(grant_tier, subscription_tier)`. It has **13 call sites across 6 modules**, and the
enforcement path selects only what it needs —
`FeatureResolverService.resolveForUserWithStates` reads
`select: { id, subscription_tier, grant_tier }`. So chain-only writes would let a store
purchase look activated on `/users/me` and the account snapshot while **every feature guard
and admin limit reader still resolved the rider as free**. Fixing the display surfaces
without this is worse than doing nothing: the rider is told they are Pro and then denied
Pro features.

**The store side is rolled up into a maintained column, `users.store_subscription_tier`** —
the max tier over the rider's live chains, written by the chain writers in the same
transaction, under the same per-rider lock, stamped with the same fence as every other
guarded write. `resolveEntitledTier` takes **four** inputs — `grant_tier`, `subscription_tier`,
`store_subscription_tier` and `store_subscription_tier_expires_at` — stays synchronous, and
every call site adds **both** store fields to its `select`.

**The expiry is part of the contract, not an implementation detail.** A three-value resolver
cannot perform the self-invalidation below: it has no way to know the rollup has lapsed, so
readers that select only the tier keep granting the stale paid tier — which is the exact
failure the expiry exists to prevent, reintroduced by leaving it out of the signature.
Putting it in the parameter list is what makes a caller that forgets it fail to compile
rather than fail silently.

**A cached tier must not outlive the chain that earned it.** A chain can reach
`current_period_end` with no terminal webhook — the lost-terminal case this design already
plans for — and then **no chain writer runs**, so a rollup that is only writer-maintained
keeps granting the paid tier after the live predicate has stopped including that chain.
Every feature guard would go on granting paid access until some unrelated write happened to
touch the row. A derived cache with no expiry is exactly how that becomes permanent.

So the rollup is **self-invalidating**: `users.store_subscription_tier_expires_at` carries
the `current_period_end` of the chain currently producing the rollup (the latest among those
at the max tier), and `resolveEntitledTier` **ignores the rollup once `now` is past it**,
resolving the store side as `free` until it is recomputed. Correctness then does not depend
on a job running.

**The sweep is for accuracy, not safety.** Ignoring a stale rollup can briefly under-grant —
a rider whose Premium chain lapsed while a Pro chain is still live drops to their Stripe or
grant tier until recomputation restores Pro. That is the fail-closed direction, matching how
the rest of this system treats unresolved entitlement, and it is strictly better than
over-granting paid access indefinitely. The existing reconciliation worker recomputes rollups
whose expiry has passed, so the window is bounded by its cadence; a chain terminal or renewal
recomputes immediately as before.

**This is not the single slot coming back, and the distinction is the whole point.** The
retired binding was an _identity_ — one chain id per provider, which is exactly what cannot
represent two chains. This is a _tier rollup_: a derived cache of an aggregate, owned by the
writer that owns the chains, with `store_subscriptions` remaining the source of truth for
identity, lifecycle, periods and everything the overlap machinery reads. It cannot lose
information the way the id column did, because a max of tiers is all any reader wanted from
it.

The alternative — making the resolver async and loading chains at 13 call sites — puts a
query on every feature check and every admin limit read, which is an N+1 on the hottest
path in the system to avoid one derived column.

**Coverage must be on the ENFORCEMENT path, not just the snapshot.** A chain-only purchase
must make `FeatureResolverService` grant the paid feature and the admin limit readers resolve
the paid limit. A test that only asserts `/users/me` passes while every guard denies.

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

**Two questions, not one — and only the second is an election.** `current_plan.tier`
answers _"what is the rider entitled to?"_ and is the **resolved** tier,
`higherTier(grant, max(stripe, chains))` — the same value `resolveEntitledTier` returns.
Everything else (`provider`, `managed_by`, `renews_at`, `cancel_at_period_end`,
`portal_available`, `status`) answers _"who manages the billing behind it?"_ and comes from
the representative.

Collapsing the two breaks grants. A Premium founder/promo/admin grant alongside a live Pro
subscription resolves **Premium** for enforcement, but an election over billing sources
alone has no Premium source to elect and would project **Pro** into `current_plan.tier` —
the companion's "Included right now" would show a weaker plan than the backend actually
grants. That regression is easy to miss because it is invisible today: grants are still
written into `subscription_tier`, so the current fallback happens to carry them
(`account.service.ts` — _"a founder/promo/admin grant keeps the tier it was granted"_).
Once #1132's stage 3 stops writing grants into that column, only an explicitly resolved
tier is correct. Take the resolved value now rather than inheriting a coincidence.

**The DTO does not change.** One live billing source is elected the **representative**, and
the management fields are read from it:

1. **Highest tier** — the source that actually produces the entitled tier. Anything else
   would show a rider a plan weaker than the one they hold.
2. **Latest `current_period_end`**, with **NULL sorting last** — the access that survives
   longest. The null rule is explicit because both sides can produce one: Stripe's
   `currentPlan.renewsAt` and the persisted `subscription_current_period_end` are
   nullable, so an entitling source can reach the election with no comparable period end,
   and "nulls first", "nulls last" and database-default orderings would each elect a
   different representative. Losing is the right side for null: `renews_at` is read from
   the representative, so electing a source with no known end hands the rider a blank
   where a real date was available.
3. **Provider rank** in the fixed order `stripe` < `apple` < `google`, then **source
   identity ascending** — a total order, so the projection is stable across requests and
   across replicas rather than merely deterministic-looking.

   **Deliberately NOT `created_at`.** An earlier draft used it, which cannot be implemented:
   Stripe stays on the `users` row, which has no subscription-created timestamp, and
   `StripeBillingSnapshot.currentPlan` does not carry Stripe's creation time either — so the
   rule would force an undocumented fallback and two replicas could elect different
   representatives, and therefore show different `provider` / `managed_by`. The keys above
   need no new storage and are available on every source. A tie on both tier _and_ period
   end is already degenerate; what matters there is that the answer is stable, not that it
   is meaningful.

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
- **`status`** is the representative's, full stop. An earlier draft of this design also
  surfaced `past_due` from **any** live source, which is wrong and actively misleading:
  with an active Stripe Premium representative and a `past_due` Apple Pro chain it emits
  `tier=Premium, provider=stripe, managed_by=stripe_portal, status=past_due` — telling the
  rider their **Stripe** plan is delinquent, pointing them at the Stripe portal, and giving
  them no way to discover that **Apple** is what needs attention. Mislabelling the
  representative is worse than not mentioning the other source. The property that override
  was protecting survives anyway: a rider whose only source is `past_due` has that source
  as their representative, which is the case that actually occurs.

  A non-representative source in trouble is therefore **not** surfaced by this DTO. It is
  already an overlap — `past_due` is entitling — so it is caught by the provisional-overlap
  path and lands in front of an operator. Showing it to the rider means giving a
  non-representative source its own provider and management target, which is the DTO
  widening deferred below; revisit it with that, not by overloading a field that names
  someone else's subscription.

- **`portal_available`** stays keyed to the **Stripe** side existing, not to the
  representative. A rider whose representative is an Apple chain but who also has a live
  Stripe subscription still has a real portal, and hiding it would strand them.

  **⚠️ This one DOES require a companion change — the DTO alone is not enough.** The
  subscription settings page derives `isStoreManaged` from `managedBy` and gates the portal
  on `!isStoreManaged && portalAvailable`, returning early when the plan is store-managed.
  So with a store representative the portal stays hidden however `portal_available` is set,
  and the stranding this rule exists to prevent happens anyway. The companion must show the
  Stripe portal whenever `portal_available` is true, **independently of `managed_by`** —
  which means reading `managed_by` as _where the displayed plan is managed_, not as _the
  rider's only management target_. In scope for release A; without it this bullet is a claim
  the product does not honour.

- **`provider` / `managed_by`** follow the representative, so the rider is sent to whoever
  actually manages the plan they are being shown — store or Stripe.
- **`payment_method` and `billing_history` are Stripe-only and must be LABELLED as such.**
  Both are built from the Stripe snapshot, and the companion renders them beside the
  displayed plan. With a store representative the rider therefore sees a **Stripe card and
  Stripe invoices presented as though they describe the Apple or Google plan** — a
  misattribution, not merely a gap, and the worst kind because the data is real. They are
  never suppressed, since that would hide a card the rider is genuinely being charged on;
  they are attributed to Stripe explicitly in the companion whenever the representative is
  not Stripe. In scope for release A alongside the portal fix, which is the same class of
  problem in the same view.

**When there is no representative at all.** A founder/promo/admin grant with no live Stripe
or store subscription is an existing, ordinary state, and the election's input is empty —
so "everything else comes from the representative" has to say what happens when there
isn't one. The DTO requires a non-null `status`, so this cannot be left implicit. The
no-representative projection reproduces exactly what a grant-only rider sees today:
`tier` = the resolved (granted) tier, `status` = **`canceled`** — the column's own default,
so nothing changes for these riders — `renews_at` = null, `cancel_at_period_end` = false,
`provider` = null, `managed_by` = null, `portal_available` = false. Nothing is invented and
no field becomes newly nullable; this is the current behaviour written down, which is what
stops it regressing when the `users` billing columns become Stripe-owned.

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

## Two more reader families move with the data

The resolver's 13 call sites are not the whole story: two groups read the `users` billing
columns **directly**, never through `resolveEntitledTier`, so they do not appear in that
count and break silently.

**Admin projections and filters.** `AdminUsersService.toRow` returns
`u.subscription_tier` / `u.subscription_status` raw, its filter queries
`(u.subscription_tier = :sub OR u.subscription_status = :sub)`, and the feature-flag user
list returns the raw tier too. Once those columns are Stripe-owned, a store-only paid rider
shows as **`free` / `canceled`** in the admin UI and is **missing from every subscription
filter** — so an operator investigating a billing or reconciliation issue for exactly the
rider this design exists to support sees a free user. Both the projection and the filter
must become chain-aware in the reader release, using the maintained rollup columns so the
list stays a **single indexed query**: an admin list that fans out per row to compute a tier
is an N+1 on an unbounded table.

**The GDPR export.** `BundleAssembler` walks a fixed typed repository list, so a new child
table is invisible to it. After the contract release drops the legacy store columns, an
account bundle would contain **no store subscription data at all** — no provider, product,
tier, status, period or timestamps — while the exporter still presents itself as a complete
Article 15 bundle. Add a sanitized `store_subscriptions` export in the same release,
following the existing `purchase_account_token` precedent in `sanitizers.ts`: export the
rider-meaningful fields and strip the binding identifiers and internals
(`original_transaction_id`, `lock_fence`, `store_signed_date`).

Coverage: an admin subscription filter finds a store-only paid rider and shows their real
tier; an account export for a store subscriber contains their subscriptions with the
identifiers stripped.

## `/users/me.subscription_tier` must follow the sources too

Chain-only store writes break the mobile activation loop unless this moves with them.
`user-response.mapper.ts` serves `subscription_tier` from the raw `users` column, and the
RevenueCat design's mobile vertical polls `/users/me` until the purchase is reflected. Once
a store claim writes only a chain row, that column never changes for a store purchase — so
the backend grants the features while the client polls until timeout and keeps reporting
`free`. Entitlement would be right and the purchase would look like it failed.

**The fix is not `resolveEntitledTier`, and the mapper explains why.** That column is
_deliberately_ the raw subscription tier rather than the resolved entitlement (#1132): the
mobile flow compares what the rider bought against what they now hold, and folding the
grant in breaks the comparison for anyone whose grant out-ranks their purchase — a
premium-granted rider buying pro would see no change and conclude the purchase failed. The
comment is explicit that features and limits _do_ come from the grant while this field does
not.

So `subscription_tier` becomes **the billed tier across all billing sources** —
`max(stripe side, live chains)` — and still **excludes the grant**.

**It must apply the rollup expiry too.** `toUserResponse` can only read the store side from
the maintained `store_subscription_tier`, so unless it also consumes
`store_subscription_tier_expires_at` it keeps reporting the paid tier after enforcement has
correctly stopped honouring the lapsed rollup. That splits the system in the worst
direction: mobile upsell and cached user state say paid while every feature guard denies —
the same told-Pro-then-denied-Pro failure as omitting the readers, arriving through the
projection instead. Same expiry, same rule, both places. That keeps the field's
existing meaning ("what am I paying for?") while making it multi-source aware. Shared types,
the OpenAPI shape and every mobile and companion consumer are unchanged, because the field's
type and semantics are unchanged; only its derivation moves.

Coverage: a store purchase makes `/users/me.subscription_tier` reflect the new tier within
the activation poll's budget; a premium-granted rider buying pro still sees `pro` there,
which is the case #1132 chose this semantics for; and a chain that **lapses without a
terminal** stops being reported there at the same moment enforcement stops honouring it —
asserting activation and grant exclusion alone leaves the two surfaces free to disagree.

## Account deletion must enumerate every live chain

> **Delivered with step 6.5, NOT with the storage move.** This section needs a RevenueCat
> backend client for `GET /v1/subscribers/{app_user_id}`, and none exists until step 5 —
> which is blocked on the storage move, so scheduling the enumeration inside it would make
> that release uncompletable in its own order. Step 4.9 carries only the **schema
> prerequisites** (the purge-safe per-chain retry entries); the enumeration and the
> cancellation calls land with 6.5, where deletion lives and the client exists.

Step 6.5 of the RevenueCat design was written against the single slot: fetch _the_ current
order identifier, cancel _the_ subscription. Under multi-chain that under-cancels — a rider
with two live Google chains gets one stopped and keeps being billed for the other, after
their local rows are gone.

- **Enumerate from RevenueCat, not from our rows.** Deletion re-queries the RevenueCat
  subscriber and cancels **every upstream-live Google subscription**, then persists
  cancellation work for each. Apple subscriptions have no server-side cancel and stay
  rider-driven, exactly as 6.5 already says.

  **Enumerating local chains is not sufficient, and fails in the one case that matters
  most.** If the rider's first-purchase webhook was lost and the scheduled export has not
  repaired it yet, they have an active Play subscription and **no `store_subscriptions`
  row**. A local enumeration finds nothing, erasure proceeds, the `purchase_account_token`
  is destroyed — and with it the only handle for obtaining the current order identifier —
  while Play keeps renewing a deleted account with nothing left to stop it. Our rows are a
  cache of the store's state; deletion is exactly the moment not to trust the cache, and
  RevenueCat is the authority. The re-query is one call on a path that already runs
  per-rider and is not latency-sensitive.

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
  **future-billing** source, marks the overlap **provisional** — see the next section. It
  does **not** open a billing conflict on first observation.

  **Future-billing, not entitling — the same predicate retirement uses.** A source cancelled
  mid-period keeps _entitling_ to its period end while it will never charge again, so a
  creation rule written on entitlement pairs a new purchase with a source that has already
  stopped billing. Worse, its cancellation handler ran **before** the pair existed, so
  nothing retires the row and it survives to a deadline as durable work for an overlap this
  design defines as already over. Creation and retirement must test the same thing or rows
  appear that nothing can clear.

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

- On observing a second **future-billing** source, record a **provisional overlap** — enough
  state to re-evaluate, no refund path, no operator noise. **Future-billing, not entitling**,
  the same predicate retirement uses: a source cancelled before the second purchase still
  entitles through its paid period but will never charge again, and pairing it creates a row
  whose retiring event has already fired.
- **Retire it silently when EITHER member stops FUTURE BILLING** — not when either stops
  _entitling_, and not only the older one. If the newer source is cancelled or refunded
  first (a rider who changes their mind, or a chargeback), the rider is back to one
  subscription while the provisional row would otherwise survive to its deadline and be
  promoted into the refund path against an overlap that no longer exists. Terminal handling
  for **any** source must retire or re-evaluate every provisional row that names it.

  **Future billing, not entitlement — the live predicate makes these different.** A
  mid-period cancellation keeps a chain **entitling** until `current_period_end`, so a
  stops-entitling condition stays false and the row would sit until a distant deadline while
  nobody is being double-charged any more. An overlap is a statement about two sources that
  will both **keep charging**: the moment one is cancelled, revoked or expired there is no
  future double-charge and the concern is over, whatever access the rider retains for the
  period they already paid for. Entitlement and billing end at different times here, and
  this rule is about the billing one.

- **Escalate** when **either** source **renews** while the other is live — **after
  re-querying both members**, exactly as the deadline path does.

  **A renewal proves only that the TRIGGERING member is billing** — never the other one,
  whichever fired. The member that did not renew is exactly where a lost terminal would hide,
  so **both** members are re-queried on every trigger, symmetrically. Do not carry an
  older-only assumption into the handler or its tests.

  **Either, not just the older one.** Waiting on the older member's renewal is close to
  useless in a realistic shape: a pre-existing **annual** source overlapping an independent
  **monthly** one ignores every monthly renewal and waits up to a year, so a rider is
  double-charged eleven times before anything fires. It is also unnecessary — the trigger
  does not decide anything on its own, it only prompts the re-query, and that re-query
  escalates only when **both** members are still billing. A legitimate replacement fails
  that test, because the superseded member has stopped upstream. So a renewal from either
  side is safe to act on, and the strictly-worse alternative was buying nothing. A renewal proves the
  _older_ source is still billing and says nothing about the newer one: if the newer
  source's terminal webhook was lost it stays locally live until expiry, so an immediate
  promotion would push a valid older subscription into the refund path after the newer one
  was already cancelled or refunded. Escalate only on confirmation that **both** are still
  billing. The renewal is the same kind of signal as the deadline — a prompt to check, not
  a verdict — and both triggers therefore share one rule.

- **Escalate on the deadline** too, so a source that neither renews nor terminates (a
  stalled or lost terminal) cannot park a rider in provisional forever.

**Sources, not chains — Stripe is in scope.** A live Stripe subscription overlapping an
Apple or Google purchase is exactly what the server-side check exists to catch (the
ingestion race, or a modified client), and it is the overlap a rider is _least_ able to
resolve themselves, since no store cancels a Stripe subscription. A predicate written over
chains alone sees one chain, creates nothing, and leaves the rider double-billed
indefinitely. The same three rules apply with Stripe as a source; a Stripe renewal advances
`current_period_end` the same way.

This is the same store-truth discipline as the rest of the design: we do not guess which
source supersedes which, we wait for the store to tell us — and unlike the supersession
signal RevenueCat cannot give us, **a renewal is something we already receive**.

#### The provisional state must be durable, and self-firing

Both escalation triggers are event-driven, and one of the two failures they exist to catch
is **the absence of events**. Provisional state held in memory, or implied by re-deriving
"are there two live sources?" on the next webhook, escalates only if another webhook
arrives — so a duplicate that quietly renews twice, or a process restart, means nothing
ever fires and both subscriptions keep billing. The deadline has to be **written down and
swept**, not remembered.

- **⚠️ The DB CHECK constraints reject the new vocabulary — replace them in the SAME
  migration.** Migration 1822 created `store_billing_reconciliations` with
  `CONSTRAINT sbr_reason_check CHECK (reason IN ('ineligible_trial_rejected',
'exclusivity_conflict','deletion_cancel_failed'))` and
  `CONSTRAINT sbr_status_check CHECK (status IN ('open','resolved'))`. Adding
  `provisional_overlap` and `provisional` to the entity union alone means **every** overlap
  creation fails with PostgreSQL `23514` — and because provisional rows are written from the
  chain-write path, that error can abort the surrounding transaction and take the chain write
  with it. Both constraints must be dropped and recreated with the widened vocabulary in
  release A's migration, and the test must be a **real insert**, not an entity-level
  assertion: a mocked repository never sees a check constraint.

- **Storage reuses `store_billing_reconciliations`** rather than adding a table — it already
  carries `user_id`, `provider`, the per-provider identifiers, `reason`, `attempts`,
  `detail` and a worker. It gains a `provisional` value alongside `open` / `resolved`, and
  an `escalate_after timestamptz`. A `provisional` row is **not** an operator item and must
  be excluded from every existing open-item query and count.
- **Reason vocabulary:** `provisional_overlap` on creation, promoted to the existing
  `exclusivity_conflict` on escalation — so the refund path consumes a reason it already
  understands.
- **Deadline:** the **earliest non-null** `current_period_end` across the pair, plus a grace margin —
  not the older member's. By the first period boundary either that source has renewed (a
  duplicate) or it has ended (a replacement), so the earliest end discriminates just as well
  and bounds the wait far more tightly: taking the older member's end leaves an
  annual-over-monthly pair parked for a year. That is the
  point by which a genuine replacement must have terminated and a genuine duplicate must
  have renewed, so it discriminates rather than merely expiring.

  **A null period end must still produce a deadline.** The projection section explicitly
  permits an entitling source with a null `current_period_end` (Stripe's
  `currentPlan.renewsAt` and the persisted column are both nullable), and
  `null + grace` is null — so the row would carry **no due timestamp**, the worker would
  never sweep it, and if the overlapping purchase emitted no further event the rider stays
  double-billed indefinitely. That is the same never-fires hole the durable-deadline rule
  was written to close, reappearing through a null. Fall back to a **bounded fixed window
  from row creation** only when **neither** member has a period end. If one is null and the
  other is known, use the known one — the rule above is the **minimum non-null**
  `current_period_end`, and reaching past a known boundary to a 35-day default can leave a
  rider double-billed for weeks beyond the point at which the pair could have been judged. `escalate_after` is
  therefore NOT NULL by construction, which is the invariant to assert.

  **Concrete durations, because "a grace margin" is not implementable.** Too short and the
  sweep escalates while RevenueCat still reports both sides of a legitimate replacement; too
  long and a real duplicate keeps charging. Both are `TARMOTO_`-prefixed config with
  defaults, per repo convention:
  - `TARMOTO_BILLING_OVERLAP_GRACE_HOURS`, default **72**. It must exceed store webhook
    delivery and processing lag around a period boundary, which is hours rather than
    minutes; three days clears that without leaving a duplicate billing into a second cycle.
  - `TARMOTO_BILLING_OVERLAP_FALLBACK_DAYS`, default **35** — the null-period fallback.
    Longer than any monthly period, so a monthly duplicate has necessarily either renewed or
    terminated by then, which is what makes the deadline discriminate rather than merely
    expire.

  Test the resulting timestamps, not just that they are non-null: a fallback firing before
  the shortest real billing period cannot tell a duplicate from a replacement.

- **The existing reconciliation worker sweeps it — but must RE-QUERY before promoting, never
  promote on the clock alone.** The deadline firing means only "no event resolved this in
  time", and the most likely reason is the one failure mode this design already knows about:
  a **lost terminal**. For a legitimate replacement whose terminal webhook never arrived, by
  `current_period_end + grace` the older source has locally expired and is no longer live —
  so an unconditional promotion treats a lost terminal exactly like a lost duplicate-renewal
  and queues a **valid replacement for refund**. The sweep therefore re-queries authoritative
  source state at the deadline and **retires** the row if either source has stopped billing,
  escalating only on confirmation that **both are still billing**. This is the same rule the
  rest of the design follows — never act on local state where the store is authoritative —
  and it is why the deadline is a prompt to check rather than a verdict.
- **Dedup is required, is not free, and must key the PAIR.** `openConflict` deliberately
  does not dedup and there is no unique constraint behind it, so a redelivered webhook
  would otherwise stack provisional rows for one overlap. Key it on the **unordered pair of
  source identities** — `(user_id, least(a,b), greatest(a,b))` — and make creation
  idempotent.

  **Not `(user_id, newer source)`.** With three live sources — Stripe A plus chains B and
  C — C belongs to two distinct overlaps (A–C and B–C), which that key collapses into one
  row. Only one survives, and when the member it happens to record terminates, the row
  retires while the _other_ overlap is still billing — so a real duplicate escapes both the
  renewal trigger and the deadline indefinitely. Overlaps are pairwise, so the key has to
  be too, and both members must be persisted for the retire-on-either rule above to know
  what it is retiring. Three live sources means **three** rows, not two.

- **⚠️ The legacy Apple dedup index must be re-scoped in the SAME release, or promotion
  silently loses a duplicate.** `uq_sbr_open_apple_otid_reason` (migration 1823) is a
  partial unique on `(apple_original_transaction_id, reason)` where
  `status = 'open' AND apple_original_transaction_id IS NOT NULL`. It predates pairwise
  overlaps and assumes one open Apple reconciliation per identity. When Apple source A
  overlaps **both** Stripe B and Google C, promoting the two pair rows gives both
  `status = 'open'`, `reason = 'exclusivity_conflict'` and the same Apple OTID — so the
  second promotion fails with `23505` and one real double-billing relationship never
  reaches an operator. The failure lands on the **escalation** path, which is the worst
  place for a silent loss.

  Fix it in release A, not later: narrow the legacy index to exclude the pairwise reasons
  (`provisional_overlap`, `exclusivity_conflict`), which it can no longer key correctly, and
  add a pair-scoped partial unique on
  `(user_id, overlap_pair_low, overlap_pair_high) WHERE status IN ('open','provisional')`.
  That new
  index is also what makes provisional creation idempotent under redelivery, so it does the
  dedup job the old one did, at the granularity the model now has.

  **`overlap_pair_low` / `overlap_pair_high` are new columns with a canonical encoding, not a reuse of the
  existing identifier columns.** The row's `apple_original_transaction_id` /
  `google_original_transaction_id` / `stripe_subscription_id` cannot represent a pair: an
  overlap between **two Google chains** has two values for one column. So the migration adds
  `overlap_pair_low` and `overlap_pair_high` (`varchar(1100)`, sized for the 1024-char
  identifier plus its prefix), each holding **`<provider>:<identity>`** — provider ∈
  `stripe` | `apple` | `google`, identity = the Stripe subscription id or the chain's
  `original_transaction_id`.

  **The Stripe subscription id is not reliably available today, and must be made so.** A
  legacy rider can hold `stripe_customer_id` with a **null** `stripe_subscription_id`: the
  snapshot path still discovers an entitling subscription from the customer, but
  `StripeBillingSnapshot.currentPlan` exposes `{tier, status, entitling, renewsAt,
cancelAtPeriodEnd}` and **not the selected subscription's id**. For such a rider the
  `stripe:<identity>` half of a pair cannot be constructed at all, so the overlap cannot be
  deduplicated, re-queried or retired — it simply cannot be recorded. Release A therefore
  requires the snapshot to carry the **selected subscription id**, and overlap creation to
  validate that both identities are present before writing a pair. An overlap that cannot be
  identified must fail loudly rather than be silently skipped, since skipping it is the
  double-billing this machinery exists to catch.

  **Provider-qualification is load-bearing, not cosmetic.** Store identifiers are only
  unique _within_ a provider, so sorting bare ids could map an Apple/Google pair onto the
  same key as a different pair and silently merge two unrelated overlaps. `low` / `high` are
  then assigned by byte-wise ascending comparison of the **encoded** strings, which is what
  makes the pair unordered and the key stable. Both members are stored decodably so the
  terminal and re-query paths can act on the right pair — the retire-on-either and
  re-query-both rules above are unimplementable otherwise.

  **The pair also needs the ROLE, and it cannot be recovered later.** `low` / `high` are
  byte-sorted, which preserves both identities and destroys which one was already there. The
  **refund path** depends on that distinction: an operator settling a genuine duplicate has
  to know which subscription was already running and which one arrived on top of it, and the
  sorted pair cannot say.

  **Only the refund target — NOT the triggers.** An earlier draft also gated escalation on
  the older member renewing and computed the deadline from the older member's period end;
  both are retired. Escalation fires on **either** member's renewal and the deadline is the
  **earliest non-null** period end across the pair, because an older-only rule ignores every
  renewal of a monthly source sitting under an annual one.

  It cannot be re-derived, either: chain rows have `created_at`, but the Stripe side lives on
  `users` with **no subscription-created timestamp** — the same gap that forced the
  representative tie-break off `created_at`. So the role is a fact only available at creation
  time and must be written down then. Store `overlap_older_member`, the same
  `<provider>:<identity>` encoding, naming which of the pair was already live when the
  overlap was observed. The newer member is then implied, and the refund path has both roles
  without re-deriving anything.

  **`reason` is deliberately NOT in that key.** It is mutable — promotion rewrites
  `provisional_overlap` to `exclusivity_conflict` — so including it would make idempotency
  stop at exactly the moment it starts mattering: a later event observing the same still-live
  pair would insert a _second_ provisional row without conflicting with the now-`open` one,
  leaving duplicate unresolved work that produces either a second operator action or a
  `23505` further along. One unresolved row per pair, whatever state it is in. The legacy index keeps
  serving the non-pairwise reasons (`ineligible_trial_rejected` and friends) unchanged.

The projection is unaffected: a provisional overlap is still two live sources, and the
representative election already covers it.

The audit's rule that an independent second purchase "is a genuine conflict and must still
be rejected" survives as **detection and refund**, not as a refused write. Rejecting the
write never stopped the billing.

## Delivery — expand-only, mirroring migration 1836

1. **Expand.** Create the table and indexes. Backfill from the `users` store columns.
   Behaviour unchanged.

   **The rollup columns belong HERE, not with the readers that use them.** Stage 2 maps and
   selects `users.store_subscription_tier` and `users.store_subscription_tier_expires_at`, so
   deploying those readers against a database that lacks the columns fails every `User`
   select with PostgreSQL `42703` — the same hazard as the contract drop, in the opposite
   direction. Add both in this migration, plus the widened
   `store_billing_reconciliations` CHECK constraints and the overlap-pair columns, so stage 2
   is pure code. **Nullability:** `store_subscription_tier` is nullable with no default and
   `store_subscription_tier_expires_at` likewise — NULL means "no store side", which every
   existing row is, and which `higherTier` already ranks below `free`. Do not default the
   tier to `'free'`: that is indistinguishable from a rider whose chains all lapsed, and it
   is the rollup's absence, not its value, that the expiry check keys on.

2. **Readers, and store writers move over — with NO dual-write.** `resolveEntitledTier`
   derives from the live set, and store writers write **only** the chain table.

   **The dual-write phase that migration 1836 needed does not apply here, and copying it
   would corrupt Stripe.** Once readers treat the `users` billing columns as the _Stripe
   side_ of `max(stripe, chains)`, a store writer that also writes them destroys the only
   persisted Stripe state: `claimForGoogle` sets `subscription_provider`,
   `subscription_tier`, `subscription_status` and the period fields, so ingesting a Google
   Pro chain for a rider on Stripe Premium would overwrite Premium with Pro — entitlement
   drops, and the representative election can no longer elect Stripe because there is
   nothing left to elect.

   1836 needed a dual-write because grant rows already held data. **Here there is none** —
   the same vacuous state that makes the backfill free also means there is nothing to keep
   in sync. So: `users.subscription_*` become **Stripe-owned** at this step, and
   `claimForApple` / `claimForGoogle` are rewritten to write chain rows instead of the
   shared columns. That is a same-step invariant, not a follow-up.

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

- **Re-query verification (b) — and it needs BOTH spike setups, not just one.** Whether
  `product_id` is sufficient to correlate a chain to a subscriber-API entry.

  **The replacement setup is back in scope, for a different question than the one support
  answered.** Support settled whether a base-plan change rebases `original_transaction_id`
  (it does), which is why the replacement experiment was dropped. But the re-query-both rule
  that now underpins every escalation needs each member of a pair correlated
  _individually_, and a base-plan replacement is exactly the pair most likely to defeat
  that: if both chains map to the **same product-keyed subscriber entry**, the worker cannot
  tell which identity stopped billing and may promote a legitimate replacement into the
  refund path. So the spike must record the **replacement response shape** as well as the
  two-independent-products correlation — or another provider-qualified correlation source
  must be established before re-query-both can be relied on.

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
- **Provisional overlap — a replacement creates provisional state, and never an operator
  item.** A plan replacement produces two entitling chains, so it produces **one
  `provisional` row** like any other overlap — the design cannot tell it apart from a
  duplicate at creation time, and asserting "no row" would demand exactly the guess the
  multi-chain decision removed, or suppress the only tracking a genuine duplicate has. The
  assertion is therefore **one `provisional` and zero `open`** until either member ends, and
  then silent retirement when A terminates. The negative half — that no **operator conflict**
  is ever raised for a legitimate upgrade — is what matters and is what this pins.
- **Provisional overlap — the case that MUST fire.** Two independent products where
  **either** chain renews while the other is live escalates to a reconciliation row.
- **Provisional overlap — annual older, monthly newer.** The monthly renewal escalates; it
  must not wait for the annual source's renewal or its period end, which is up to a year of
  duplicate charges.
- **Provisional overlap — cancelled BEFORE the second purchase.** A source cancelled
  mid-period, then a new purchase while the old one still entitles: **no** provisional row is
  created. An entitlement-based creation rule opens one that nothing subsequently retires,
  because the cancellation handler already ran.
- **Provisional overlap — mid-period cancellation retires it.** Cancelling either member
  retires the row immediately, even though that member keeps entitling to its period end.
  A retire condition written on entitlement rather than on future billing fails this.
- **Provisional overlap — no further events at all.** A duplicate that neither renews nor
  terminates, with **no webhook of any kind** after the provisional row is written, still
  escalates once `escalate_after` passes **and the re-query confirms both are billing**.
  Drive it from the worker with a clock, not from a webhook, or the test passes for the
  wrong reason.
- **Provisional overlap — lost terminal must NOT escalate.** A legitimate replacement whose
  terminal webhook never arrives reaches `escalate_after` with the older source locally
  expired; the re-query finds it ended and the row is **retired**, not promoted. Without
  this the most likely deadline case refunds a valid upgrade.
- **Provisional overlap — the NEWER source ends first.** Cancelled or refunded before the
  older one, the row is retired rather than surviving to its deadline.
- **Provisional overlap — Stripe.** A live Stripe subscription overlapping a store chain
  creates provisional state and escalates on the same rules; a chains-only predicate
  creates nothing here.
- **Provisional overlap — redelivery.** The same webhook delivered twice produces **one**
  provisional row, not two (`openConflict` does not dedup on its own).
- **Release A — Stripe is not clobbered.** Ingesting a Google Pro chain for a rider on
  Stripe Premium leaves `users.subscription_*` untouched, entitlement stays Premium, and
  the representative stays Stripe.
- A late event for chain A after a newer event for chain B: A is applied, not dropped —
  the cross-chain ordering regression that per-rider `store_signed_date` causes today.
- **`canceled` chain with an unexpired period still entitles**, asserted through
  `FeatureResolverService` — the cancellation-before-expiry case a status allowlist breaks.
- **A refunded/revoked chain stops entitling immediately**, because its period is truncated
  rather than because its status changed.
- `past_due` chain still entitles.
- Cross-rider: the same `(provider, original_transaction_id)` cannot bind to two riders.
- **Projection:** two live sources at different tiers elect the higher as representative;
  the election re-runs when it terminates; `cancel_at_period_end` is false while any live
  source still renews; the order is stable across repeated reads.
- **Projection — grant outranks every billing source.** A Premium grant alongside a live
  Pro subscription shows `current_plan.tier = premium` while `provider` / `managed_by`
  still describe the Pro subscription. An election that sets the tier regresses this, and
  the regression is invisible until #1132 stage 3 lands — so pin it now.
- **Projection — `past_due` on a NON-representative source.** An active Stripe Premium
  representative alongside a `past_due` Apple Pro chain reports `status = active`, not
  `past_due`. The negative assertion is the point: emitting `past_due` here would label the
  Stripe plan delinquent and route the rider to the wrong provider.
- **Projection — `past_due` as the ONLY source** still reports `past_due`, since it is then
  the representative.
- **Projection across providers:** Stripe Premium alongside a live Apple Pro chain shows
  **Premium**, routes `managed_by` to **Stripe**, and keeps `portal_available` true — the
  store-chains-only election gets this wrong in all three fields.
- **Deploy safety:** stage 3 is a separate release; a test or check that fails if the
  contract migration lands in the same release as the reader change.
- **Deletion:** two live Google chains are **both** cancelled before erasure; a failure on
  the second retains `purchase_account_token` and a retry entry for that chain only; the
  retry survives the cascade that removes `store_subscriptions`.
- **Deletion — a purchase never ingested locally.** A rider with an upstream-live Play
  subscription and **no** `store_subscriptions` row (lost first-purchase webhook) still has
  it cancelled before erasure. A local-only enumeration passes this test vacuously, so
  assert the cancel call, not the absence of an error.
- **Projection — grant only, no billing source.** Reports the granted tier with
  `status=canceled`, null `renews_at` / `provider` / `managed_by`, false
  `cancel_at_period_end` / `portal_available` — identical to today, pinned so the
  Stripe-owned-columns change cannot regress it.
- **Overlap — three live sources produce THREE rows.** Stripe A plus chains B and C are
  three unordered pairs — A–B, A–C **and B–C** — so assert all three, then terminate A and
  check that B–C survives and still escalates on renewal and on its deadline. Asserting only
  the two pairs that involve A hides the bug: both retire together and the genuine B–C
  duplicate is left with no provisional row at all.
- **Overlap — two surviving pairs sharing one Apple source.** Apple A overlapping both
  Stripe B and Google C promotes **both** pairs to `open`; neither promotion may fail on the
  legacy Apple dedup index.
- **Overlap — an event arriving AFTER promotion.** The same still-live pair observed again
  once its row is `open` creates **no** second row. Asserting this needs the reason to have
  already changed, so a key that includes `reason` passes every earlier idempotency test and
  fails only here.
- **Renewal escalation — lost terminal on the NEWER source.** The older source renews while
  the newer is locally live but already cancelled or refunded upstream; the re-query finds
  it ended and the row is **retired**, not promoted. Without the re-query a renewal alone
  refunds a valid subscription.
- **Projection — tie on tier AND period end.** Two sources tying on both resolve to the same
  representative on every read and across replicas, using only fields that exist (no
  `created_at` on the Stripe side).
- **Projection — a live source with a NULL period end** loses the period-end key rather than
  winning it or ordering arbitrarily.
- **Portal reachability with a store representative.** A rider with a live Stripe
  subscription and an elected Apple/Google representative can still reach the Stripe portal
  in the companion. Asserting the DTO field alone passes while the UI hides it.
- **Rollup — a chain lapses with NO terminal and no further events.** Past
  `store_subscription_tier_expires_at`, the enforcement path stops granting the paid tier
  **without any job having run**. Assert through `FeatureResolverService`, not the column.
- **Rollup — lapsed top chain over a still-live lower chain.** Briefly resolves to the lower
  entitlement and is restored to it by recomputation; it must never stay at the lapsed
  higher tier.
- **Overlap — NULL older period end but a KNOWN newer one** uses the known boundary, not the
  35-day fallback; the fallback applies only when neither member has a period end.
- **Overlap — older member with a NULL period end** still gets a non-null `escalate_after`
  from the bounded fallback window, and still escalates with no further events.
- **Overlap — deadline VALUES, not just non-nullness.** `escalate_after` is
  `current_period_end + TARMOTO_BILLING_OVERLAP_GRACE_HOURS`, and the null-period fallback is
  `created_at + TARMOTO_BILLING_OVERLAP_FALLBACK_DAYS` — asserted as timestamps, since a
  fallback shorter than the shortest real billing period silently stops discriminating.
- **ENFORCEMENT, not just display.** A chain-only purchase makes `FeatureResolverService`
  grant the paid feature and the admin limit readers resolve the paid limit. Asserting
  `/users/me` alone passes while every guard still denies — this is the test that catches
  the readers being missed.
- **Overlap — two GOOGLE chains.** The pair row stores both members
  (`google:<A>` / `google:<B>`); the single `google_original_transaction_id` column cannot
  represent it, so a row that reuses the legacy columns fails this.
- **Overlap — a legacy Stripe rider with a null `stripe_subscription_id`.** A customer-only
  Stripe rider whose entitling subscription is discovered from the customer can still form a
  pair with a store chain: the selected id reaches the encoding, and the pair is
  deduplicated, re-queried and retired like any other.
- **Overlap — a REAL insert of a `provisional` row succeeds.** Against PostgreSQL, not a
  mocked repository: the 1822 CHECK constraints reject the new `reason` and `status` values
  and only a real insert sees `23514`.
- **Projection — Stripe card and invoices under a store representative** are attributed to
  Stripe in the companion, not rendered as though they belong to the Apple/Google plan.
- **Overlap — pair keys are provider-qualified.** An Apple/Google pair whose bare ids would
  sort onto the same key as a different pair stays distinct.
- **Overlap — the ROLE survives byte-sorting.** Construct a pair where byte-sorting puts the
  **newer** member in `low`, and assert `overlap_older_member` still names the pre-existing
  source. The role drives the **refund target** and nothing else now — **either** member's
  renewal escalates — so this asserts the stored role, not a difference in trigger
  behaviour. Choose the sort order adversarially: a pair whose byte order happens to match
  its age order passes even with the role discarded.
