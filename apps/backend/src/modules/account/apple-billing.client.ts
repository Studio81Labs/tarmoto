import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APIError,
  APIException,
  AppStoreServerAPIClient,
  AutoRenewStatus,
  Environment,
  OfferType,
  SignedDataVerifier,
  Status,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type LastTransactionsItem,
  type StatusResponse,
} from '@apple/app-store-server-library';
import {
  AppleIapConfig,
  type AppleIapEnvironment,
} from './apple-iap.config.js';

export const APPLE_BILLING_CLIENT = Symbol('APPLE_BILLING_CLIENT');

export interface VerifiedAppleTransaction {
  originalTransactionId: string;
  transactionId: string;
  productId: string;
  appAccountToken: string | null; // the rider-linking UUID
  expiresDate: Date | null;
  isTrial: boolean; // offerType/intro-offer indicates a trial
  bundleId: string;
  environment: 'Sandbox' | 'Production';
}

export type AppleSubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'expired';

export interface AppleBillingClient {
  isConfigured(): boolean;
  /**
   * Verify a StoreKit2 signed JWSTransaction: signature + x5c chain to the
   * Apple root + bundleId + environment. Throws on any verification failure
   * (terminal — a bad/forged/mismatched receipt is never worth retrying).
   */
  verifyTransaction(jwsTransaction: string): Promise<VerifiedAppleTransaction>;
  /**
   * App Store Server API: the current status for the subscription. Throws a
   * retryable `AppleStoreUnavailableError` on a store outage (5xx / network /
   * Apple's *_RETRYABLE codes) so the caller can re-attempt rather than
   * mistaking a transient blip for a lapsed subscription.
   */
  getSubscriptionStatus(originalTransactionId: string): Promise<{
    status: AppleSubscriptionStatus;
    expiresDate: Date | null;
    autoRenew: boolean;
  }>;
}

/**
 * Thrown when the App Store Server API is transiently unavailable (an HTTP
 * 5xx, a network/DNS/timeout failure, or one of Apple's documented
 * `*_RETRYABLE` error codes). Distinct from a terminal verification failure:
 * callers (a later validation service / retry worker) should retry on this,
 * never on a `VerificationException`.
 */
export class AppleStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'AppleStoreUnavailableError';
  }
}

/**
 * The narrow slices of `@apple/app-store-server-library` the client actually
 * uses. Splitting them out gives tests a clean seam: a subclass overrides
 * `getVerifier()` / `getApiClient()` to return fakes, so the mapping logic is
 * exercised without Apple's real root-cert chain or a live network. The real
 * `SignedDataVerifier` and `AppStoreServerAPIClient` satisfy these
 * structurally.
 */
export interface AppleSignedDataVerifier {
  verifyAndDecodeTransaction(
    signedTransactionInfo: string,
  ): Promise<JWSTransactionDecodedPayload>;
  verifyAndDecodeRenewalInfo(
    signedRenewalInfo: string,
  ): Promise<JWSRenewalInfoDecodedPayload>;
}

export interface AppleSubscriptionStatusApi {
  getAllSubscriptionStatuses(
    anyTransactionId: string,
    status?: Status[],
  ): Promise<StatusResponse>;
}

/** Apple `APIError` codes that indicate a transient, retryable condition. */
const RETRYABLE_API_ERRORS: ReadonlySet<APIError> = new Set<APIError>([
  APIError.GENERAL_INTERNAL_RETRYABLE,
  APIError.RATE_LIMIT_EXCEEDED,
  APIError.ACCOUNT_NOT_FOUND_RETRYABLE,
  APIError.APP_NOT_FOUND_RETRYABLE,
  APIError.ORIGINAL_TRANSACTION_ID_NOT_FOUND_RETRYABLE,
]);

@Injectable()
export class AppleStoreKitBillingClient implements AppleBillingClient {
  private verifier: AppleSignedDataVerifier | null = null;
  private apiClient: AppleSubscriptionStatusApi | null = null;

  constructor(private readonly config: AppleIapConfig) {}

  isConfigured(): boolean {
    return this.config.isConfigured();
  }

  async verifyTransaction(
    jwsTransaction: string,
  ): Promise<VerifiedAppleTransaction> {
    this.requireConfigured();
    const verifier = this.getVerifier();
    // `verifyAndDecodeTransaction` enforces the x5c chain to the Apple root,
    // the configured `bundleId`, and the environment; any mismatch or bad
    // signature throws a `VerificationException`. We let it propagate — a
    // failed verification is terminal.
    const payload = await verifier.verifyAndDecodeTransaction(jwsTransaction);
    return mapVerifiedTransaction(payload);
  }

  async getSubscriptionStatus(originalTransactionId: string): Promise<{
    status: AppleSubscriptionStatus;
    expiresDate: Date | null;
    autoRenew: boolean;
  }> {
    this.requireConfigured();
    const api = this.getApiClient();

    let response: StatusResponse;
    try {
      response = await api.getAllSubscriptionStatuses(originalTransactionId);
    } catch (err) {
      if (isRetryableAppleApiError(err)) {
        throw new AppleStoreUnavailableError(
          'Apple App Store Server API is unavailable',
          { cause: err },
        );
      }
      throw err;
    }

    const item = findLastTransaction(response, originalTransactionId);
    if (!item || item.status == null || !item.signedTransactionInfo) {
      throw new Error(
        `No subscription status returned for original transaction ${originalTransactionId}`,
      );
    }

    const verifier = this.getVerifier();
    const transaction = await verifier.verifyAndDecodeTransaction(
      item.signedTransactionInfo,
    );
    const renewal = item.signedRenewalInfo
      ? await verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo)
      : null;

    const isTrial = transaction.offerType === OfferType.INTRODUCTORY_OFFER;
    return {
      status: mapSubscriptionStatus(item.status, isTrial),
      expiresDate: msToDate(transaction.expiresDate),
      autoRenew: renewal?.autoRenewStatus === AutoRenewStatus.ON,
    };
  }

  /**
   * Test seam: lazily built and memoized. Subclasses override to inject a
   * fake verifier so mapping is unit-tested without Apple's real root certs.
   */
  protected getVerifier(): AppleSignedDataVerifier {
    if (!this.verifier) {
      this.verifier = this.createVerifier();
    }
    return this.verifier;
  }

  /** Test seam — see {@link getVerifier}. */
  protected getApiClient(): AppleSubscriptionStatusApi {
    if (!this.apiClient) {
      this.apiClient = this.createApiClient();
    }
    return this.apiClient;
  }

  protected createVerifier(): AppleSignedDataVerifier {
    const { bundleId } = this.requireConfigured();
    // `enableOnlineChecks = false`: verification stays purely cryptographic
    // (x5c chain + bundleId + environment). Online checks add OCSP revocation
    // + current-date expiry, whose network failures would surface as a
    // *retryable* verification exception — but `verifyTransaction` treats
    // every verification failure as terminal, so we keep it offline and
    // deterministic.
    return new SignedDataVerifier(
      this.loadRootCertificates(),
      false,
      toEnvironment(this.config.environment),
      bundleId,
      this.readAppAppleId(),
    );
  }

  protected createApiClient(): AppleSubscriptionStatusApi {
    const { issuerId, keyId, privateKey, bundleId } = this.requireConfigured();
    return new AppStoreServerAPIClient(
      privateKey,
      keyId,
      issuerId,
      bundleId,
      toEnvironment(this.config.environment),
    );
  }

  /**
   * Loads the Apple root CA certificate(s) the verifier needs from the
   * directory named by `TARMOTO_APPLE_IAP_ROOT_CERT_DIR` (ops mounts the
   * Apple-published `.cer` roots there — they are NOT bundled as fixtures).
   * Throws when unconfigured so the failure is visible rather than silently
   * verifying against an empty trust store.
   */
  private loadRootCertificates(): Buffer[] {
    const dir = this.config.rootCertDir;
    if (!dir) {
      throw new ServiceUnavailableException(
        'Apple IAP root certificates are not configured',
      );
    }
    const certs = fs
      .readdirSync(dir)
      .filter((file) => /\.(cer|der|pem)$/i.test(file))
      .map((file) => fs.readFileSync(path.join(dir, file)));
    if (certs.length === 0) {
      throw new ServiceUnavailableException(
        'Apple IAP root certificate directory contains no certificates',
      );
    }
    return certs;
  }

  /**
   * The numeric App Store app id (`appAppleId`). Apple requires it for
   * Production verification and omits it in Sandbox; `AppleIapConfig` parses
   * it (null when unset/unparseable), which we pass through as `undefined`.
   */
  private readAppAppleId(): number | undefined {
    return this.config.appAppleId ?? undefined;
  }

  private requireConfigured(): {
    issuerId: string;
    keyId: string;
    privateKey: string;
    bundleId: string;
  } {
    const { issuerId, keyId, privateKey, bundleId } = this.config;
    if (
      !this.config.isConfigured() ||
      issuerId == null ||
      keyId == null ||
      privateKey == null ||
      bundleId == null
    ) {
      throw new ServiceUnavailableException('Apple IAP is not configured');
    }
    return { issuerId, keyId, privateKey, bundleId };
  }
}

function mapVerifiedTransaction(
  payload: JWSTransactionDecodedPayload,
): VerifiedAppleTransaction {
  return {
    originalTransactionId: requireField(
      payload.originalTransactionId,
      'originalTransactionId',
    ),
    transactionId: requireField(payload.transactionId, 'transactionId'),
    productId: requireField(payload.productId, 'productId'),
    appAccountToken: payload.appAccountToken ?? null,
    expiresDate: msToDate(payload.expiresDate),
    // Apple `OfferType.INTRODUCTORY_OFFER` (=== 1) is the free-trial /
    // intro-price offer; its presence marks the transaction as a trial.
    isTrial: payload.offerType === OfferType.INTRODUCTORY_OFFER,
    bundleId: requireField(payload.bundleId, 'bundleId'),
    environment: normalizeEnvironment(payload.environment),
  };
}

/**
 * Maps Apple's `Status` code to our subscription-status union. `ACTIVE` splits
 * into `trialing` vs `active` on the intro-offer signal; `BILLING_RETRY` and
 * `BILLING_GRACE_PERIOD` both mean "still entitled but Apple is chasing a
 * failed payment" → `past_due`; `REVOKED` (refund / family-sharing removal) →
 * `canceled`; `EXPIRED` → `expired`.
 */
function mapSubscriptionStatus(
  status: Status | number,
  isTrial: boolean,
): AppleSubscriptionStatus {
  // The cast gives every `case` a shared enum type with the switch predicate
  // (required by `no-unsafe-enum-comparison`, since Apple may hand back a raw
  // numeric code). TypeScript itself treats a numeric enum as freely
  // assignable from `number`, so it also considers this specific assertion a
  // no-op — hence the second disable below.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  switch (status as Status) {
    case Status.ACTIVE:
      return isTrial ? 'trialing' : 'active';
    case Status.EXPIRED:
      return 'expired';
    case Status.BILLING_RETRY:
    case Status.BILLING_GRACE_PERIOD:
      return 'past_due';
    case Status.REVOKED:
      return 'canceled';
    default:
      return 'expired';
  }
}

/**
 * Returns the last-transaction entry whose `originalTransactionId` matches the
 * requested one, or null when none does. `getAllSubscriptionStatuses` returns
 * `lastTransactions` for EVERY subscription in the product's subscription
 * group, so we must NOT fall back to the first entry — that could substitute a
 * different subscription's status/expiry/auto-renew and hand back the wrong
 * entitlement. A no-match is treated the same as empty data by the caller.
 */
function findLastTransaction(
  response: StatusResponse,
  originalTransactionId: string,
): LastTransactionsItem | null {
  const transactions = (response.data ?? []).flatMap(
    (group) => group.lastTransactions ?? [],
  );
  return (
    transactions.find(
      (transaction) =>
        transaction.originalTransactionId === originalTransactionId,
    ) ?? null
  );
}

function isRetryableAppleApiError(err: unknown): boolean {
  if (err instanceof APIException) {
    if (err.httpStatusCode >= 500) {
      return true;
    }
    return err.apiError != null && RETRYABLE_API_ERRORS.has(err.apiError);
  }
  // A non-`APIException` from the API call is a transport-level failure
  // (fetch/DNS/timeout) — no HTTP response was received at all, so it is a
  // store outage and safe to retry.
  return true;
}

function normalizeEnvironment(
  environment: Environment | string | undefined,
): AppleIapEnvironment {
  return environment === Environment.PRODUCTION ? 'Production' : 'Sandbox';
}

function toEnvironment(environment: AppleIapEnvironment): Environment {
  return environment === 'Production'
    ? Environment.PRODUCTION
    : Environment.SANDBOX;
}

function msToDate(epochMs: number | undefined): Date | null {
  return epochMs != null ? new Date(epochMs) : null;
}

function requireField(value: string | undefined, field: string): string {
  if (value == null) {
    throw new Error(
      `Apple transaction is missing the required field "${field}"`,
    );
  }
  return value;
}
