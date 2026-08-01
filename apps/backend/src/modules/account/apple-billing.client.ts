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
   * Apple root + bundleId + environment. Throws `VerificationException` on any
   * verification failure; the CALLER (`IapValidateService`) classifies it by
   * `VerificationStatus` — only `FAILURE` (receipt-content) is terminal, every
   * other status (trust-chain/config, and the indistinguishable
   * `VERIFICATION_FAILURE`) is a retryable deployment/trust-store condition.
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
     * The complete-status-snapshot ordering value: `max(transaction.signedDate,
     * renewalInfo.signedDate)` (each ms epoch → Date). The claim / terminal-clear
     * guards order overlapping validations for the same original transaction id
     * on this value — not the period, which an `active` and a later
     * `revoked`/`expired` state can share.
     *
     * The TRANSACTION `signedDate` alone is insufficient: it advances only when
     * Apple issues a NEW transaction, so it does NOT move when Apple changes
     * renewal information or the outer subscription status WITHOUT a new
     * transaction — auto-renew cancellation, entering grace, billing retry, or
     * expiration. Apple RE-SIGNS the renewal info on those transitions, so its
     * `signedDate` advances where the transaction's does not. Taking the max
     * captures BOTH new-transaction and renewal/status transitions, so a stale
     * overlapping validation can no longer carry a different state under an
     * equal ordering value and slip past the `<=` claim/clear guards.
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

/**
 * ENTITLING (still-charging / will-keep-renewing) statuses — mirrors
 * `iap-validate.service.ts`'s `ENTITLING_APPLE_STATUSES`. Duplicated locally
 * (rather than imported) so the client's own invariant — an entitling status
 * must carry an authoritative `expiresDate` — doesn't depend on the
 * validate service's module.
 */
const ENTITLING_STATUSES: ReadonlySet<AppleSubscriptionStatus> = new Set([
  'active',
  'trialing',
  'past_due',
  'billing_retry',
]);

/**
 * The ONLY Apple `APIError` codes classified as TERMINAL — a fail-SAFE
 * whitelist. Each names a genuinely TRANSACTION-IDENTITY-specific fault: the
 * queried transaction/original-transaction id is itself malformed or does not
 * exist, so no retry and no deployment-side fix could ever make it succeed.
 *
 * Everything NOT in this set is classified RETRYABLE — deliberately including
 * AUTH failures (HTTP 401/403 from a rotated/incorrect App Store Server API
 * credential), APP-CONFIG errors (`APP_NOT_FOUND` and siblings), rate limits,
 * 5xx, transport/network failures, and any unrecognized/absent code. Those are
 * DEPLOYMENT-WIDE conditions, not bad transactions: misclassifying one as
 * terminal would finish every valid charged purchase and direct riders to
 * cancellation WITHOUT entitlement. Retrying a truly-terminal error a few times
 * is cheap; stranding a paying rider is not — so we err toward RETRYABLE for
 * anything ambiguous.
 *
 * Note the `*_RETRYABLE` not-found variants
 * (`ORIGINAL_TRANSACTION_ID_NOT_FOUND_RETRYABLE`, …) are intentionally EXCLUDED
 * here — Apple marks them retryable by definition, so they fall through to the
 * retryable default.
 */
const TERMINAL_API_ERRORS: ReadonlySet<APIError> = new Set<APIError>([
  APIError.INVALID_ORIGINAL_TRANSACTION_ID,
  APIError.INVALID_TRANSACTION_ID,
  APIError.ORIGINAL_TRANSACTION_ID_NOT_FOUND,
  APIError.TRANSACTION_ID_NOT_FOUND,
  APIError.TRANSACTION_ID_IS_NOT_ORIGINAL_TRANSACTION_ID_ERROR,
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
      // P2 review round 21, Finding 3: never interpolate the original
      // transaction id into a thrown message — `IapValidateService` logs
      // `err.stack` for this class of error, which would otherwise copy the
      // stable App Store billing identifier into application logs. A static
      // message is sufficient; the service-side log already records the
      // operation context.
      throw new Error(
        'Apple returned no matching status for the requested subscription',
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

    // P2 review round 21, Finding 2: `findLastTransaction` matched the OUTER
    // `LastTransactionsItem.originalTransactionId` — an UNVERIFIED plain JSON
    // field on the response, not part of the signed payload. Apple could
    // return an inconsistent subscription-group response whose outer item
    // names the REQUESTED otid but whose VERIFIED `signedTransactionInfo`
    // decodes to a DIFFERENT lineage; using that payload's product/expiry/
    // signedDate would then claim the requested subscription using another
    // subscription's data. Re-check identity against the VERIFIED payload
    // itself. A mismatch is a store-side anomaly, not a client fault, so it's
    // retryable — and the message never interpolates either otid (Finding 3).
    if (transaction.originalTransactionId !== originalTransactionId) {
      throw new AppleStoreUnavailableError(
        'Apple returned a signed transaction that does not match the requested subscription',
      );
    }

    const isTrial = transaction.offerType === OfferType.INTRODUCTORY_OFFER;
    const status = mapSubscriptionStatus(item.status, isTrial);
    // Apple stamps `signedDate` on every issued transaction; a missing one is
    // a store-side anomaly, so we `requireDate` it (a plain Error the caller's
    // non-outage branch classifies as RETRYABLE, like an unparseable status).
    const transactionSignedDate = requireDate(
      transaction.signedDate,
      'signedDate',
    );

    // EVERY auto-renewable subscription status — ENTITLING (active / trialing /
    // grace / billing-retry) AND TERMINAL (expired / canceled/REVOKED) — MUST
    // carry renewal info. Apple returns `signedRenewalInfo` for auto-renewable
    // subscriptions INCLUDING expired/revoked ones (it carries the current
    // renewal state), and Tarmoto only sells auto-renewable subs. Renewal info
    // yields both `autoRenew` AND the renewal `signedDate`; Apple re-signs it on
    // renewal/status changes — including expiry/revocation — so its `signedDate`
    // advances where the transaction's does not. If Apple omits it for ANY
    // status, treat the absence as a retryable store anomaly rather than
    // proceeding with a stale transaction-only date: on an entitling status the
    // old fallback FABRICATED `autoRenew=false` (telling a rider their live plan
    // was canceling); on a terminal status it fell back to the OLDER transaction
    // `signedDate`, so a prior entitling validation that stored the newer renewal
    // `signedDate` would block `clearAppleTerminal`'s `<=` guard from advancing —
    // the downgrade silently no-ops while the paid tier stayed active. Requiring
    // renewal info uniformly gives the terminal ordering value the newer renewal
    // `signedDate`, so the guarded clear can advance and actually downgrade.
    // (This SUPERSEDES the prior round's carve-out that let terminal statuses
    // omit renewal info.)
    if (!item.signedRenewalInfo) {
      throw new AppleStoreUnavailableError(
        'Apple returned a subscription status without renewal information',
      );
    }
    const renewal = await verifier.verifyAndDecodeRenewalInfo(
      item.signedRenewalInfo,
    );
    // Finding 2: the same identity check applies to the decoded renewal
    // payload — `JWSRenewalInfoDecodedPayload` also carries an
    // `originalTransactionId`. A mismatch here is the same class of anomaly
    // as the transaction check above (Apple's inconsistent response naming
    // the requested otid outwardly but resolving a different lineage's
    // renewal state inwardly): never silently use it. Retryable, no otid in
    // the message.
    if (
      renewal.originalTransactionId != null &&
      renewal.originalTransactionId !== originalTransactionId
    ) {
      throw new AppleStoreUnavailableError(
        'Apple returned renewal information that does not match the requested subscription',
      );
    }
    // The decoded renewal payload itself must be COMPLETE: a present
    // `signedRenewalInfo` whose VERIFIED payload omits `autoRenewStatus` or
    // `signedDate` is the same store-side anomaly as omitting renewal info
    // entirely (see above), just one level deeper. Silently defaulting a
    // missing `autoRenewStatus` to OFF would fabricate "canceling" for a live
    // subscription; silently falling `signedDate` back to the transaction's
    // would resurrect the exact ordering-guard failure the block above exists
    // to prevent (a stale stored renewal date blocking `clearAppleTerminal`'s
    // `<=` guard from advancing). Require BOTH fields — the same retryable
    // error as the missing-renewal-info case — never a terminal rejection,
    // since this is an Apple/store-side anomaly, not a client fault. (The
    // comparison is computed before the presence guards so the field keeps
    // its full decoded-payload type; the guards below reject before either
    // derived value is ever used or returned.)
    const autoRenew = renewal.autoRenewStatus === AutoRenewStatus.ON;
    if (renewal.autoRenewStatus == null) {
      throw new AppleStoreUnavailableError(
        'Apple renewal information is missing the required field "autoRenewStatus"',
      );
    }
    if (renewal.signedDate == null) {
      throw new AppleStoreUnavailableError(
        'Apple renewal information is missing the required field "signedDate"',
      );
    }
    const renewalSignedDate = msToDate(renewal.signedDate);
    const expiresDate = msToDate(transaction.expiresDate);
    // ENTITLING statuses (active/trialing/grace/billing-retry) MUST carry an
    // authoritative `expiresDate`: `iap-validate.service.ts` persists this
    // value VERBATIM as `currentPeriodEnd`/`renews_at` with NO fallback to the
    // client-submitted JWS's `expiresDate` (a stale submitted JWS could
    // otherwise backfill an older, wrong period on an otherwise-live
    // subscription). A present entitling status with a missing `expiresDate`
    // is a store-side anomaly — the same class of anomaly as missing renewal
    // info above — so fail retryable rather than let a stale/null period
    // persist. TERMINAL statuses (expired/canceled) are exempt: `expiresDate`
    // may legitimately be absent/in-the-past there, and they never claim.
    if (expiresDate == null && ENTITLING_STATUSES.has(status)) {
      throw new AppleStoreUnavailableError(
        'Apple subscription status is entitling but is missing the required field "expiresDate"',
      );
    }

    return {
      status,
      productId: requireField(transaction.productId, 'productId'),
      isTrial,
      expiresDate,
      // The complete-status-snapshot ordering value — advances on BOTH a new
      // transaction and a renewal/status change (see the interface doc).
      signedDate: maxDate(transactionSignedDate, renewalSignedDate),
      autoRenew,
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
    // Tracks whether ANY transaction belonging to the requested OTID's
    // lineage was observed during the scan (regardless of its `offerType`).
    // Apple's history for a valid, existing transaction should always include
    // that transaction's own lineage; never seeing it at all — even in a
    // FULLY exhausted (`hasMore === false`) history — is an inconsistent/
    // incomplete response, not proof the lineage carries no intro offer. See
    // the `hasMore === false` branch below.
    let sawRequestedLineage = false;
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
        // `getTransactionHistory` is CUSTOMER-WIDE — it returns EVERY
        // subscription the customer owns, not just the requested lineage. Scope
        // intro detection to the SPECIFIC subscription: only treat a decoded
        // transaction's intro `offerType` as consuming THIS OTID's
        // once-per-lifetime trial when that transaction belongs to the requested
        // `originalTransactionId`. Otherwise a rider who trialed OTID_old and now
        // buys a no-trial product under OTID_new would be falsely flagged as
        // reusing a trial and rejected (409) while still being charged.
        if (transaction.originalTransactionId === originalTransactionId) {
          sawRequestedLineage = true;
          if (transaction.offerType === OfferType.INTRODUCTORY_OFFER) {
            return true;
          }
        }
      }

      // History FULLY exhausted (`hasMore === false`) without finding an intro
      // for the requested OTID. This proves "no intro used" ONLY when the
      // requested lineage actually appeared somewhere in the scanned history —
      // if `sawRequestedLineage` is still false, the requested transaction's
      // OWN lineage never showed up at all, which is an anomaly (a valid
      // otid's history should include that otid), not proof of "no intro". Fail
      // CLOSED with the same retryable error as the other incomplete-history
      // cases rather than let an inconsistent response grant a second trial.
      if (response.hasMore === false) {
        if (!sawRequestedLineage) {
          throw new AppleStoreUnavailableError(
            'Apple transaction history did not include the requested transaction lineage',
          );
        }
        return false;
      }
      // `hasMore` OMITTED entirely (`undefined`) is NOT proof of completion —
      // `!undefined` is truthy, so the naive `!response.hasMore` check above
      // would treat a malformed page with `hasMore` missing as "no more
      // pages" and return `false`, potentially missing an intro offer on an
      // unfetched page. Only a STRICT `hasMore === false` proves exhaustion;
      // fail CLOSED with the same retryable error as the MAX_PAGES case.
      if (response.hasMore == null) {
        throw new AppleStoreUnavailableError(
          'Apple transaction history omitted "hasMore"; result incomplete',
        );
      }
      // Apple reports MORE pages (`hasMore === true`) but omitted the paging
      // `revision` token needed to fetch the next one. An intro transaction for
      // the requested OTID could still lie on that unfetched page, so this is
      // an INCOMPLETE search, not a "no intro used" answer — returning `false`
      // here would let an already-ineligible rider slip a second trial past an
      // Apple-side paging anomaly. Fail CLOSED with the same retryable error as
      // the MAX_PAGES case below.
      if (!response.revision) {
        throw new AppleStoreUnavailableError(
          'Apple transaction history reported more pages but omitted the paging revision; result incomplete',
        );
      }
      revision = response.revision;
    }

    // The loop reached MAX_PAGES while Apple STILL reports more pages
    // (`hasMore === true` with a `revision`) and no intro was found for the
    // requested OTID. The search is INCOMPLETE — the requested OTID's
    // introductory transaction could lie on an unfetched later page. Returning
    // `false` here would let validation treat an incomplete search as proof no
    // trial was used and grant an already-ineligible rider another trial. Fail
    // CLOSED with a retryable error instead (the caller maps it to a retryable
    // 503, same as a store outage, so nothing is under-reported).
    throw new AppleStoreUnavailableError(
      'Apple transaction history exceeded the page limit; result incomplete',
    );
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
    // + current-date expiry. IMPORTANT: keep this false — OCSP-responder
    // problems throw `VerificationStatus.FAILURE`, which `IapValidateService`
    // classifies as a TERMINAL receipt-content failure. With online checks on,
    // an OCSP outage (a deployment-wide/transient condition) would be
    // mis-mapped to a terminal 400 and strand every paying rider. Enabling
    // online checks therefore also requires reworking that terminal/retryable
    // classification (do not flip this flag without that change).
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
  if (isTerminalAppleApiError(err)) {
    return new AppleTerminalApiError(
      'Apple App Store Server API rejected the request',
      { cause: err },
    );
  }
  return new AppleStoreUnavailableError(
    'Apple App Store Server API is unavailable',
    { cause: err },
  );
}

/**
 * TERMINAL only when the failure is a documented `APIException` carrying a
 * TRANSACTION-IDENTITY-specific code (see {@link TERMINAL_API_ERRORS}). This is
 * a fail-SAFE INVERSION of the old "retryable whitelist, else terminal" model:
 * the default is now RETRYABLE, so an auth (401/403) failure — which may arrive
 * as an `APIException` with a null `apiError`, or with any non-whitelisted code
 * — an app-config error (`APP_NOT_FOUND`), a rate limit, a 5xx, and every
 * transport-level failure (no HTTP response at all) all classify RETRYABLE. A
 * deployment-wide credential/config problem can therefore never be mistaken for
 * a bad transaction and strand paying riders.
 */
function isTerminalAppleApiError(err: unknown): boolean {
  return (
    err instanceof APIException &&
    err.apiError != null &&
    TERMINAL_API_ERRORS.has(err.apiError)
  );
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

/** The later of two dates; `a` when `b` is null (or not strictly newer). */
function maxDate(a: Date, b: Date | null): Date {
  return b != null && b.getTime() > a.getTime() ? b : a;
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
