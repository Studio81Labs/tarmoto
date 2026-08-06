# Stripe Path Hardening + `iap/validate` Unmount — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two live Stripe entitlement bugs from audit finding 5, then unmount the authenticated `iap/validate` endpoint that has zero callers.

**Architecture:** All three changes are backend-only and land in `apps/backend/src/modules/account`. Tasks 1 and 2 both modify `AccountService.applyStripeSubscriptionEvent`, so they are strictly sequential. Task 3 is independent of both and touches only the controller and module wiring.

**Tech Stack:** NestJS 11, TypeORM, TypeScript strict mode, Jest 30, Stripe Node SDK.

## Global Constraints

- Backend stores and serves metric units only. Not relevant to this plan, but do not introduce non-metric values.
- TypeScript strict mode everywhere. No `any`, no non-null assertions added.
- No broad `try/catch`, no silent fallbacks, no behavior that hides failures.
- Conventional commits, scope required. Valid scopes here: `backend`, `openapi`.
- Jest 30 uses `--testPathPatterns` (plural), **not** `--testPathPattern`.
- Run backend **lint** locally before finishing — CI runs it as a separate step: `pnpm --filter @tarmoto/backend lint`.
- Task 3 changes an HTTP contract and therefore MUST run **both** `pnpm openapi:gen` **and** `pnpm postman:gen` and commit the tracked artifacts. They are separate scripts; `openapi:gen` does not touch Postman. `packages/openapi/openapi.yaml` is gitignored — never force-add it.
- Source spec: `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md` §6, §7.

## File Structure

| File                                                           | Responsibility                                                                       | Task |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---- |
| `apps/backend/src/modules/account/account.service.ts`          | Stripe webhook ingestion; gains the entitling-status allowlist and the live re-query | 1, 2 |
| `apps/backend/src/modules/account/account.service.spec.ts`     | Unit coverage for both fixes                                                         | 1, 2 |
| `apps/backend/src/modules/account/stripe-billing.client.ts`    | Gains `getSubscription` (raw subscription fetch)                                     | 2    |
| `apps/backend/src/modules/account/account.controller.ts`       | Drops the `iap/validate` route, its filter and its injection                         | 3    |
| `apps/backend/src/modules/account/account.controller.spec.ts`  | Drops the route's tests and provider                                                 | 3    |
| `apps/backend/src/modules/account/account.module.ts`           | Drops the `IapValidateService` provider                                              | 3    |
| `packages/openapi-client/src/generated/schema.d.ts`            | Regenerated — route removed                                                          | 3    |
| `packages/openapi/postman/tarmoto-api.postman_collection.json` | Regenerated — route removed                                                          | 3    |

**Not touched:** `iap-validate.service.ts`, `apple-billing.client.ts`, `apple-iap.config.ts`, `dto/iap-validate.dto.ts` and their specs all remain on disk. Spec §6 deletes them only after the RevenueCat vertical passes sandbox.

---

### Task 1: Stripe entitling-status allowlist (finding 5a)

**Why:** `statusFromSubscription` collapses Stripe's non-entitling raw statuses into entitling-looking stored ones — `unpaid` → `past_due` (retains the paid tier), `incomplete` and `incomplete_expired` → `canceled` (but the paid tier is still persisted by `claimForStripe`, which has no eligibility guard). Feature resolution reads only `subscription_tier`, so a rider holds Pro/Premium **without an entitling payment**.

**Files:**

- Modify: `apps/backend/src/modules/account/account.service.ts:609-616` (tier derivation) and `:1600-1605` (add the allowlist near `statusFromSubscription`)
- Test: `apps/backend/src/modules/account/account.service.spec.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `private isEntitlingStripeStatus(rawStatus: string): boolean` on `AccountService`. Task 2 does **not** call it directly but relies on the gate existing at the `newTier` derivation point.

**Design note — why gating `newTier` alone is sufficient.** `newTier` feeds three downstream consumers and nothing else: `planSource` (line 616, already derives `null` when the tier is `free`), `willActivate` (line 663-665, requires `newTier !== 'free'`, so a non-entitling event skips the activation UPDATE and its confirmation email), and `claimForStripe` (line 886, which then writes `tier: 'free'`, `plan_source: null`). Forcing `newTier` to `'free'` therefore propagates correctly without touching any other branch. `isTrialActivation` keys off raw `'trialing'`, which is entitling, so it is unaffected.

- [ ] **Step 1: Write the failing tests**

Add to `apps/backend/src/modules/account/account.service.spec.ts` inside the existing `describe('handleWebhook', ...)` block:

```ts
// Finding 5a: a paid tier must be persisted ONLY for an entitling raw
// Stripe status. These statuses all mean "no successful payment", so the
// rider must land on `free` even though the subscription carries a paid
// price.
it.each([
  ["incomplete", "initial payment never succeeded"],
  ["incomplete_expired", "initial payment window expired"],
  ["unpaid", "retries exhausted"],
])(
  "persists `free` for the non-entitling Stripe status %s (%s)",
  async (rawStatus) => {
    userRepo.findOne!.mockResolvedValueOnce(
      buildUser({
        stripe_customer_id: "cus_123",
        stripe_subscription_id: "sub_1",
        subscription_tier: "free",
        subscription_status: "canceled",
      }),
    );
    stripe.constructWebhookEvent.mockReturnValueOnce({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_123",
          status: rawStatus,
          cancel_at_period_end: false,
          current_period_end: 1779537600,
          items: { data: [{ price: { lookup_key: "pro" } }] },
        },
      },
    });

    await service.handleWebhook(Buffer.from("payload"), "stripe-signature");

    expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
      expect.any(String),
      "sub_1",
      expect.objectContaining({ tier: "free", planSource: null }),
      expect.anything(),
    );
    // Non-entitling means no activation transition, so no confirmation mail.
    expect(notifyQueue.add).not.toHaveBeenCalled();
  },
);

// Guard against the fix over-reaching: `past_due` IS Stripe's grace window
// (it is still retrying), so it must KEEP the paid tier.
it.each([["active"], ["trialing"], ["past_due"]])(
  "keeps the paid tier for the entitling Stripe status %s",
  async (rawStatus) => {
    userRepo.findOne!.mockResolvedValueOnce(
      buildUser({
        stripe_customer_id: "cus_123",
        stripe_subscription_id: "sub_1",
        subscription_tier: "free",
        subscription_status: "canceled",
      }),
    );
    stripe.constructWebhookEvent.mockReturnValueOnce({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_123",
          status: rawStatus,
          cancel_at_period_end: false,
          current_period_end: 1779537600,
          items: { data: [{ price: { lookup_key: "pro" } }] },
        },
      },
    });

    await service.handleWebhook(Buffer.from("payload"), "stripe-signature");

    expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
      expect.any(String),
      "sub_1",
      expect.objectContaining({ tier: "pro", planSource: "subscription" }),
      expect.anything(),
    );
  },
);
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @tarmoto/backend test -- --testPathPatterns=account.service.spec -t "non-entitling Stripe status"
```

Expected: FAIL. The three non-entitling cases assert `tier: 'free'` but receive `tier: 'pro'` — that is the bug.

- [ ] **Step 3: Add the allowlist**

In `apps/backend/src/modules/account/account.service.ts`, add above the `AccountService` class declaration (near the other module-level constants):

```ts
/**
 * RAW Stripe subscription statuses that entitle the rider to their paid tier.
 *
 * `past_due` belongs here: it IS Stripe's grace window — Stripe is still
 * retrying the payment, and access is deliberately retained during it. Once
 * retries are exhausted Stripe moves the subscription to `unpaid` or
 * `canceled`, neither of which is entitling.
 *
 * Deliberately an ALLOWLIST, not a blocklist. Naming only `incomplete`/`unpaid`
 * would still grant on `incomplete_expired` (and could drop access on
 * `incomplete`, then re-grant when it expires), and would silently grant on any
 * status Stripe adds later. Matched against the RAW Stripe status, never the
 * stored `BillingStatus` — `statusFromSubscription` collapses `unpaid` into
 * `past_due`, so the stored value cannot distinguish them.
 */
const ENTITLING_STRIPE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
]);
```

- [ ] **Step 4: Add the predicate**

In the same file, directly above `private statusFromSubscription(...)` (currently line 1600):

```ts
  private isEntitlingStripeStatus(rawStatus: string): boolean {
    return ENTITLING_STRIPE_STATUSES.has(rawStatus);
  }
```

- [ ] **Step 5: Gate the tier derivation**

In `applyStripeSubscriptionEvent`, replace lines 609-611:

```ts
const price = subscription.items.data[0]?.price;
const newTier = this.tierFromPrice(price);
const newStatus = this.statusFromSubscription(subscription.status);
```

with:

```ts
const price = subscription.items.data[0]?.price;
// Finding 5a: the paid tier is persisted ONLY for an entitling raw status.
// Without this, a subscription carrying a paid price but no successful
// payment (`incomplete`, `incomplete_expired`, `unpaid`) still reached
// `claimForStripe` — which has no eligibility guard of its own — and the
// rider held paid features for free. Forcing `free` here also clears
// `planSource` (below) and suppresses the activation transition, since
// `willActivate` requires `newTier !== 'free'`.
const newTier = this.isEntitlingStripeStatus(subscription.status)
  ? this.tierFromPrice(price)
  : "free";
const newStatus = this.statusFromSubscription(subscription.status);
```

- [ ] **Step 6: Run the new tests to verify they pass**

```bash
pnpm --filter @tarmoto/backend test -- --testPathPatterns=account.service.spec -t "Stripe status"
```

Expected: PASS, all six cases.

- [ ] **Step 7: Run the full account suite for regressions**

```bash
pnpm --filter @tarmoto/backend test -- --testPathPatterns=account
```

Expected: PASS. If an existing test now fails because it asserted a paid tier for a non-entitling status, that test was encoding the bug — update it to expect `free` and note why in a comment. Do not weaken the allowlist to keep it green.

- [ ] **Step 8: Lint**

```bash
pnpm --filter @tarmoto/backend lint
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/modules/account/account.service.ts \
        apps/backend/src/modules/account/account.service.spec.ts
git commit -m "fix(backend): persist the paid tier only for entitling Stripe statuses

Finding 5a of the payments audit. \`statusFromSubscription\` collapses
Stripe's non-entitling raw statuses into entitling-looking stored ones
(\`unpaid\` -> \`past_due\`, \`incomplete\`/\`incomplete_expired\` -> \`canceled\`),
and \`claimForStripe\` has no eligibility guard, so a rider could hold
Pro/Premium without an entitling payment.

Gates the tier derivation on an ALLOWLIST of entitling raw statuses
(active/trialing/past_due). An allowlist rather than a blocklist: naming
only incomplete/unpaid would still grant on incomplete_expired."
```

---

### Task 2: Stripe live re-query + terminal routing (finding 5b)

**Why:** `handleWebhook` applies `event.data.object` directly with no version guard and no API re-query, and the lock fence only orders lock _acquisition_, not Stripe _event_ delivery. Stripe does not guarantee order, so a delayed `customer.subscription.updated: active` arriving after a `deleted` resurrects a canceled subscription. `event.created` is second-granularity and cannot order same-second events, so the re-query is the reliable fix. Re-querying alone is insufficient: `isDeleted` is derived solely from the event type (line 394-402), so a delayed `updated` whose fresh state is terminal still enters `claimForStripe` and leaves Stripe owning the slot — blocking a later Apple/Google claim even after the tier drops to `free`.

**Files:**

- Modify: `apps/backend/src/modules/account/stripe-billing.client.ts` — add `getSubscription` to the `StripeBillingClient` interface (near line 124) and implement it in `StripeNodeBillingClient` (after `getSubscriptionStatus`, line 284)
- Modify: `apps/backend/src/modules/account/account.service.ts:508-560` — re-query at the top of `applyStripeSubscriptionEvent`
- Test: `apps/backend/src/modules/account/account.service.spec.ts`

**Interfaces:**

- Consumes: `isEntitlingStripeStatus` from Task 1 must already exist (the tier gate is downstream of this re-query and must operate on the _fresh_ status).
- Produces: `getSubscription(subscriptionId: string): Promise<StripeSubscription | 'missing'>` on the `StripeBillingClient` interface.

**Design note — why a new method rather than reusing `getSubscriptionStatus`.** `getSubscriptionStatus` returns `BillingStatus | 'missing'`, already normalised through `normalizeSubscriptionStatus`. That collapses `unpaid` into `past_due` and discards the price, so it can carry neither the raw status Task 1's allowlist needs nor the tier. A raw-object fetch is required.

**Design note — which statuses route to the terminal clear.** Only `canceled` and `incomplete_expired`, plus a `'missing'` re-query (Stripe purged it). These are genuinely over. `unpaid`, `incomplete` and `paused` are non-entitling but **not** terminal — the rider can still recover — so they drop the tier to `free` via Task 1's allowlist while Stripe correctly retains the slot. Clearing the slot for them would be wrong.

- [ ] **Step 1: Write the failing test for the client method**

Add to `apps/backend/src/modules/account/stripe-billing.client.spec.ts`, as a new
`describe` block inside the top-level `describe('StripeNodeBillingClient', ...)`.
This uses the file's existing `unconfiguredConfig()`, `withFakeStripe()` and
`resourceMissingError()` helpers (defined at the top of that file) — do not
introduce a different fixture style:

```ts
describe("getSubscription", () => {
  it("returns the RAW subscription object so callers see the un-normalised status", async () => {
    const client = new StripeNodeBillingClient(unconfiguredConfig());
    const retrieve = jest
      .fn()
      .mockResolvedValue({ id: "sub_1", status: "unpaid" });
    withFakeStripe(client, { subscriptions: { retrieve } });

    const result = await client.getSubscription("sub_1");

    // Raw, NOT normalised: `getSubscriptionStatus` would have collapsed this
    // to `past_due`, which the entitling-status allowlist must never see.
    expect(result).toEqual({ id: "sub_1", status: "unpaid" });
    expect(retrieve).toHaveBeenCalledWith("sub_1");
  });

  it("returns 'missing' when Stripe has purged the subscription", async () => {
    const client = new StripeNodeBillingClient(unconfiguredConfig());
    const retrieve = jest.fn().mockRejectedValue(resourceMissingError());
    withFakeStripe(client, { subscriptions: { retrieve } });

    await expect(client.getSubscription("sub_gone")).resolves.toBe("missing");
  });

  it("rethrows errors other than resource_missing", async () => {
    const client = new StripeNodeBillingClient(unconfiguredConfig());
    const retrieve = jest.fn().mockRejectedValue(new Error("rate_limited"));
    withFakeStripe(client, { subscriptions: { retrieve } });

    await expect(client.getSubscription("sub_1")).rejects.toThrow(
      "rate_limited",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @tarmoto/backend test -- --testPathPatterns=stripe-billing.client.spec -t "getSubscription"
```

Expected: FAIL with `client.getSubscription is not a function`.

- [ ] **Step 3: Add the method to the interface**

In `apps/backend/src/modules/account/stripe-billing.client.ts`, in the `StripeBillingClient` interface, directly after the `getSubscriptionStatus` declaration (line 124-126):

```ts
  /**
   * Fetches the RAW live subscription. Unlike `getSubscriptionStatus` this does
   * NOT normalise the status, because the caller needs the un-collapsed Stripe
   * status (`unpaid` and `past_due` are distinct for entitlement) and the price
   * (for the tier). Returns `'missing'` when Stripe has purged the record.
   */
  getSubscription(
    subscriptionId: string,
  ): Promise<StripeSubscription | 'missing'>;
```

- [ ] **Step 4: Implement it**

In `StripeNodeBillingClient`, directly after `getSubscriptionStatus` (after line 284):

```ts
  async getSubscription(
    subscriptionId: string,
  ): Promise<StripeSubscription | 'missing'> {
    const stripe = this.requireStripe();
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      return subscription as unknown as StripeSubscription;
    } catch (err) {
      if (isResourceMissing(err)) {
        return 'missing';
      }
      throw err;
    }
  }
```

- [ ] **Step 5: Run the client tests to verify they pass**

```bash
pnpm --filter @tarmoto/backend test -- --testPathPatterns=stripe-billing.client.spec -t "getSubscription"
```

Expected: PASS.

- [ ] **Step 6: Add `getSubscription` to the service spec's default Stripe mock**

Without this, every existing webhook test gets `undefined` from the re-query. In `apps/backend/src/modules/account/account.service.spec.ts`, in the `stripe = { ... }` block (line 98-113), directly after the `getSubscriptionStatus` entry:

```ts
      // Finding 5b: `applyStripeSubscriptionEvent` re-queries the live
      // subscription and applies THAT, not the event snapshot. The default
      // echoes the most recently constructed event's object, i.e. the re-query
      // AGREES with the event — the common case, so existing tests are
      // unaffected. Out-of-order tests override with `mockResolvedValueOnce`.
      getSubscription: jest.fn(async (id: string) => {
        const lastEvent = stripe.constructWebhookEvent.mock.results.at(-1)
          ?.value as { data?: { object?: { id?: string } } } | undefined;
        const object = lastEvent?.data?.object;
        return object && object.id === id ? object : 'missing';
      }),
```

- [ ] **Step 7: Write the failing regression tests**

Add to `apps/backend/src/modules/account/account.service.spec.ts` inside `describe('handleWebhook', ...)`:

```ts
// Finding 5b: Stripe does not guarantee delivery order. A delayed
// `updated: active` arriving AFTER the subscription was canceled must not
// resurrect it — the live re-query, not the event snapshot, is authoritative.
it("routes a delayed `updated` whose live state is terminal through the terminal clear", async () => {
  userRepo.findOne!.mockResolvedValueOnce(
    buildUser({
      stripe_customer_id: "cus_123",
      stripe_subscription_id: "sub_1",
      subscription_tier: "pro",
      subscription_status: "active",
    }),
  );
  stripe.constructWebhookEvent.mockReturnValueOnce({
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_1",
        customer: "cus_123",
        // The STALE snapshot says active...
        status: "active",
        cancel_at_period_end: false,
        current_period_end: 1779537600,
        items: { data: [{ price: { lookup_key: "pro" } }] },
      },
    },
  });
  // ...but the live subscription is already canceled.
  stripe.getSubscription.mockResolvedValueOnce({
    id: "sub_1",
    customer: "cus_123",
    status: "canceled",
    cancel_at_period_end: false,
    current_period_end: 1779537600,
    items: { data: [{ price: { lookup_key: "pro" } }] },
  });

  await service.handleWebhook(Buffer.from("payload"), "stripe-signature");

  // Must go through the identity-guarded terminal clear, which releases
  // `subscription_provider`. `claimForStripe` would have kept Stripe owning
  // the slot and blocked a later Apple/Google claim.
  expect(providerClaim.clearStripeTerminal).toHaveBeenCalledWith(
    expect.any(String),
    "sub_1",
    expect.any(Number),
    expect.anything(),
  );
  expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
});

it("routes a delayed `updated` for a subscription Stripe has purged through the terminal clear", async () => {
  userRepo.findOne!.mockResolvedValueOnce(
    buildUser({
      stripe_customer_id: "cus_123",
      stripe_subscription_id: "sub_1",
      subscription_tier: "pro",
      subscription_status: "active",
    }),
  );
  stripe.constructWebhookEvent.mockReturnValueOnce({
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_1",
        customer: "cus_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: 1779537600,
        items: { data: [{ price: { lookup_key: "pro" } }] },
      },
    },
  });
  stripe.getSubscription.mockResolvedValueOnce("missing");

  await service.handleWebhook(Buffer.from("payload"), "stripe-signature");

  expect(providerClaim.clearStripeTerminal).toHaveBeenCalled();
  expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
});

it("applies the LIVE state, not the stale event snapshot, on a same-subscription write", async () => {
  userRepo.findOne!.mockResolvedValueOnce(
    buildUser({
      stripe_customer_id: "cus_123",
      stripe_subscription_id: "sub_1",
      subscription_tier: "free",
      subscription_status: "canceled",
    }),
  );
  stripe.constructWebhookEvent.mockReturnValueOnce({
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_1",
        customer: "cus_123",
        status: "past_due",
        cancel_at_period_end: false,
        current_period_end: 1779537600,
        items: { data: [{ price: { lookup_key: "pro" } }] },
      },
    },
  });
  // The rider has since recovered — the live state is `active` on premium.
  stripe.getSubscription.mockResolvedValueOnce({
    id: "sub_1",
    customer: "cus_123",
    status: "active",
    cancel_at_period_end: false,
    current_period_end: 1779537600,
    items: { data: [{ price: { lookup_key: "premium" } }] },
  });

  await service.handleWebhook(Buffer.from("payload"), "stripe-signature");

  // Tier comes from the RE-QUERIED price, not the event's.
  expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
    expect.any(String),
    "sub_1",
    expect.objectContaining({ tier: "premium", status: "active" }),
    expect.anything(),
  );
});

// `unpaid` is non-entitling (Task 1) but NOT terminal — the rider can still
// recover, so Stripe must keep the slot rather than releasing it.
it("drops the tier but RETAINS the Stripe slot for a non-terminal, non-entitling live state", async () => {
  userRepo.findOne!.mockResolvedValueOnce(
    buildUser({
      stripe_customer_id: "cus_123",
      stripe_subscription_id: "sub_1",
      subscription_tier: "pro",
      subscription_status: "active",
    }),
  );
  stripe.constructWebhookEvent.mockReturnValueOnce({
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_1",
        customer: "cus_123",
        status: "unpaid",
        cancel_at_period_end: false,
        current_period_end: 1779537600,
        items: { data: [{ price: { lookup_key: "pro" } }] },
      },
    },
  });

  await service.handleWebhook(Buffer.from("payload"), "stripe-signature");

  expect(providerClaim.clearStripeTerminal).not.toHaveBeenCalled();
  expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
    expect.any(String),
    "sub_1",
    expect.objectContaining({ tier: "free" }),
    expect.anything(),
  );
});
```

- [ ] **Step 8: Run them to verify they fail**

```bash
pnpm --filter @tarmoto/backend test -- --testPathPatterns=account.service.spec -t "delayed"
```

Expected: FAIL. Both delayed-`updated` tests call `claimForStripe` instead of `clearStripeTerminal`, because `isDeleted` comes from the event type alone.

- [ ] **Step 9: Add the terminal-status constant**

In `apps/backend/src/modules/account/account.service.ts`, directly below `ENTITLING_STRIPE_STATUSES` from Task 1:

```ts
/**
 * RAW Stripe statuses that mean the subscription is OVER — the slot must be
 * released so a later Apple/Google claim can take it.
 *
 * Deliberately narrower than "non-entitling": `unpaid`, `incomplete` and
 * `paused` are non-entitling (the tier drops to `free` via
 * `ENTITLING_STRIPE_STATUSES`) but the rider can still recover, so Stripe
 * correctly keeps owning the slot. Releasing it for those would let another
 * provider claim a slot Stripe may yet reactivate.
 */
const TERMINAL_STRIPE_STATUSES: ReadonlySet<string> = new Set([
  "canceled",
  "incomplete_expired",
]);
```

- [ ] **Step 10: Re-query and re-derive `isDeleted` inside the lock**

In `applyStripeSubscriptionEvent`, rename the incoming parameters and add the re-query. Change the signature (line 508-511) from:

```ts
  private async applyStripeSubscriptionEvent(
    resolvedUser: User,
    subscription: StripeSubscription,
    isDeleted: boolean,
```

to:

```ts
  private async applyStripeSubscriptionEvent(
    resolvedUser: User,
    eventSubscription: StripeSubscription,
    isDeletedEvent: boolean,
```

Then, as the **first statements** of the method body (before anything reads the subscription), insert:

```ts
// Finding 5b: Stripe does not guarantee delivery order and `event.created`
// is only second-granularity, so it cannot order same-second events. Re-fetch
// the LIVE subscription and apply that — never the event snapshot. Runs
// inside the per-rider lock so the read and the write cannot interleave with
// another flow for the same rider.
const fresh = await this.stripe.getSubscription(eventSubscription.id);

// `isDeleted` used to come solely from the event TYPE, so a delayed
// `customer.subscription.updated` whose live state is terminal still entered
// `claimForStripe` — which writes `subscription_provider = 'stripe'` and the
// subscription id EVEN WHEN the tier drops to `free`, leaving a dead
// subscription owning the slot and blocking a later Apple/Google claim.
// Re-derive it from authoritative state as well as the event type.
const isDeleted =
  isDeletedEvent ||
  fresh === "missing" ||
  TERMINAL_STRIPE_STATUSES.has(fresh.status);

// A purged subscription has no fresh object; the terminal path only needs
// the id and the period end, both of which the event snapshot carries.
const subscription = fresh === "missing" ? eventSubscription : fresh;
```

Leave the rest of the method body unchanged — it already reads `subscription` and `isDeleted`, which now hold the authoritative values.

- [ ] **Step 11: Run the new tests to verify they pass**

```bash
pnpm --filter @tarmoto/backend test -- --testPathPatterns=account.service.spec -t "delayed"
```

Expected: PASS, both cases.

- [ ] **Step 12: Run the full account suite for regressions**

```bash
pnpm --filter @tarmoto/backend test -- --testPathPatterns=account
```

Expected: PASS. The echoing default mock from Step 6 keeps the existing webhook tests behaving as before. If a test fails because it never set up `constructWebhookEvent` (so the echo returns `'missing'` and the flow takes the terminal path), give that test an explicit `stripe.getSubscription.mockResolvedValueOnce(...)` matching its intent.

- [ ] **Step 13: Typecheck and lint**

```bash
pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/backend lint
```

Expected: clean. The parameter rename in Step 10 is the likely source of any error — check that no other reference to the old `subscription` / `isDeleted` parameter names survives above the new declarations.

- [ ] **Step 14: Commit**

```bash
git add apps/backend/src/modules/account/account.service.ts \
        apps/backend/src/modules/account/account.service.spec.ts \
        apps/backend/src/modules/account/stripe-billing.client.ts \
        apps/backend/src/modules/account/stripe-billing.client.spec.ts
git commit -m "fix(backend): re-query the live Stripe subscription on webhook writes

Finding 5b of the payments audit. \`handleWebhook\` applied
\`event.data.object\` directly with no version guard, and the lock fence
only orders lock acquisition, not Stripe event delivery — so a delayed
\`updated: active\` after a \`deleted\` could resurrect a canceled
subscription. \`event.created\` is second-granularity and cannot order
same-second events, so the re-query is the reliable fix.

Also re-derives \`isDeleted\` from the re-queried state, not just the event
type: a delayed \`updated\` whose live state is terminal now routes through
the identity-guarded \`clearStripeTerminal\` instead of \`claimForStripe\`,
which would otherwise leave a dead subscription owning the provider slot
and block a later Apple/Google claim.

Adds \`StripeBillingClient.getSubscription\` — a RAW fetch, since
\`getSubscriptionStatus\` normalises the status and drops the price."
```

---

### Task 3: Unmount `POST /account/subscription/iap/validate`

**Why:** Spec §6 step 1. The endpoint is authenticated and reachable in every environment with zero callers — no mobile IAP SDK exists and nothing calls it. Removing the route also resolves audit finding 4 (the advisory-vs-reject `productId` contract deviation) by deleting the endpoint that deviates.

**Files:**

- Modify: `apps/backend/src/modules/account/account.controller.ts` — remove the route (line 142-179), the `IapValidateBadRequestFilter` class (line 73+), the constructor injection (line 102), and the now-unused imports (lines 32, 38-40)
- Replace: `apps/backend/src/modules/account/account.controller.spec.ts` — **the entire file** exists only to test this route's validation error shape (`describe('AccountController — POST /account/subscription/iap/validate validation')`, all five tests hit that path). It is replaced wholesale with a single 404 regression guard.
- Modify: `apps/backend/src/modules/account/account.module.ts` — remove `IapValidateService` from `providers` (line 63) and its import (line 20)
- Regenerate: `packages/openapi-client/src/generated/schema.d.ts`, `packages/openapi/postman/tarmoto-api.postman_collection.json`

**Interfaces:**

- Consumes: nothing. Independent of Tasks 1 and 2.
- Produces: nothing. This task only removes surface.

**Note:** `iap-validate.service.ts`, `apple-billing.client.ts`, `apple-iap.config.ts`, `dto/iap-validate.dto.ts` and their spec files all **stay on disk** and keep passing their own unit tests. Only the HTTP mounting and the DI registration are removed. `AppleIapConfig` and `AppleStoreKitBillingClient` stay registered in `AccountModule` — they become inert without a consumer, and spec §6 step 2 removes the whole group after the RevenueCat vertical passes sandbox.

- [ ] **Step 1: Write the failing test**

Replace the **entire contents** of
`apps/backend/src/modules/account/account.controller.spec.ts` with the following.
Every test in the old file targeted the removed route's validation error shape,
so none of them survives; what remains is one guard against an accidental
re-mount:

```ts
import { Test } from "@nestjs/testing";
import type { INestApplication, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import request from "supertest";
import type { App } from "supertest/types";
import { AccountController } from "./account.controller.js";
import { AccountService } from "./account.service.js";
import { AccountDeletionService } from "./account-deletion.service.js";
import { AuthGuard } from "../auth/auth.guard.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";

/**
 * Spec 2026-08-06 §6 step 1: `POST /account/subscription/iap/validate` was
 * unmounted. It was authenticated and reachable in every environment with zero
 * callers — no mobile IAP SDK existed and nothing called it. Mobile IAP moves to
 * RevenueCat, whose purchases arrive by webhook.
 *
 * This suite's predecessor tested the route-scoped pipe that reshaped that
 * endpoint's DTO-validation 400s. With the route gone, the only thing worth
 * asserting is that it stays gone.
 */
describe("AccountController — retired IAP validate route", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountController],
      providers: [
        { provide: AccountService, useValue: {} },
        { provide: AccountDeletionService, useValue: {} },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<Request>().user = { userId: USER_ID };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  it("404s on the retired iap/validate route", async () => {
    await request(app.getHttpServer() as App)
      .post("/account/subscription/iap/validate")
      .send({ provider: "apple", transaction: "signed-jws" })
      .expect(404);
  });
});
```

Note the module no longer provides `IapValidateService` — if the controller still
injects it, `Test.createTestingModule` fails to resolve the dependency, which is
what makes this test fail before the fix.

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @tarmoto/backend test -- --testPathPatterns=account.controller.spec
```

Expected: FAIL — Nest cannot resolve `IapValidateService` for `AccountController`
(the provider was removed from the test module but the controller still injects
it). If it somehow resolves, the 404 assertion fails instead with a 201/400.

- [ ] **Step 3: Remove the route handler and its filter from the controller**

In `apps/backend/src/modules/account/account.controller.ts`:

1. Delete the whole `validateIap` method including its decorators — lines 142-179, from `@Post('subscription/iap/validate')` through the closing brace of the method.
2. Delete the `IapValidateBadRequestFilter` class (starts line 73) and its explanatory comment block above it. It exists solely for that route — confirm with `grep -n "IapValidateBadRequestFilter" apps/backend/src` before deleting; the only hits should be its declaration and the `@UseFilters` you just removed.
3. Remove the constructor injection on line 102: `private readonly iapValidateService: IapValidateService,`
4. Remove the now-unused imports: `IapValidateService` (line 32) and `IapValidateErrorResponseDto`, `IapValidateRequestDto`, `IapValidateResponseDto` (lines 38-40). Also drop `UseFilters` and `ExceptionFilter` from the `@nestjs/common` import if nothing else in the file uses them — check with grep first.

- [ ] **Step 4: Remove the provider from the module**

In `apps/backend/src/modules/account/account.module.ts`, delete line 63 (`IapValidateService,` in the `providers` array) and line 20 (its import).

- [ ] **Step 5: Confirm no stale IAP references remain in the wiring**

```bash
grep -rn "IapValidate\|iapValidateService" \
  apps/backend/src/modules/account/account.controller.ts \
  apps/backend/src/modules/account/account.controller.spec.ts \
  apps/backend/src/modules/account/account.module.ts
```

Expected: no output. Hits here mean Steps 3-4 missed something.

- [ ] **Step 6: Run the controller tests**

```bash
pnpm --filter @tarmoto/backend test -- --testPathPatterns=account.controller.spec
```

Expected: PASS, including the new assertion.

- [ ] **Step 7: Verify the app still boots and the IAP services still compile**

```bash
pnpm --filter @tarmoto/backend build
```

Expected: clean. `iap-validate.service.ts` and friends are still compiled — they are just no longer registered.

- [ ] **Step 8: Run the full backend suite**

```bash
pnpm --filter @tarmoto/backend test
```

Expected: PASS. `iap-validate.service.spec.ts` still passes — it constructs the service directly and does not depend on module registration.

- [ ] **Step 9: Regenerate the contract artifacts**

```bash
pnpm openapi:gen
pnpm postman:gen
```

Then confirm the route is gone from both:

```bash
grep -c "iap/validate" packages/openapi-client/src/generated/schema.d.ts \
  packages/openapi/postman/tarmoto-api.postman_collection.json
```

Expected: `0` for both files.

- [ ] **Step 10: Lint**

```bash
pnpm --filter @tarmoto/backend lint
```

Expected: clean. Unused-import errors here mean Step 3.4 missed something.

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/modules/account/account.controller.ts \
        apps/backend/src/modules/account/account.controller.spec.ts \
        apps/backend/src/modules/account/account.module.ts \
        packages/openapi-client/src/generated/schema.d.ts \
        packages/openapi/postman/tarmoto-api.postman_collection.json
git commit -m "refactor(backend): unmount the uncalled iap/validate endpoint

Spec 2026-08-06 §6 step 1. The route is authenticated and reachable in
every environment with zero callers — no mobile IAP SDK exists and nothing
calls it. Mobile IAP moves to RevenueCat, whose purchases arrive by
webhook.

Removing the route also resolves audit finding 4 (the advisory-vs-reject
productId contract deviation) by deleting the endpoint that deviates, so
no separate product call is needed on it.

The service, Apple client, config and DTOs stay on disk and keep passing
their unit tests; only the HTTP mounting and DI registration go. Spec §6
step 2 deletes the group once the RevenueCat vertical passes sandbox.

Regenerates the OpenAPI client schema and the Postman collection."
```

---

## Self-Review

**Spec coverage.** Spec §7 5a → Task 1. Spec §7 5b, both halves (re-query _and_ terminal routing with the deleted-then-delayed-`updated` regression test) → Task 2. Spec §6 step 1 → Task 3. Spec §10 contract artifacts → Task 3 steps 9 and 11. Spec §6 step 2 (deleting the ~6,200 lines) is deliberately **not** in this plan — it gates on sandbox proof from a later delivery step.

**Type consistency.** `isEntitlingStripeStatus` is defined in Task 1 step 4 and referenced in Task 1 step 5 only. `ENTITLING_STRIPE_STATUSES` and `TERMINAL_STRIPE_STATUSES` are both `ReadonlySet<string>` matched against raw Stripe statuses. `getSubscription` returns `Promise<StripeSubscription | 'missing'>` in the interface (Task 2 step 3), the implementation (step 4), and the consumer (step 10). The parameter rename in Task 2 step 10 (`subscription` → `eventSubscription`, `isDeleted` → `isDeletedEvent`) reintroduces both original names as locals, so the untouched method body below continues to compile — this is the one place a careless edit breaks the build, and step 13 checks for it.

**Fixtures verified against the real files.** `buildUser` exists at
`account.service.spec.ts:43`. The Stripe client spec's helpers
(`unconfiguredConfig`, `withFakeStripe`, `resourceMissingError`) exist at the top
of `stripe-billing.client.spec.ts` and Task 2 step 1 uses them verbatim.
`isResourceMissing` (`stripe-billing.client.ts:603`) and `requireStripe`
(`:503`) exist as Task 2 step 4 uses them. `account.controller.spec.ts` is
entirely IAP-validate coverage, hence the wholesale replacement in Task 3.

**Ordering.** Task 1 must land before Task 2: Task 2's re-query changes _which_ status the allowlist sees, and Task 2's `unpaid` test asserts Task 1's `tier: 'free'` behaviour. Task 3 is independent and can be done at any point.
