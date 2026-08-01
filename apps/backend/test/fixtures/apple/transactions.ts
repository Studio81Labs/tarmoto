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
  signedRenewalInfo?: string | undefined;
}): StatusResponse {
  return {
    environment: Environment.SANDBOX,
    bundleId: 'com.tarmoto.app',
    data: [
      {
        subscriptionGroupIdentifier: '20000000',
        lastTransactions: [
          {
            status: input.status,
            originalTransactionId:
              input.originalTransactionId ?? ORIGINAL_TRANSACTION_ID,
            signedTransactionInfo:
              input.signedTransactionInfo ?? 'signed-transaction-jws',
            signedRenewalInfo: input.signedRenewalInfo ?? 'signed-renewal-jws',
          },
        ],
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
