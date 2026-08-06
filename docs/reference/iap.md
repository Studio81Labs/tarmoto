# In-App Purchase (IAP) — Apple Validate Path (RETIRED)

> **⚠️ RETIRED — this endpoint no longer exists.** `POST
/api/v1/account/subscription/iap/validate` was **unmounted** (PR #1131).
> It is gone from the OpenAPI client schema and the Postman collection, and
> calling it returns **404**. Do not implement against this document.
>
> **Mobile IAP now goes through RevenueCat** — see
> [`docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`](../superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md).
> Store purchases will reach the backend via an authenticated RevenueCat
> **webhook**, not a client-called validate route. The decision followed
> [`payments-subscriptions-audit.md`](payments-subscriptions-audit.md),
> which found this endpoint had **zero callers**: no mobile IAP SDK was ever
> added, so the hardened backend behind it delivered no end-user value.
>
> **What this document is still good for.** The services it describes
> (`IapValidateService`, `AppleBillingClient`, `AppleIapConfig`, the DTOs)
> are **still on disk and still unit-tested** — only the HTTP route and the
> DI registration were removed, so a fallback survives until the RevenueCat
> vertical is proven in sandbox. §6 step 2 of the design spec deletes them
> at that point, and this file goes with them. Until then, treat everything
> below as an accurate description of **dormant, unreachable** code: useful
> for the Apple verification, trust-store and config details that carry over
> conceptually, **not** as an API reference.
>
> For the full feature-flag / tier system see
> [feature-flags.md](feature-flags.md). For the system map see
> [architecture.md](architecture.md).

Tarmoto rides sell through three exclusive subscription providers —
`stripe` | `apple` | `google` (`SUBSCRIPTION_PROVIDERS` in
`@tarmoto/shared`) — and a rider holds **one active subscription across
all of them**. That exclusivity rule is unchanged by the retirement: under
RevenueCat, Apple and Google purchases still claim the same single slot via
the same `ProviderClaimService`, with RevenueCat acting as an ingestion
channel rather than a fourth provider.

Today the **only** rider-reachable subscription path is Stripe on the web
companion.

## Endpoint (removed)

`POST /api/v1/account/subscription/iap/validate` — **unmounted; returns 404.** Recorded here for historical context only.

- Request was: `IapValidateRequestDto`
  - `provider`: `'apple'` (the only value ever supported)
  - `transaction`: the StoreKit2 signed transaction (JWS) to verify
    server-side
  - `productId` (optional): the client-reported App Store product id —
    a **hint only**, never trusted for entitlement. Note the audit recorded
    an open contract deviation here (the implementation logged and ignored a
    mismatch where the design required rejecting it); removing the route
    retired that deviation rather than resolving it.
- Response was: `IapValidateResponseDto` — the subscription snapshot
  (`SubscriptionSnapshotResponseDto`) plus `retryable: boolean` and
  `provider`

Implementation: the route handler and its `IapValidateService` provider
registration were removed from
`apps/backend/src/modules/account/account.controller.ts` and
`account.module.ts`. The service itself remains at
`apps/backend/src/modules/account/iap-validate.service.ts`, now with no
caller.

## Verification

The signed transaction is verified with Apple's **official, scoped**
`@apple/app-store-server-library` package (v3.1.0) — never the unscoped
third-party `app-store-server-library` package. `AppleBillingClient`
(`apple-billing.client.ts`) wraps its `SignedDataVerifier` to check the
signature, the x5c certificate chain up to the Apple root CA, the
`bundleId`, and the `environment`. A verification failure
(`VerificationException`) is classified by its `VerificationStatus`:
only a receipt-content structural failure (`VerificationStatus.FAILURE`)
is **terminal** — mapped to `400` with `retryable: false` — because a
malformed/forged receipt is never worth retrying. Every other status
(the trust-chain/certificate cases, `bundleId`/`environment` mismatch,
and any unrecognized status) is treated as a **retryable** deployment or
trust-store condition — mapped to `503` with `retryable: true` and
logged — so a wrong/outdated mounted root CA (which surfaces as the same
`VERIFICATION_FAILURE` status as a signature mismatch, hence
indistinguishable) never strands every paying rider on a terminal error.
The response never leaks the JWS or the underlying verification detail.

## Account binding (first, before any mutation)

`verified.appAccountToken` must equal the authenticated rider's
`users.id` (UUID). The mobile client sets `appAccountToken` to the
rider's user id at purchase time. A mismatch is rejected with `409`
before any row is touched — nothing about the purchase is ever applied
to the wrong account.

## Tier derivation

The granted tier comes **only** from the verified `productId`, looked up
against `IAP_PRODUCTS` (`@tarmoto/shared`). The request `productId` is
**advisory only**: if it disagrees with the verified product, the
mismatch is logged and ignored — it never influences entitlement and is
never a rejection cause. An unrecognized **verified** product (not in
`IAP_PRODUCTS`) is a genuine data problem and is rejected (`400`).

## Exclusivity

One active subscription per rider across `stripe` / `apple` / `google`.
Apple claims the single slot atomically via a guarded UPDATE
(`ProviderClaimService.claimForApple`). If another provider, or another
Apple original transaction, already owns the slot, the claim returns
`conflict` and the request is rejected with `409`. Re-validating the
same original transaction is idempotent — it returns the current
snapshot rather than erroring.

## Trial

A 14-day free trial is granted once per rider, tracked by
`users.billing_trial_used_at`. A trial transaction from a rider who has
already used their trial is rejected (`409`) and an
`ineligible_trial_rejected` reconciliation row is opened for ops
(idempotent on the original transaction id — a retried rejected trial
does not accumulate duplicate rows). A genuine first trial stamps
`billing_trial_used_at` (guarded, idempotent update) once the slot claim
succeeds.

## Authoritative current state

After verifying the client-supplied JWS offline, the flow re-queries the
App Store Server API (`AppStoreServerAPIClient.getAllSubscriptionStatuses`)
for the **authoritative** current status, expiry, and auto-renew state —
the client-supplied transaction is never trusted for current state (it
may be a stale renewal JWS). If Apple reports the subscription as
`expired` or `canceled`, the request is a terminal reject (`400`); the
service does not grant an expired or canceled subscription.

## Concurrency & serialization

Subscription mutations are serialized so concurrent deliveries can't
interleave their read→decide→write steps (e.g. an Apple `validate` and a
Stripe `customer.subscription.*` webhook both consuming the once-per-rider
trial marker). Two Redis locks apply, both fail-**closed** (a Redis outage
surfaces a retryable `503` rather than an unserialised mutation):

- **Per-rider lock** (`sub-mut:<userId>`) — held across the whole flow, so
  a rider's Apple `validate`, Stripe webhook, and future ASSN webhook run
  one at a time. It carries a durable, strictly-monotonic **fence token**
  (a Postgres sequence) that every guarded `users`-row UPDATE stamps and
  gates on, so a flow whose lease is lost mid-way can't clobber a newer
  flow's state.
- **OTID lock** (`sub-otid:<sha256(originalTransactionId)>`) — taken
  **inside** the per-rider lock, only on the Apple path, against a
  **different** rider validating the **same** original transaction. The
  per-rider lock can't order that case (different rider keys); the OTID
  lock makes the two riders run one at a time, so the second sees the
  first's committed claim and rejects mutation-free. Ordering is always
  rider → OTID (Stripe never takes an OTID lock), so no deadlock is
  possible. The OTID is hashed into the key so it never appears in a Redis
  key or a log line.
- **Durable claim serialization.** Because a Redis lease's TTL can't bound
  a DB write that stalls (a pool/row-lock wait), the ownership claim also
  runs inside a short transaction that takes a `pg_advisory_xact_lock` on
  the OTID (durable, independent of Redis) and sets
  `lock_timeout`/`statement_timeout` well below the lease — so a stalled
  claim aborts as a retryable `503` instead of committing after another
  rider already won. The Apple flow does **not** publish its fence before
  the claim; the claim's own guarded UPDATE stamps it, so a claim-time
  ownership conflict (0 rows on the unique index) leaves the row untouched.

**Mutation-free rejects.** Verification, account binding, and
foreign-ownership rejections (the OTID is already retained on another
rider's row, or the claim loses the unique-index race) touch **no** row.
The `apple_original_transaction_id` unique index remains the ultimate
authority behind both locks.

**Notification delivery.** Subscription lifecycle notifications
(confirmation/cancellation email, billing-failed push) are _decided_ under
the per-rider lock but _delivered_ from a durable queue (`subscription.notify`)
by the worker — awaiting the ~10s send inline in the webhook would risk
Stripe's ~20s timeout. The worker (not bound by that timeout) holds the SAME
per-rider lock across the send and applies two gates read under it:

- **Generation** — each transition that enqueues a notification bumps
  `users.subscription_notify_generation`; the job carries the value it was
  created for and delivers only while the row still equals it. So an ABA
  re-activation (Pro → cancel → Pro before the job drains) gets a distinct
  generation and the stale earlier job is dropped, while a benign same-state
  webhook redelivery (no enqueue → no bump) keeps matching. This is why the
  per-event `subscription_lock_fence` is **not** the gate — it bumps on every
  webhook and would wrongly drop valid notifications.
- **State** — the rider's current state must still match the announced
  transition (active on the announced tier / not entitled / `past_due`),
  catching a state change that didn't itself enqueue (so left the generation
  untouched).

The lease is then reasserted (renewing the TTL) and the transport bounded
below it, so a dispatch can't outlive the lock — e.g. an unbounded push during
a Redis outage delivered after a newer transition took the lock.

## Terminal-vs-retryable contract

Every error response body carries `{ message, retryable }`:

- `retryable: false` — the client must not retry: forged or expired
  receipt, account-binding mismatch, an unrecognized authoritative
  product, exclusivity conflict, or an ineligible trial. An advisory
  `productId` hint mismatch is never a rejection cause — it is ignored.
- `retryable: true` — a transient failure: the App Store or App Store
  Server API is temporarily unavailable (`503`). The client may retry.

A successful validation also returns `retryable: false` on the response
DTO (nothing to retry).

## Ops-enablement (never enabled; now unreachable)

> These variables were **never provisioned**, and with the route unmounted
> there is nothing left to enable.
>
> **`AppleIapConfig` is no longer registered in `AccountModule`**, so these
> variables are now genuinely inert — nothing reads them at startup or at
> request time. That de-registration was itself part of the unmount: Nest
> instantiates providers eagerly, and `AppleIapConfig`'s constructor
> **throws** on an invalid `TARMOTO_APPLE_IAP_ENVIRONMENT` (anything other
> than `Sandbox`/`Production`). While the provider stayed registered, a
> stale value left over in a deployment could crash backend startup for a
> feature no rider could reach. If you are reading this on an older commit,
> check `account.module.ts` before assuming the variables are safe to leave
> lying around.
>
> Retained here because the RevenueCat path needs the equivalent App Store
> Connect setup (product records, sandbox testers) and the trust-store
> gotcha below is the kind of thing worth not rediscovering. RevenueCat's
> own configuration is listed in §9 of the design spec.

The endpoint shipped **dark** until Apple credentials were configured. Env
vars (all `TARMOTO_APPLE_IAP_*`, read by `AppleIapConfig`):

| Variable                          | Purpose                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `TARMOTO_APPLE_IAP_ISSUER_ID`     | App Store Connect API issuer id                                                        |
| `TARMOTO_APPLE_IAP_KEY_ID`        | App Store Connect API key id                                                           |
| `TARMOTO_APPLE_IAP_PRIVATE_KEY`   | The App Store Connect `.p8` private key — a filesystem path **or** the inline contents |
| `TARMOTO_APPLE_IAP_BUNDLE_ID`     | The app's bundle identifier, checked during verification                               |
| `TARMOTO_APPLE_IAP_ENVIRONMENT`   | `Sandbox` (default) or `Production`                                                    |
| `TARMOTO_APPLE_IAP_ROOT_CERT_DIR` | **Required** for verification — directory of Apple root CA certs the verifier trusts   |
| `TARMOTO_APPLE_IAP_APP_APPLE_ID`  | Numeric App Store app id — **required in `Production`**, optional in `Sandbox`         |

`AppleIapConfig.isConfigured()` gates the issuer id, key id, private
key, and bundle id (the root cert dir is checked separately on the
verification path). When `TARMOTO_APPLE_IAP_ENVIRONMENT=Production`,
`isConfigured()` ALSO requires a valid numeric
`TARMOTO_APPLE_IAP_APP_APPLE_ID` — Apple's Production App Store Server
API calls require the app id, while Sandbox omits it. An operator who
sets the four core credentials but leaves `TARMOTO_APPLE_IAP_APP_APPLE_ID`
missing or invalid in Production gets a permanently-dark endpoint: while
unconfigured, the endpoint returns `503` (`retryable: true`) rather than
constructing an Apple client with incomplete credentials.

## Deferred to P1b (superseded — RevenueCat absorbs this)

> **P1b was never built and will not be built as described.** RevenueCat
> subsumes exactly this list for **both** stores — one webhook format
> instead of Apple ASSN v2 plus Google RTDN — which is a large part of why
> it was chosen over continuing the native path. Note the audit's caveat:
> RevenueCat replaces provider _ingestion_, **not** Tarmoto's own
> correctness envelope. Access still resolves from
> `users.subscription_tier`, so an authenticated RevenueCat webhook consumer
> with durable inbox persistence, identity-guarded terminal clears,
> re-query-under-lock ordering and losing-claim reconciliation is still owed
> — see §4 of the design spec.

The following were explicitly **out of scope** for this (P1a) validate
path and were never built:

- The App Store Server Notifications v2 (ASSN v2) webhook endpoint and
  `decodeNotification`
- The full subscription lifecycle beyond initial validate — renew,
  grace period, billing hold, recover, renewal-preference change,
  renewal-status change, expired, refund, revoke, reactivation
- The notification inbox's lease / dead-letter / redelivery processing
- The `store_billing_emails` ledger
