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
import { IAP_PRODUCTS, type SubscriptionTier } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import { AccountService } from './account.service.js';
import {
  APPLE_BILLING_CLIENT,
  AppleStoreUnavailableError,
  type AppleBillingClient,
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
 * Reverse lookup from a verified App Store product identifier to the tier it
 * grants. Built once from the canonical `IAP_PRODUCTS` map so the tier is
 * derived from the VERIFIED product only — the client's `productId` hint is
 * never trusted for entitlement.
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
 * A mobile client posts a signed transaction (JWS); this service verifies it,
 * binds it to the authenticated rider, derives the tier from the VERIFIED
 * product, re-queries Apple for the AUTHORITATIVE current subscription state,
 * atomically claims the rider's single (cross-provider-exclusive) subscription
 * slot, handles the once-per-rider free trial, and returns the subscription
 * snapshot.
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
    // 1. Verify the signed transaction. Any signature/x5c/bundleId/environment
    //    failure throws terminally here; an unconfigured client throws
    //    ServiceUnavailableException — both propagate untouched.
    const verified = await this.apple.verifyTransaction(dto.transaction);

    // 2. Account binding FIRST — no mutation before this passes. The
    //    `appAccountToken` is the rider-linking UUID the client set at
    //    purchase; a transaction bound to a different rider (or to none) is a
    //    409 and never touches the row.
    if (verified.appAccountToken !== userId) {
      throw new ConflictException({
        message:
          'This App Store purchase is not linked to your account and cannot be applied here.',
        retryable: false,
      });
    }

    // 3. Derive the tier from the VERIFIED product. The optional client
    //    `productId` hint is only ever cross-checked, never used to grant.
    const product = APPLE_PRODUCT_LOOKUP.get(verified.productId);
    if (!product) {
      throw new BadRequestException({
        message: `Unrecognized App Store product "${verified.productId}".`,
        retryable: false,
      });
    }
    if (dto.productId != null && dto.productId !== verified.productId) {
      throw new BadRequestException({
        message:
          'The reported product does not match the verified transaction.',
        retryable: false,
      });
    }
    const { tier } = product;

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Account not found.');
    }

    // 4. Trial eligibility — BEFORE any claim. A trial transaction from a rider
    //    who already consumed their once-per-lifetime trial is rejected and a
    //    reconciliation work item is opened for ops; no claim happens.
    const isGenuineFirstTrial =
      verified.isTrial && user.billing_trial_used_at == null;
    if (verified.isTrial && user.billing_trial_used_at != null) {
      await this.storeReconciliation.openConflict({
        provider: 'apple',
        appleOriginalTransactionId: verified.originalTransactionId,
        reason: 'ineligible_trial_rejected',
        userId,
      });
      throw new ConflictException({
        message:
          'Your free trial has already been used and cannot be granted again.',
        retryable: false,
      });
    }

    // 5. Authoritative current-state re-query. NEVER trust a client-supplied
    //    signed transaction for CURRENT state (it may be a stale renewal JWS) —
    //    ask Apple. A store outage here is retryable; a dead subscription is a
    //    terminal reject (we do not grant an expired/canceled subscription).
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
      throw err;
    }

    if (
      authoritative.status === 'expired' ||
      authoritative.status === 'canceled'
    ) {
      throw new BadRequestException({
        message: 'This subscription is no longer active and cannot be applied.',
        retryable: false,
      });
    }

    // Derive the claim fields from the AUTHORITATIVE status. A genuine eligible
    // trial is always recorded as `trialing`; otherwise the authoritative
    // status maps to itself ('active'|'trialing'|'past_due' — 'expired'/
    // 'canceled' were rejected above). Period end prefers Apple's authoritative
    // value, falling back to the verified transaction's; auto-renew off means
    // the subscription is set to cancel at period end.
    const claimStatus: 'active' | 'trialing' | 'past_due' = isGenuineFirstTrial
      ? 'trialing'
      : authoritative.status;
    const currentPeriodEnd = authoritative.expiresDate ?? verified.expiresDate;
    const cancelAtPeriodEnd = !authoritative.autoRenew;

    const claimResult = await this.providerClaim.claimForApple(
      userId,
      verified.originalTransactionId,
      {
        tier,
        status: claimStatus,
        currentPeriodEnd,
        cancelAtPeriodEnd,
      },
    );
    if (claimResult === 'conflict') {
      throw new ConflictException({
        message:
          'Your account already has an active subscription from another source.',
        retryable: false,
      });
    }

    // 6. Trial stamp — `claimForApple` cannot set `billing_trial_used_at`, so
    //    stamp it here with an identity- + IS-NULL-guarded UPDATE. The guard
    //    makes it idempotent and self-healing across re-validates: a second
    //    validate of the same trial is a no-op.
    if (isGenuineFirstTrial) {
      await this.userRepo
        .createQueryBuilder()
        .update(User)
        .set({ billing_trial_used_at: () => 'NOW()' })
        .where('id = :id', { id: userId })
        .andWhere("subscription_provider = 'apple'")
        .andWhere('apple_original_transaction_id = :otid', {
          otid: verified.originalTransactionId,
        })
        .andWhere('billing_trial_used_at IS NULL')
        .execute();
    }

    // 7. Return the freshly-claimed subscription snapshot (store path — the row
    //    is now Apple-owned, so `getSubscription` skips any live Stripe read).
    const snapshot = await this.accountService.getSubscription(userId);
    return { ...snapshot, retryable: false };
  }
}
