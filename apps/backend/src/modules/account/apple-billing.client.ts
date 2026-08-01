import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APIError,
  APIException,
  AppStoreServerAPIClient,
  AutoRenewStatus,
  Environment,
  GetTransactionHistoryVersion,
  OfferType,
  Order,
  SignedDataVerifier,
  Status,
  type HistoryResponse,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type LastTransactionsItem,
  type StatusResponse,
  type TransactionHistoryRequest,
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
  | 'billing_retry'
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
   * App Store Server API: the AUTHORITATIVE current state for the subscription.
   * The selected last-transaction's `signedTransactionInfo` is verified+decoded
   * with the same `SignedDataVerifier` used for the client-submitted JWS, so the
   * returned `productId`/`isTrial` reflect Apple's CURRENT transaction — not a
   * possibly-stale client-submitted one (within a subscription group an old JWS
   * keeps the same `originalTransactionId` after an upgrade/downgrade). Throws a
   * retryable `AppleStoreUnavailableError` on a store outage (5xx / network /
   * Apple's *_RETRYABLE codes) so the caller can re-attempt rather than
   * mistaking a transient blip for a lapsed subscription.
   */
  getSubscriptionStatus(originalTransactionId: string): Promise<{
    status: AppleSubscriptionStatus;
    productId: string;
    isTrial: boolean;
    expiresDate: Date | null;
    /**
     * The verified authoritative transaction's JWS `signedDate` (ms epoch →
     * Date). A strictly-monotonic ordering value Apple stamps on each issued
     * state, so a later state has a strictly greater `signedDate`. The claim /
     * terminal-clear guards order overlapping validations for the same original
     * transaction id on this value — not the period, which an `active` and a
     * later `revoked`/`expired` state can share.
     */
    signedDate: Date;
    autoRenew: boolean;
  }>;
  /**
   * True when an introductory offer was EVER used for this subscription,
   * determined from its full transaction HISTORY (not only the latest
   * transaction). The authoritative CURRENT transaction stops carrying the
   * introductory `offerType` once the intro period renews to paid, so a
   * subscription first validated/restored after that renewal would otherwise
   * look trial-free and let the rider claim another once-per-lifetime trial.
   * Throws the same retryable `AppleStoreUnavailableError` as
   * `getSubscriptionStatus` on a store outage.
   */
  hasUsedIntroductoryOffer(originalTransactionId: string): Promise<boolean>;
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
 * Thrown when the App Store Server API returns a TERMINAL, non-retryable
 * response — a documented 4xx `APIException` such as
 * `INVALID_ORIGINAL_TRANSACTION_ID` that will never succeed on retry. Symmetric
 * with {@link AppleStoreUnavailableError}: callers branch on the type to map a
 * store outage to a retryable response and a terminal store rejection to a
 * terminal one, instead of collapsing every non-outage API error into a
 * retryable 503. The original `APIException` is attached as `cause` for
 * server-side logging only — callers must NOT leak its detail to clients.
 */
export class AppleTerminalApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'AppleTerminalApiError';
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
  getTransactionHistory(
    anyTransactionId: string,
    revision: string | null,
    transactionHistoryRequest: TransactionHistoryRequest,
    version?: GetTransactionHistoryVersion,
  ): Promise<HistoryResponse>;
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
    productId: string;
    isTrial: boolean;
    expiresDate: Date | null;
    signedDate: Date;
    autoRenew: boolean;
  }> {
    this.requireConfigured();
    const api = this.getApiClient();

    let response: StatusResponse;
    try {
      response = await api.getAllSubscriptionStatuses(originalTransactionId);
    } catch (err) {
      throw toAppleApiError(err);
    }

    const item = findLastTransaction(response, originalTransactionId);
    if (!item || item.status == null || !item.signedTransactionInfo) {
      throw new Error(
        `No subscription status returned for original transaction ${originalTransactionId}`,
      );
    }

    // Verify+decode the AUTHORITATIVE signed transaction so its product/trial
    // signal is trustworthy (never derived from the client-submitted JWS). A
    // verification failure here is a store-side anomaly for a valid otid, not a
    // client fault: we let it propagate as a plain error so the caller's
    // non-outage branch classifies it as RETRYABLE (same as an empty/unparseable
    // status), rather than treating it as a terminal client error.
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
      productId: requireField(transaction.productId, 'productId'),
      isTrial,
      expiresDate: msToDate(transaction.expiresDate),
      // Apple stamps `signedDate` on every issued transaction; a missing one is
      // a store-side anomaly, so we `requireDate` it (a plain Error the caller's
      // non-outage branch classifies as RETRYABLE, like an unparseable status).
      signedDate: requireDate(transaction.signedDate, 'signedDate'),
      autoRenew: renewal?.autoRenewStatus === AutoRenewStatus.ON,
    };
  }

  async hasUsedIntroductoryOffer(
    originalTransactionId: string,
  ): Promise<boolean> {
    this.requireConfigured();
    const api = this.getApiClient();
    const verifier = this.getVerifier();

    // Page oldest-first through the customer's transaction history, verifying +
    // decoding each signed transaction, and stop at the FIRST introductory
    // offer. Bounded to `MAX_PAGES` (20 transactions/page) so a very long
    // history can't turn one validate into an unbounded run of Apple calls.
    const MAX_PAGES = 20;
    let revision: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let response: HistoryResponse;
      try {
        response = await api.getTransactionHistory(
          originalTransactionId,
          revision,
          { sort: Order.ASCENDING },
          GetTransactionHistoryVersion.V2,
        );
      } catch (err) {
        throw toAppleApiError(err);
      }

      for (const signed of response.signedTransactions ?? []) {
        const transaction = await verifier.verifyAndDecodeTransaction(signed);
        if (transaction.offerType === OfferType.INTRODUCTORY_OFFER) {
          return true;
        }
      }

      if (!response.hasMore || !response.revision) {
        break;
      }
      revision = response.revision;
    }

    return false;
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
 * into `trialing` vs `active` on the intro-offer signal. `BILLING_GRACE_PERIOD`
 * means the rider is STILL ENTITLED (Apple grants access during grace while it
 * chases a failed payment) → `past_due`. `BILLING_RETRY` means the grace period
 * has ended and Apple is retrying WITHOUT continued access → its own
 * `billing_retry` value so the caller can drop the paid tier while retaining
 * Apple ownership for a later successful renewal. `REVOKED` (refund /
 * family-sharing removal) → `canceled`; `EXPIRED` → `expired`.
 */
function mapSubscriptionStatus(
  status: Status,
  isTrial: boolean,
): AppleSubscriptionStatus {
  // A numeric enum is assignable from a raw `number`, so an out-of-range code
  // Apple might hand back still reaches the `default` branch at runtime (the
  // static type does not constrain the runtime switch).
  switch (status) {
    case Status.ACTIVE:
      return isTrial ? 'trialing' : 'active';
    case Status.EXPIRED:
      return 'expired';
    case Status.BILLING_GRACE_PERIOD:
      return 'past_due';
    case Status.BILLING_RETRY:
      return 'billing_retry';
    case Status.REVOKED:
      return 'canceled';
    default:
      // NEVER map an unrecognized status to `expired`: that would
      // destructively route an existing owner into `clearAppleTerminal` and
      // drop their tier + provider binding for a status we simply failed to
      // recognize (e.g. a code Apple introduces after this union was
      // written) — a silent fallback that hides the real failure. Throw the
      // existing retryable error instead so `getSubscriptionStatus`'s caller
      // classifies it the same as a store outage (503 `retryable:true`): the
      // client retries and the owner keeps their entitlement.
      throw new AppleStoreUnavailableError(
        `Unrecognized Apple subscription status: ${String(status)}`,
      );
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

/**
 * Classifies an App Store Server API failure into the right typed error so
 * callers can branch cleanly: a transient/outage condition becomes a retryable
 * {@link AppleStoreUnavailableError}, while a documented non-retryable
 * `APIException` (a terminal 4xx like `INVALID_ORIGINAL_TRANSACTION_ID`) becomes
 * a terminal {@link AppleTerminalApiError}. The raw error is preserved as
 * `cause` for logging only.
 */
function toAppleApiError(
  err: unknown,
): AppleStoreUnavailableError | AppleTerminalApiError {
  if (isRetryableAppleApiError(err)) {
    return new AppleStoreUnavailableError(
      'Apple App Store Server API is unavailable',
      { cause: err },
    );
  }
  return new AppleTerminalApiError(
    'Apple App Store Server API rejected the request',
    { cause: err },
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

function requireDate(epochMs: number | undefined, field: string): Date {
  if (epochMs == null) {
    throw new Error(
      `Apple transaction is missing the required field "${field}"`,
    );
  }
  return new Date(epochMs);
}

function requireField(value: string | undefined, field: string): string {
  if (value == null) {
    throw new Error(
      `Apple transaction is missing the required field "${field}"`,
    );
  }
  return value;
}
