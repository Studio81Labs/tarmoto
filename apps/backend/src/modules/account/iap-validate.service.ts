import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
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
  type VerifiedAppleTransaction,
} from './apple-billing.client.js';
import { ProviderClaimService } from './provider-claim.service.js';
import { StoreReconciliationService } from './store-reconciliation.service.js';
import { IapValidateRequestDto } from './dto/iap-validate.dto.js';
import { IapValidateResponseDto } from './dto/iap-validate.dto.js';

type PaidTier = Exclude<SubscriptionTier, 'free'>;

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

    // Does the rider ALREADY own this exact Apple transaction? Used both to
    // treat an idempotent trial retry as a clean re-claim (below) and to
    // downgrade an owner who re-validates AFTER expiry/revocation (the terminal
    // branch), so a rider whose subscription has died can't keep paid access
    // just because the deferred notification lifecycle hasn't cleared the row.
    const alreadyOwnsThisTransaction =
      user.subscription_provider === 'apple' &&
      user.apple_original_transaction_id === verified.originalTransactionId;

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
      // branches consistently and may retry.
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
      // The transition is identity- AND period-guarded (`clearAppleTerminal`
      // only writes a row that is currently Apple-owned, holds this exact otid,
      // AND whose stored period is NOT newer than what THIS request observed) —
      // it sets subscription_tier='free', subscription_status='canceled',
      // subscription_cancel_at_period_end=false, clears subscription_provider /
      // plan_source, and RETAINS apple_original_transaction_id as a historical
      // store binding (per the terminal-semantics spec, so a later store-side
      // reactivation can still resolve the rider by OTID). Passing this
      // request's authoritative `expiresDate` lets a concurrent recovery that
      // already advanced the period win the race: if request B committed a newer
      // active period for the SAME otid, this stale terminal clear matches no
      // row and no-ops. A NON-owner submitting an expired transaction gets the
      // 400 with NO mutation (the guard matches no row).
      if (alreadyOwnsThisTransaction) {
        await this.providerClaim.clearAppleTerminal(
          userId,
          verified.originalTransactionId,
          authoritative.expiresDate,
        );
      }
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
      throw new BadRequestException({
        message: `Unrecognized App Store product "${authoritative.productId}".`,
        retryable: false,
      });
    }
    if (dto.productId != null && dto.productId !== authoritative.productId) {
      throw new BadRequestException({
        message:
          'The reported product does not match the current subscription.',
        retryable: false,
      });
    }
    const { tier } = product;

    // 6. Trial eligibility — BEFORE any claim, and driven by the AUTHORITATIVE
    //    trial signal. A trial transaction from a rider who already consumed
    //    their once-per-lifetime trial is rejected and a reconciliation work
    //    item is opened for ops — UNLESS the rider already owns this exact Apple
    //    transaction, in which case this is a normal idempotent retry (e.g. a
    //    lost first-validation response) and must fall through to a clean
    //    re-claim rather than reporting failure after entitlement was granted.
    const isGenuineFirstTrial =
      authoritative.isTrial && user.billing_trial_used_at == null;
    if (
      authoritative.isTrial &&
      user.billing_trial_used_at != null &&
      !alreadyOwnsThisTransaction
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

    // Trial-usage from HISTORY: the authoritative CURRENT transaction stops
    // carrying the introductory `offerType` once the intro period renews to
    // paid, so a subscription first validated/restored AFTER that renewal would
    // look trial-free and (once ended) re-qualify the rider for another trial.
    // Consult the transaction history to catch that case. Only queried when it
    // can change the outcome — skipped when the stamp is already set (the stamp
    // below is an IS-NULL-guarded no-op then) or the latest transaction is
    // already a trial — so we don't add an Apple round-trip to every validate. A
    // store outage here is retryable, and this runs BEFORE any mutation so an
    // outage never leaves a half-applied claim.
    let historyHasIntro = false;
    if (user.billing_trial_used_at == null && !authoritative.isTrial) {
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
        throw new ServiceUnavailableException({
          message:
            'The App Store returned an unexpected response. Please retry shortly.',
          retryable: true,
        });
      }
    }
    // Stamp the once-per-rider trial marker when a trial was used NOW or EVER.
    const usedIntroOffer = authoritative.isTrial || historyHasIntro;

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
    const currentPeriodEnd = authoritative.expiresDate ?? verified.expiresDate;
    const cancelAtPeriodEnd = !authoritative.autoRenew;

    const claimResult = await this.providerClaim.claimForApple(
      userId,
      verified.originalTransactionId,
      {
        tier: effectiveTier,
        status: claimStatus,
        currentPeriodEnd,
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

    // 7. Return the freshly-claimed subscription snapshot (store path — the row
    //    is now Apple-owned, so `getSubscription` skips any live Stripe read).
    const snapshot = await this.accountService.getSubscription(userId);
    return { ...snapshot, retryable: false };
  }
}
