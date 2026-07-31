# In-App Purchase (IAP) — Apple Validate Path

> Server-side validation of native Apple StoreKit2 subscription purchases,
> alongside the existing Stripe web checkout. For the full feature-flag /
> tier system see [feature-flags.md](feature-flags.md). For the system map
> see [architecture.md](architecture.md).

Tarmoto rides sell through three exclusive subscription providers —
`stripe` | `apple` | `google` (`SUBSCRIPTION_PROVIDERS` in
`@tarmoto/shared`) — but a rider holds **one active subscription across
all of them**. Apple's path (P1a) is live and server-enforced; Google
Play IAP validation is a later phase.

## Endpoint

`POST /api/v1/account/subscription/iap/validate` — auth-guarded
(`@ApiBearerAuth`).

- Request: `IapValidateRequestDto`
  - `provider`: `'apple'` (the only supported value in this phase)
  - `transaction`: the StoreKit2 signed transaction (JWS) to verify
    server-side
  - `productId` (optional): the client-reported App Store product id —
    a **hint only**, never trusted for entitlement
- Response: `IapValidateResponseDto` — the subscription snapshot
  (`SubscriptionSnapshotResponseDto`) plus `retryable: boolean` and
  `provider`

Implementation: `apps/backend/src/modules/account/account.controller.ts`
(`validateIap`) → `IapValidateService.validate()`
(`apps/backend/src/modules/account/iap-validate.service.ts`).

## Verification

The signed transaction is verified with Apple's **official, scoped**
`@apple/app-store-server-library` package (v3.1.0) — never the unscoped
third-party `app-store-server-library` package. `AppleBillingClient`
(`apple-billing.client.ts`) wraps its `SignedDataVerifier` to check the
signature, the x5c certificate chain up to the Apple root CA, the
`bundleId`, and the `environment`. A verification failure
(`VerificationException`) is **terminal** — mapped to `400` with
`retryable: false`; the response never leaks the JWS or the underlying
verification detail.

## Account binding (first, before any mutation)

`verified.appAccountToken` must equal the authenticated rider's
`users.id` (UUID). The mobile client sets `appAccountToken` to the
rider's user id at purchase time. A mismatch is rejected with `409`
before any row is touched — nothing about the purchase is ever applied
to the wrong account.

## Tier derivation

The granted tier comes **only** from the verified `productId`, looked up
against `IAP_PRODUCTS` (`@tarmoto/shared`). The request `productId` is
cross-checked as a hint: if it disagrees with the verified product, the
request is rejected (`400`) and the mismatched hint never influences
entitlement. An unrecognized verified product is also a `400`.

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

## Terminal-vs-retryable contract

Every error response body carries `{ message, retryable }`:

- `retryable: false` — the client must not retry: forged or expired
  receipt, account-binding mismatch, unrecognized/mismatched product,
  exclusivity conflict, or an ineligible trial.
- `retryable: true` — a transient failure: the App Store or App Store
  Server API is temporarily unavailable (`503`). The client may retry.

A successful validation also returns `retryable: false` on the response
DTO (nothing to retry).

## Ops-enablement (ships dark)

The endpoint ships **dark** until Apple credentials are configured. Env
vars (all `TARMOTO_APPLE_IAP_*`, read by `AppleIapConfig`):

| Variable                          | Purpose                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `TARMOTO_APPLE_IAP_ISSUER_ID`     | App Store Connect API issuer id                                                        |
| `TARMOTO_APPLE_IAP_KEY_ID`        | App Store Connect API key id                                                           |
| `TARMOTO_APPLE_IAP_PRIVATE_KEY`   | The App Store Connect `.p8` private key — a filesystem path **or** the inline contents |
| `TARMOTO_APPLE_IAP_BUNDLE_ID`     | The app's bundle identifier, checked during verification                               |
| `TARMOTO_APPLE_IAP_ENVIRONMENT`   | `Sandbox` (default) or `Production`                                                    |
| `TARMOTO_APPLE_IAP_ROOT_CERT_DIR` | **Required** for verification — directory of Apple root CA certs the verifier trusts   |
| `TARMOTO_APPLE_IAP_APP_APPLE_ID`  | Numeric App Store app id                                                               |

`AppleIapConfig.isConfigured()` gates the issuer id, key id, private
key, and bundle id (the root cert dir is checked separately on the
verification path). While unconfigured, the endpoint returns `503`
(`retryable: true`) rather than constructing an Apple client with
incomplete credentials.

## Deferred to P1b

The following are explicitly **out of scope** for this (P1a) validate
path and are not built yet:

- The App Store Server Notifications v2 (ASSN v2) webhook endpoint and
  `decodeNotification`
- The full subscription lifecycle beyond initial validate — renew,
  grace period, billing hold, recover, renewal-preference change,
  renewal-status change, expired, refund, revoke, reactivation
- The notification inbox's lease / dead-letter / redelivery processing
- The `store_billing_emails` ledger
