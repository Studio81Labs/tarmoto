import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VerificationException } from '@apple/app-store-server-library';
import { IAP_PRODUCTS, type SubscriptionTier } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import { AccountService } from './account.service.js';
import {
  APPLE_BILLING_CLIENT,
  AppleStoreUnavailableError,
  AppleTerminalApiError,
  type AppleBillingClient,
  type AppleSubscriptionStatus,
  type VerifiedAppleTransaction,
} from './apple-billing.client.js';
import { ProviderClaimService } from './provider-claim.service.js';
import { StoreReconciliationService } from './store-reconciliation.service.js';
import { IapValidateRequestDto } from './dto/iap-validate.dto.js';
import { IapValidateResponseDto } from './dto/iap-validate.dto.js';

type PaidTier = Exclude<SubscriptionTier, 'free'>;

/**
 * ENTITLING (still-charging / will-keep-renewing) authoritative Apple statuses:
 * a subscription in one of these keeps billing the rider. Terminal statuses
 * (`expired` / `canceled`) are excluded — they no longer renew and are rejected
 * earlier in the flow.
 */
const ENTITLING_APPLE_STATUSES: ReadonlySet<AppleSubscriptionStatus> = new Set([
  'active',
  'trialing',
  'past_due',
  'billing_retry',
]);

/**
 * Persisted subscription statuses that still entitle the rider. A concurrent
 * recovery that wins the terminal-clear race commits one of these via
 * `claimForApple` (active / trialing, or past_due for grace/billing-retry);
 * only a terminal clear writes `canceled` (with `subscription_provider = null`).
 */
const ENTITLING_STORED_STATUSES: ReadonlySet<User['subscription_status']> =
  new Set<User['subscription_status']>(['active', 'trialing', 'past_due']);

/**
 * True when the CURRENT persisted row still entitles the rider via Apple — the
 * slot is Apple-owned AND the status is non-terminal. Used when a guarded
 * terminal clear loses to a concurrent recovery: the row this request re-reads
 * reflects the state that actually won, and if that state is entitling the
 * validate must succeed with it rather than falsely reject.
 */
function isEntitlingSnapshot(user: User): boolean {
  return (
    user.subscription_provider === 'apple' &&
    ENTITLING_STORED_STATUSES.has(user.subscription_status)
  );
}

interface AppleProduct {
  tier: PaidTier;
  isTrialProduct: boolean;
}

/**
 * Reverse lookup from an App Store product identifier to the tier it grants.
 * Built once from the canonical `IAP_PRODUCTS` map so the tier is derived from
 * the AUTHORITATIVE product Apple reports for the current transaction — never
 * from the (possibly stale) client-submitted JWS, and never from the client's
 * `productId` hint, which is only cross-checked.
 */
const APPLE_PRODUCT_LOOKUP: ReadonlyMap<string, AppleProduct> = (() => {
  const map = new Map<string, AppleProduct>();
  for (const tier of Object.keys(IAP_PRODUCTS) as PaidTier[]) {
    const { trial, noTrial } = IAP_PRODUCTS[tier].apple;
    map.set(trial, { tier, isTrialProduct: true });
    map.set(noTrial, { tier, isTrialProduct: false });
  }
  return map;
})();

/**
 * Server-side validation of a native Apple (StoreKit2) subscription purchase.
 *
 * A mobile client posts a signed transaction (JWS); this service verifies it
 * (used only to bind the rider via `appAccountToken` and to obtain the stable
 * `originalTransactionId`), re-queries Apple for the AUTHORITATIVE current
 * subscription state, derives the tier + trial signal from that authoritative
 * transaction, atomically claims the rider's single (cross-provider-exclusive)
 * subscription slot, handles the once-per-rider free trial, and returns the
 * subscription snapshot.
 */
@Injectable()
export class IapValidateService {
  private readonly logger = new Logger(IapValidateService.name);

  constructor(
    @Inject(APPLE_BILLING_CLIENT)
    private readonly apple: AppleBillingClient,
    private readonly providerClaim: ProviderClaimService,
    private readonly storeReconciliation: StoreReconciliationService,
    private readonly accountService: AccountService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async validate(
    userId: string,
    dto: IapValidateRequestDto,
  ): Promise<IapValidateResponseDto> {
    // 1. Verify the signed transaction. A signature/x5c/bundleId/environment
    //    failure raises a `VerificationException` — a TERMINAL condition (a
    //    forged/expired/mismatched receipt is never worth retrying), which we
    //    map to a 400 carrying `retryable:false`. The generic message never
    //    leaks the JWS or the underlying verification detail. Any other error
    //    (an unconfigured client, missing root certs, or a malformed verified
    //    payload) is an ops/store-side condition, not the client's fault — we
    //    surface it as RETRYABLE rather than a bare error with no `retryable`
    //    field, so the client branches consistently and may retry.
    let verified: VerifiedAppleTransaction;
    try {
      verified = await this.apple.verifyTransaction(dto.transaction);
    } catch (err) {
      if (err instanceof VerificationException) {
        throw new BadRequestException({
          message: 'Invalid App Store transaction.',
          retryable: false,
        });
      }
      // A non-`VerificationException` here is an ops/store-side condition (an
      // unconfigured client, missing/unreadable root certs, or a malformed
      // verified payload) rather than a bad client transaction, and it is
      // about to be converted into a generic retryable 503 — Nest does not log
      // the original cause of an `HttpException`, so without this the operator
      // has no signal whether it was config, certs, or decoding, and purchases
      // retry indefinitely. Log only the error name/message/stack (safe,
      // library-originated) — never the JWS, private key, or any secret.
      this.logger.error(
        'Apple transaction verification failed with a non-verification error',
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException({
        message:
          'The App Store is temporarily unavailable. Please retry shortly.',
        retryable: true,
      });
    }

    // 2. Account binding FIRST — no mutation before this passes. The
    //    `appAccountToken` is the rider-linking UUID the client set at
    //    purchase; it is STABLE across a subscription's transactions, so the
    //    submitted JWS is authoritative for binding even though it must NOT be
    //    trusted for the tier. A transaction bound to a different rider (or to
    //    none) is a 409 and never touches the row.
    if (verified.appAccountToken !== userId) {
      throw new ConflictException({
        message:
          'This App Store purchase is not linked to your account and cannot be applied here.',
        retryable: false,
      });
    }

    // 3. Load the user row.
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Account not found.');
    }

    // Provider-AGNOSTIC match for TRIAL purposes only: true whether the rider's
    // Apple ownership is currently ACTIVE (`subscription_provider === 'apple'`)
    // OR was RETAINED after a terminal clear (`clearAppleTerminal` sets
    // `subscription_provider = null` but keeps `apple_original_transaction_id`
    // as a historical binding). A rider REACTIVATING their own retained-OTID
    // subscription is not consuming a NEW trial — it's the same subscription
    // history rediscovers on the intro-offer lookup. The terminal branch no
    // longer relies on any pre-re-query ownership snapshot (Finding 1): it
    // rechecks ownership against a FRESH re-read after the guarded clear. Only
    // the trial history-skip and ineligible-trial guard below use this broader
    // predicate.
    // SECURITY: `apple_original_transaction_id` is unique per rider (DB unique
    // index), so a match here can only ever be the rider's OWN subscription —
    // never another rider's transaction.
    const matchesRetainedAppleTransaction =
      user.apple_original_transaction_id === verified.originalTransactionId;

    // 3b. OWNERSHIP-FIRST (design spec §74). The caller's account binding
    //     passed, but the verified original transaction id can still be
    //     RETAINED on ANOTHER rider's row — the `apple_original_transaction_id`
    //     unique index holds it for exactly one rider at a time. If it is, this
    //     is that other rider's purchase, and we must reject it with a
    //     MUTATION-FREE 409 BEFORE any product/tier or trial processing — i.e.
    //     before the unknown-product / ineligible-trial branches that would
    //     otherwise open a caller-associated reconciliation for a purchase that
    //     isn't the caller's, and before any terminal close-out that could act
    //     on the victim's subscription. `claimForApple`'s unique-index guard
    //     stays the final authority, but discovering the conflict here makes the
    //     ownership check ordering-correct (it precedes every reconciliation),
    //     matching the spec's ownership-first invariant. No reconciliation is
    //     opened, no clear/claim is issued.
    //
    //     Skipped when the caller ALREADY owns this OTID
    //     (`matchesRetainedAppleTransaction`): a unique OTID cannot
    //     simultaneously belong to another rider, so that is a normal idempotent
    //     re-validate / retained-OTID reactivation, not a cross-user conflict.
    if (!matchesRetainedAppleTransaction) {
      const otidOwner = await this.userRepo.findOne({
        where: {
          apple_original_transaction_id: verified.originalTransactionId,
        },
      });
      if (otidOwner != null && otidOwner.id !== userId) {
        throw new ConflictException({
          message:
            'This App Store purchase is already associated with another account.',
          retryable: false,
        });
      }
    }

    // 4. Authoritative current-state re-query. NEVER trust the client-submitted
    //    signed transaction for CURRENT state or entitlement: within a
    //    subscription group an OLD JWS keeps the same `originalTransactionId`
    //    after an upgrade/downgrade, so a stale premium JWS could otherwise
    //    overwrite a current pro subscription (or vice-versa). Ask Apple — the
    //    re-query's product/trial/status ARE the source of truth. A store outage
    //    (or a store-side verification anomaly for a valid otid) here is
    //    retryable; a dead subscription is a terminal reject (we do not grant an
    //    expired/canceled subscription).
    let authoritative: Awaited<
      ReturnType<AppleBillingClient['getSubscriptionStatus']>
    >;
    try {
      authoritative = await this.apple.getSubscriptionStatus(
        verified.originalTransactionId,
      );
    } catch (err) {
      if (err instanceof AppleStoreUnavailableError) {
        throw new ServiceUnavailableException({
          message:
            'The App Store is temporarily unavailable. Please retry shortly.',
          retryable: true,
        });
      }
      // A TERMINAL App Store API rejection (a documented non-retryable 4xx such
      // as INVALID_ORIGINAL_TRANSACTION_ID) will never succeed on retry, so map
      // it to a terminal 400 — never a retryable 503 that a contract-following
      // client would spin on forever. Apple's raw error detail is NOT leaked.
      if (err instanceof AppleTerminalApiError) {
        throw new BadRequestException({
          message: 'This App Store subscription could not be validated.',
          retryable: false,
        });
      }
      // Any other re-query failure (e.g. Apple returned an empty/unparseable
      // status, or the authoritative signedTransactionInfo failed verification)
      // is a genuinely-unknown store-side anomaly — safer to surface as
      // RETRYABLE than to strand a possibly-transient failure, so the client
      // branches consistently and may retry. Log the sanitized cause before
      // converting it to the generic 503 (same rationale as the
      // `verifyTransaction` catch above) — no secrets, only name/message/stack.
      this.logger.error(
        'Apple subscription status re-query failed with an unrecognized error',
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException({
        message:
          'The App Store returned an unexpected response. Please retry shortly.',
        retryable: true,
      });
    }

    if (
      authoritative.status === 'expired' ||
      authoritative.status === 'canceled'
    ) {
      // Owner re-validating a DEAD subscription (expired / canceled / REVOKED):
      // drop them to no paid access BEFORE the terminal 400. The tier-based
      // feature resolver reads the persisted `subscription_tier`, and the
      // store-notification lifecycle that would otherwise clear it is deferred,
      // so without this an owner keeps Pro/Premium indefinitely after expiry.
      // The transition is identity- AND signedDate-guarded (`clearAppleTerminal`
      // only writes a row that is currently Apple-owned, holds this exact otid,
      // AND whose stored signedDate is NOT newer than what THIS request
      // observed) —
      // it sets subscription_tier='free', subscription_status='canceled',
      // subscription_cancel_at_period_end=false, clears subscription_provider /
      // plan_source, and RETAINS apple_original_transaction_id as a historical
      // store binding (per the terminal-semantics spec, so a later store-side
      // reactivation can still resolve the rider by OTID). Passing this
      // request's authoritative `signedDate` lets a concurrent recovery that
      // already advanced the state win the race: if request B committed a newer
      // active state (a strictly-greater signedDate) for the SAME otid, this
      // stale terminal clear matches no row and no-ops. A NON-owner submitting an
      // expired transaction gets the 400 with NO mutation (the guard matches no
      // row).
      //
      // Finding 1: ALWAYS attempt the guarded clear — do NOT gate it on the
      // pre-re-query `alreadyOwnsThisTransaction` snapshot. That snapshot was
      // computed BEFORE the Apple re-query; if a concurrent OLDER active
      // validation claimed this OTID while we awaited Apple's newer
      // expired/revoked response, gating on the stale snapshot would SKIP the
      // clear and return a terminal 400, leaving the stale claim's paid access
      // persisted. The clear's identity + signedDate WHERE guards already make a
      // non-owner call a safe no-op (0 rows) and prevent a stale terminal
      // signedDate from regressing a newer committed state, so running it
      // unconditionally is safe — and it downgrades a just-claimed stale row via
      // this newer terminal signedDate.
      const cleared = await this.providerClaim.clearAppleTerminal(
        userId,
        verified.originalTransactionId,
        authoritative.signedDate,
      );
      if (cleared) {
        // The guarded clear APPLIED: we downgraded the current owner of this
        // OTID (identity + signedDate guards passed) — a genuine terminal state,
        // including the case where a concurrent OLDER active claim was cleared by
        // this newer terminal signedDate. Reject terminally.
        throw new BadRequestException({
          message:
            'This subscription is no longer active and cannot be applied.',
          retryable: false,
        });
      }
      // The clear affected NO row. Classify by the CURRENT DB state via a FRESH
      // re-read — never by the pre-re-query snapshot.
      const current = await this.userRepo.findOne({ where: { id: userId } });
      const ownsThisOtidNow =
        current != null &&
        (current.subscription_provider === 'apple' ||
          current.subscription_provider === null) &&
        current.apple_original_transaction_id ===
          verified.originalTransactionId;
      if (current != null && ownsThisOtidNow && isEntitlingSnapshot(current)) {
        // A concurrent NEWER recovery won the ordering guard and left the row
        // ENTITLING for this rider (Apple still owns it with a live, non-terminal
        // status) — the rider IS entitled via that newer active state. Return
        // that snapshot as an idempotent SUCCESS instead of a misleading terminal
        // 400 that would make a contract-following client cancel a subscription
        // that is in fact still entitled.
        //
        // Build the snapshot from THIS SAME `current` read rather than issuing a
        // fresh `getSubscription(userId)` re-read: a separate re-read would
        // reopen the exact TOCTOU window this branch exists to close — a newer
        // terminal clear could commit BETWEEN the entitling check above and a
        // second read, so the returned snapshot must reflect the row that was
        // actually checked, not whatever is current by the time of a later read.
        const winningSnapshot =
          await this.accountService.getSubscriptionSnapshotForUser(current);
        return { ...winningSnapshot, retryable: false };
      }
      // Otherwise: a genuine NON-owner submitted a terminal transaction (the
      // clear matched no row because the rider never owned this OTID), OR the row
      // is already terminal for this OTID. Both are terminal rejections — a
      // non-owner now correctly gets a terminal 400 rather than spinning on a
      // perpetual 503.
      throw new BadRequestException({
        message: 'This subscription is no longer active and cannot be applied.',
        retryable: false,
      });
    }

    // 5. Derive the tier from the AUTHORITATIVE product (Apple's CURRENT
    //    transaction), never the submitted JWS. The optional client `productId`
    //    hint is only ever cross-checked against the authoritative product,
    //    never used to grant.
    const product = APPLE_PRODUCT_LOOKUP.get(authoritative.productId);
    if (!product) {
      // When the authoritative subscription is ENTITLING (still charging) but
      // its product isn't in `IAP_PRODUCTS`, the rider keeps getting billed with
      // no entitlement and the backend can't cancel the Apple subscription — open
      // a durable, deduplicated reconciliation for ops BEFORE the terminal 400,
      // using the same `findOpen`-guard + race-safe `openConflict` pattern as the
      // ineligible-trial / exclusivity paths (the 1823 partial unique index makes
      // the insert race-safe for this reason too). A non-entitling unknown
      // product (expired/canceled) is already rejected above and never reaches
      // here, so it opens no reconciliation.
      if (ENTITLING_APPLE_STATUSES.has(authoritative.status)) {
        const openRows = await this.storeReconciliation.findOpen({
          userId,
          provider: 'apple',
          reason: 'unrecognized_product',
        });
        const alreadyOpen = openRows.some(
          (row) =>
            row.apple_original_transaction_id ===
            verified.originalTransactionId,
        );
        if (!alreadyOpen) {
          await this.storeReconciliation.openConflict({
            provider: 'apple',
            appleOriginalTransactionId: verified.originalTransactionId,
            reason: 'unrecognized_product',
            userId,
          });
        }
      }
      throw new BadRequestException({
        message: `Unrecognized App Store product "${authoritative.productId}".`,
        retryable: false,
      });
    }
    // The client-supplied `dto.productId` is ADVISORY ONLY: the tier is derived
    // solely from the AUTHORITATIVE product Apple reports for the current
    // transaction (`APPLE_PRODUCT_LOOKUP` above). A stale hint — e.g. during an
    // in-group upgrade the client hasn't observed yet — must NOT terminally
    // reject an otherwise-valid, still-renewing subscription (that would tell the
    // client not to retry while Apple keeps charging with no durable work item).
    // We proceed with the authoritative product and only log a debug note on
    // mismatch. No secrets are logged: product identifiers are public, never the
    // JWS/receipt. (The genuinely-unknown authoritative product is still rejected
    // above with a reconciliation — only the hint-vs-authoritative mismatch is
    // no longer a rejection.)
    if (dto.productId != null && dto.productId !== authoritative.productId) {
      this.logger.debug(
        `Ignoring advisory productId hint "${dto.productId}" that differs from the authoritative product "${authoritative.productId}".`,
      );
    }
    const { tier } = product;

    // 6. Trial eligibility — BEFORE any claim, driven by whether THIS submitted
    //    OTID has consumed an introductory offer. The authoritative CURRENT
    //    transaction stops carrying the introductory `offerType` once the intro
    //    period renews to paid, so a non-trial current transaction can still
    //    belong to a subscription whose HISTORY used a trial — which would
    //    otherwise re-qualify an already-trial-stamped rider for a second trial.
    //    Consult the transaction history to determine whether this OTID consumed
    //    an intro offer, UNLESS we already know the answer without it:
    //      - the current transaction IS a trial (→ this OTID used an intro), or
    //      - the rider's own OTID matches this transaction — whether currently
    //        ACTIVE (`subscription_provider === 'apple'`) OR RETAINED after a
    //        terminal clear (`subscription_provider === null`,
    //        `apple_original_transaction_id` still stamped) — via
    //        `matchesRetainedAppleTransaction`. Both are the same subscription
    //        the rider already had; reactivating it consumes no NEW trial, and
    //        rediscovering its history-intro must not be treated as one.
    //    Notably we do NOT skip merely because `billing_trial_used_at` is already
    //    set: an already-stamped rider submitting a NEW OTID whose intro has
    //    already renewed must still be caught. This adds one Apple
    //    `getTransactionHistory` round-trip to a non-trial, non-owned validate;
    //    validate is low-frequency, so that is acceptable. A store outage here is
    //    retryable, and this runs BEFORE any mutation so an outage never leaves a
    //    half-applied claim.
    let historyHasIntro = false;
    if (!authoritative.isTrial && !matchesRetainedAppleTransaction) {
      try {
        historyHasIntro = await this.apple.hasUsedIntroductoryOffer(
          verified.originalTransactionId,
        );
      } catch (err) {
        if (err instanceof AppleStoreUnavailableError) {
          throw new ServiceUnavailableException({
            message:
              'The App Store is temporarily unavailable. Please retry shortly.',
            retryable: true,
          });
        }
        // A terminal App Store API rejection here is likewise permanent — map
        // it to a terminal 400 rather than a retryable 503. Runs BEFORE any
        // mutation, so nothing is half-applied.
        if (err instanceof AppleTerminalApiError) {
          throw new BadRequestException({
            message: 'This App Store subscription could not be validated.',
            retryable: false,
          });
        }
        // Same rationale as the other swallowed-into-503 catches above: log the
        // sanitized cause (name/message/stack only, no JWS/secret) so operators
        // can tell config/cert/decoding failures apart from a genuine outage.
        this.logger.error(
          'Apple transaction history lookup failed with an unrecognized error',
          err instanceof Error ? err.stack : String(err),
        );
        throw new ServiceUnavailableException({
          message:
            'The App Store returned an unexpected response. Please retry shortly.',
          retryable: true,
        });
      }
    }
    // Whether THIS submitted OTID consumed an introductory offer (now or ever).
    const thisOtidUsedIntro = authoritative.isTrial || historyHasIntro;

    // An INELIGIBLE trial: this OTID used an intro offer, but the rider has
    // already consumed their once-per-lifetime trial — and it isn't the rider's
    // own subscription (currently active OR retained after a terminal clear, via
    // `matchesRetainedAppleTransaction`; that path is a normal idempotent retry —
    // e.g. a lost first-validation response, or a REACTIVATION of a retained-OTID
    // subscription — and must fall through to a clean re-claim rather than
    // reporting failure after entitlement was granted or already held). This now
    // fires even for an already-trial-stamped rider submitting a NEW OTID whose
    // intro period has already renewed to paid (current `isTrial=false`, but
    // history shows the intro). A reconciliation work item is opened for ops
    // before the 409.
    if (
      thisOtidUsedIntro &&
      user.billing_trial_used_at != null &&
      !matchesRetainedAppleTransaction
    ) {
      // Idempotent: a client retrying a rejected trial (same OTID) must not
      // accumulate duplicate `open` reconciliation rows. `findOpen` can't
      // filter by `appleOriginalTransactionId` directly, so narrow by
      // provider/reason/rider first and match the OTID in-service.
      const openRows = await this.storeReconciliation.findOpen({
        userId,
        provider: 'apple',
        reason: 'ineligible_trial_rejected',
      });
      const alreadyOpen = openRows.some(
        (row) =>
          row.apple_original_transaction_id === verified.originalTransactionId,
      );
      if (!alreadyOpen) {
        await this.storeReconciliation.openConflict({
          provider: 'apple',
          appleOriginalTransactionId: verified.originalTransactionId,
          reason: 'ineligible_trial_rejected',
          userId,
        });
      }
      throw new ConflictException({
        message:
          'Your free trial has already been used and cannot be granted again.',
        retryable: false,
      });
    }

    // A genuine FIRST trial: the CURRENT transaction is a trial and the rider
    // has never used one — recorded as `trialing` below. A history-derived intro
    // (current txn not a trial) means the subscription is now paid, so it keeps
    // the authoritative status rather than `trialing`.
    const isGenuineFirstTrial =
      authoritative.isTrial && user.billing_trial_used_at == null;
    // Stamp the once-per-rider trial marker when this OTID used a trial now or
    // ever (folded into the claim UPDATE below via COALESCE).
    const usedIntroOffer = thisOtidUsedIntro;

    // Derive the claim fields from the AUTHORITATIVE status. Entitlement follows
    // the tier-based feature resolver, so the EFFECTIVE tier — not just the
    // status — decides access:
    //  - `billing_retry` (Apple retrying a failed payment AFTER the grace period,
    //    so access has lapsed): drop to the FREE tier so the rider loses
    //    Pro/Premium, while `claimForApple` still stamps Apple ownership + the
    //    otid so a later successful renewal/webhook restores the paid tier. It is
    //    NOT terminal-rejected (unlike expired/canceled). Persisted as
    //    `past_due` at the claim layer (the column has no distinct retry value).
    //  - grace period (`past_due` here) keeps the PAID tier — Apple still grants
    //    access during grace, matching how the Stripe path treats `past_due`.
    //  - `active`/`trialing` keep the paid tier.
    // A genuine eligible trial is always recorded as `trialing`. Period end
    // prefers Apple's authoritative value, falling back to the verified
    // transaction's; auto-renew off means the subscription cancels at period end.
    const isBillingRetry = authoritative.status === 'billing_retry';
    const effectiveTier: SubscriptionTier = isBillingRetry ? 'free' : tier;
    const claimStatus: 'active' | 'trialing' | 'past_due' =
      authoritative.status === 'billing_retry'
        ? 'past_due'
        : isGenuineFirstTrial
          ? 'trialing'
          : authoritative.status;
    // `authoritative.expiresDate` ONLY — never fall back to `verified.expiresDate`
    // (the client-submitted JWS). `getSubscriptionStatus` already REQUIRES an
    // authoritative `expiresDate` for every entitling status (this branch is
    // only reached for one: expired/canceled already returned above), so a
    // client JWS fallback here could otherwise backfill a stale/older period
    // from a receipt that predates an in-group upgrade/downgrade.
    const currentPeriodEnd = authoritative.expiresDate;
    const cancelAtPeriodEnd = !authoritative.autoRenew;

    const claimResult = await this.providerClaim.claimForApple(
      userId,
      verified.originalTransactionId,
      {
        tier: effectiveTier,
        status: claimStatus,
        currentPeriodEnd,
        // The authoritative JWS signedDate is the monotonic ordering key of the
        // guarded claim — it both stamps `subscription_store_signed_date` and
        // gates branch B so an older Apple snapshot can't regress a newer one.
        signedDate: authoritative.signedDate,
        cancelAtPeriodEnd,
        // Fold the once-per-rider trial stamp into the SAME atomic UPDATE as the
        // claim: a separate post-claim stamp could fail and leave the rider
        // entitled while `billing_trial_used_at` stayed null — re-qualifying
        // them for another trial. `claimForApple` uses COALESCE so an already
        // set stamp is preserved (idempotent).
        markTrialUsed: usedIntroOffer,
      },
    );
    if (claimResult === 'conflict') {
      // The slot is owned by Stripe or a different Apple transaction. The
      // backend can't cancel the rider's recurring Apple subscription, so open a
      // durable, deduplicated reconciliation keyed by this otid before the 409 —
      // otherwise a rider being charged without entitlement leaves no trace for
      // ops. Same `findOpen`-guard shape as the ineligible-trial path.
      const openRows = await this.storeReconciliation.findOpen({
        userId,
        provider: 'apple',
        reason: 'exclusivity_conflict',
      });
      const alreadyOpen = openRows.some(
        (row) =>
          row.apple_original_transaction_id === verified.originalTransactionId,
      );
      if (!alreadyOpen) {
        await this.storeReconciliation.openConflict({
          provider: 'apple',
          appleOriginalTransactionId: verified.originalTransactionId,
          reason: 'exclusivity_conflict',
          userId,
        });
      }
      throw new ConflictException({
        message:
          'Your account already has an active subscription from another source.',
        retryable: false,
      });
    }

    // A `'stale'` result is a BENIGN monotonic no-op: the row is already
    // Apple-owned by THIS otid, but a concurrent, NEWER validation for the same
    // subscription already committed a later state, so this older snapshot's
    // guarded UPDATE matched no row. This is NOT an exclusivity conflict, but it
    // is NOT unconditionally an idempotent success either: the newer state that
    // won could itself be an ENTITLING recovery (active/trialing/past_due) OR a
    // newer TERMINAL clear (`clearAppleTerminal` sets `subscription_provider =
    // null`, tier -> free, status -> canceled). Blindly returning the snapshot
    // here would report SUCCESS to a contract-following client even though the
    // newer authoritative state TERMINATED the subscription. Re-read the current
    // row and mirror the SAME entitling check used by the clear-loss re-read
    // above: entitling -> idempotent success (open no reconciliation, no 409);
    // not entitling -> a RETRYABLE 503 so the client re-validates and observes
    // the authoritative terminal response instead of a misleading success.
    if (claimResult === 'stale') {
      return this.loadEntitlingSnapshotOrRetry(userId);
    }

    // 7. `'claimed'` success. Re-read the row ONCE and build the returned
    //    snapshot from THAT read, succeeding only if it is still entitling —
    //    never from an INDEPENDENT `getSubscription(userId)` read. Between this
    //    request claiming the row and a later independent read, a concurrent
    //    NEWER TERMINAL validation could clear the slot (`subscription_provider
    //    = null`, tier → free, status → canceled); a separate read would then
    //    hand a contract-following client a 201 with a free/canceled snapshot
    //    and `retryable:false`, finishing the transaction as validated on a
    //    terminal state. Routing through the SAME single-read helper as the
    //    `'stale'` and clear-loss paths keeps the entitling check and the
    //    returned snapshot on one read: entitling → success; a concurrent
    //    terminal clear that won → RETRYABLE 503 so the client re-validates and
    //    observes the authoritative terminal state. (The trial stamp is already
    //    committed inside the claim UPDATE, so it survives regardless.)
    return this.loadEntitlingSnapshotOrRetry(userId);
  }

  /**
   * Re-reads the caller's row ONCE and returns its subscription snapshot only
   * when that row is still ENTITLING via Apple (Apple-owned + a non-terminal
   * status). The entitling check and the returned snapshot therefore come from
   * the SAME read — closing the TOCTOU window a separate `getSubscription`
   * re-read would reopen, where a concurrent NEWER terminal clear landing
   * between the check and a later read could let a free/canceled snapshot be
   * returned as a success. When the row is missing or NON-entitling (a
   * concurrent terminal clear won the race), throw a RETRYABLE 503 so the
   * client re-validates and observes the authoritative terminal state instead
   * of a misleading success. Shared by the `'claimed'` and `'stale'` success
   * paths so both are consistent; the clear-loss branch already builds from its
   * own single read (its non-entitling outcome is a terminal 400, not a 503, so
   * it intentionally does not route through here).
   */
  private async loadEntitlingSnapshotOrRetry(
    userId: string,
  ): Promise<IapValidateResponseDto> {
    const current = await this.userRepo.findOne({ where: { id: userId } });
    if (!current || !isEntitlingSnapshot(current)) {
      throw new ServiceUnavailableException({
        message:
          'The App Store returned an unexpected response. Please retry shortly.',
        retryable: true,
      });
    }
    const snapshot =
      await this.accountService.getSubscriptionSnapshotForUser(current);
    return { ...snapshot, retryable: false };
  }
}
