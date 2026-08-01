import {
  AutoRenewStatus,
  Environment,
  OfferType,
  Status,
  type HistoryResponse,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type StatusResponse,
} from '@apple/app-store-server-library';

/**
 * Fixtures for `AppleStoreKitBillingClient` tests. These are plain decoded
 * payloads / API responses — NOT signed JWS blobs or real Apple certificates.
 * The client is exercised through its verifier/API seam, so the mapping logic
 * is tested against these decoded shapes without any real crypto.
 */

export const ORIGINAL_TRANSACTION_ID = '2000000000000001';
export const APP_ACCOUNT_TOKEN = '11111111-2222-3333-4444-555555555555';
export const EXPIRES_DATE_MS = 1_900_000_000_000; // 2030-03-17T15:06:40Z
export const SIGNED_DATE_MS = 1_800_000_000_000; // 2027-01-15T08:00:00Z
// A LATER renewal-info signedDate — Apple re-signs the renewal info on
// renewal/status changes, so it can advance past the transaction signedDate.
export const RENEWAL_SIGNED_DATE_MS = 1_850_000_000_000; // 2028-08-16T...Z

export function standardTransactionPayload(
  overrides: Partial<JWSTransactionDecodedPayload> = {},
): JWSTransactionDecodedPayload {
  return {
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    transactionId: '2000000000000002',
    productId: 'com.tarmoto.pro.annual',
    bundleId: 'com.tarmoto.app',
    appAccountToken: APP_ACCOUNT_TOKEN,
    expiresDate: EXPIRES_DATE_MS,
    // Apple stamps `signedDate` on every issued transaction — a strictly
    // monotonic per-state ordering value the claim guards rely on.
    signedDate: SIGNED_DATE_MS,
    environment: Environment.SANDBOX,
    ...overrides,
  };
}

export function introOfferTransactionPayload(
  overrides: Partial<JWSTransactionDecodedPayload> = {},
): JWSTransactionDecodedPayload {
  return standardTransactionPayload({
    offerType: OfferType.INTRODUCTORY_OFFER,
    ...overrides,
  });
}

export function renewalInfoPayload(
  autoRenew: boolean,
  overrides: Partial<JWSRenewalInfoDecodedPayload> = {},
): JWSRenewalInfoDecodedPayload {
  return {
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    autoRenewStatus: autoRenew ? AutoRenewStatus.ON : AutoRenewStatus.OFF,
    // Apple always stamps a renewal `signedDate`; default to the same value
    // as `standardTransactionPayload`'s so tests that don't care about
    // ordering still exercise a COMPLETE renewal payload (a missing
    // `signedDate` now throws retryable — see apple-billing.client.ts). Pass
    // `signedDate: undefined` in `overrides` to explicitly test the
    // missing-field case.
    signedDate: SIGNED_DATE_MS,
    ...overrides,
  };
}

/**
 * A minimal `StatusResponse` whose single last-transaction carries the given
 * `Status` and references the (opaque, here) signed transaction/renewal JWS
 * strings the fake verifier will decode.
 */
export function statusResponse(input: {
  status: Status;
  originalTransactionId?: string;
  signedTransactionInfo?: string;
  /**
   * The signed renewal-info JWS. Pass `null` to OMIT it entirely (Apple can omit
   * it on terminal statuses; on entitling statuses the client treats the absence
   * as a retryable anomaly). Omitting the field or passing a string keeps/sets a
   * present renewal-info JWS.
   */
  signedRenewalInfo?: string | null;
}): StatusResponse {
  const lastTransaction: NonNullable<
    NonNullable<StatusResponse['data']>[number]['lastTransactions']
  >[number] = {
    status: input.status,
    originalTransactionId:
      input.originalTransactionId ?? ORIGINAL_TRANSACTION_ID,
    signedTransactionInfo:
      input.signedTransactionInfo ?? 'signed-transaction-jws',
  };
  if (input.signedRenewalInfo !== null) {
    lastTransaction.signedRenewalInfo =
      input.signedRenewalInfo ?? 'signed-renewal-jws';
  }
  return {
    environment: Environment.SANDBOX,
    bundleId: 'com.tarmoto.app',
    data: [
      {
        subscriptionGroupIdentifier: '20000000',
        lastTransactions: [lastTransaction],
      },
    ],
  };
}

/**
 * A `StatusResponse` whose subscription group carries several
 * `lastTransactions` — as Apple returns for a product's whole subscription
 * group. Used to prove the client selects by `originalTransactionId` rather
 * than blindly taking the first entry.
 */
export function multiStatusResponse(
  entries: Array<{
    status: Status;
    originalTransactionId: string;
    signedTransactionInfo: string;
    signedRenewalInfo?: string;
  }>,
): StatusResponse {
  return {
    environment: Environment.SANDBOX,
    bundleId: 'com.tarmoto.app',
    data: [
      {
        subscriptionGroupIdentifier: '20000000',
        lastTransactions: entries.map((entry) => ({
          status: entry.status,
          originalTransactionId: entry.originalTransactionId,
          signedTransactionInfo: entry.signedTransactionInfo,
          signedRenewalInfo: entry.signedRenewalInfo ?? 'signed-renewal-jws',
        })),
      },
    ],
  };
}

/** An empty `StatusResponse` (`data: []`) — Apple returned no subscriptions. */
export function emptyStatusResponse(): StatusResponse {
  return {
    environment: Environment.SANDBOX,
    bundleId: 'com.tarmoto.app',
    data: [],
  };
}

/**
 * A `HistoryResponse` page carrying the given signed-transaction JWS strings
 * (the fake verifier decodes them). `hasMore`/`revision` drive the client's
 * pagination loop.
 */
export function historyResponse(input: {
  signedTransactions: string[];
  hasMore?: boolean;
  revision?: string;
}): HistoryResponse {
  return {
    environment: Environment.SANDBOX,
    bundleId: 'com.tarmoto.app',
    hasMore: input.hasMore ?? false,
    revision: input.revision,
    signedTransactions: input.signedTransactions,
  };
}
