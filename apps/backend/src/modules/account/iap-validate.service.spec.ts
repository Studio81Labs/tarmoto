import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';
import { IAP_PRODUCTS } from '@tarmoto/shared';
import { IapValidateService } from './iap-validate.service.js';
import {
  APPLE_BILLING_CLIENT,
  AppleStoreUnavailableError,
  AppleTerminalApiError,
  type AppleSubscriptionStatus,
  type VerifiedAppleTransaction,
} from './apple-billing.client.js';
import { ProviderClaimService } from './provider-claim.service.js';
import { StoreReconciliationService } from './store-reconciliation.service.js';
import { AccountService } from './account.service.js';
import { User } from '../../entities/user.entity.js';
import type { IapValidateRequestDto } from './dto/iap-validate.dto.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTID = 'apple-otid-abc';
const PRO_TRIAL = IAP_PRODUCTS.pro.apple.trial;
const PRO_NO_TRIAL = IAP_PRODUCTS.pro.apple.noTrial;
const PREMIUM_NO_TRIAL = IAP_PRODUCTS.premium.apple.noTrial;

function makeVerified(
  overrides: Partial<VerifiedAppleTransaction> = {},
): VerifiedAppleTransaction {
  return {
    originalTransactionId: OTID,
    transactionId: 'txn-1',
    productId: PRO_NO_TRIAL,
    appAccountToken: USER_ID,
    expiresDate: new Date('2027-01-01T00:00:00Z'),
    isTrial: false,
    bundleId: 'com.tarmoto.app',
    environment: 'Production',
    ...overrides,
  };
}

interface AuthoritativeStatus {
  status: AppleSubscriptionStatus;
  productId: string;
  isTrial: boolean;
  expiresDate: Date | null;
  signedDate: Date;
  autoRenew: boolean;
}

// The monotonic JWS signedDate the authoritative re-query stamps; threaded into
// both claimForApple (ordering key) and the terminal clear.
const SIGNED_DATE = new Date('2026-12-01T00:00:00Z');

// The AUTHORITATIVE re-query shape — the source of truth for product/trial as
// well as status/expiry/signedDate after Finding 1. Defaults to a current,
// active pro subscription; overrides model stale/upgraded/downgraded/trial
// states.
function makeStatus(
  overrides: Partial<AuthoritativeStatus> = {},
): AuthoritativeStatus {
  return {
    status: 'active',
    productId: PRO_NO_TRIAL,
    isTrial: false,
    expiresDate: new Date('2027-01-01T00:00:00Z'),
    signedDate: SIGNED_DATE,
    autoRenew: true,
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: USER_ID,
    billing_trial_used_at: null,
    subscription_provider: null,
    apple_original_transaction_id: null,
    subscription_tier: 'free',
    subscription_status: 'active',
    ...overrides,
  } as User;
}

const dto = (
  overrides: Partial<IapValidateRequestDto> = {},
): IapValidateRequestDto => ({
  provider: 'apple',
  transaction: 'signed-jws',
  ...overrides,
});

describe('IapValidateService', () => {
  let service: IapValidateService;
  let apple: {
    verifyTransaction: jest.Mock;
    getSubscriptionStatus: jest.Mock;
    hasUsedIntroductoryOffer: jest.Mock;
    isConfigured: jest.Mock;
  };
  let providerClaim: {
    claimForApple: jest.Mock;
    clearAppleTerminal: jest.Mock;
  };
  let storeReconciliation: { openConflict: jest.Mock; findOpen: jest.Mock };
  let accountService: { getSubscription: jest.Mock };
  let stampExecute: jest.Mock;
  let userRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };

  const snapshot = { provider: 'apple', tier: 'pro', status: 'active' };

  beforeEach(async () => {
    apple = {
      verifyTransaction: jest.fn(),
      getSubscriptionStatus: jest.fn().mockResolvedValue(makeStatus()),
      hasUsedIntroductoryOffer: jest.fn().mockResolvedValue(false),
      isConfigured: jest.fn().mockReturnValue(true),
    };
    providerClaim = {
      claimForApple: jest.fn().mockResolvedValue('claimed'),
      clearAppleTerminal: jest.fn().mockResolvedValue(true),
    };
    storeReconciliation = {
      openConflict: jest.fn().mockResolvedValue({}),
      findOpen: jest.fn().mockResolvedValue([]),
    };
    accountService = {
      getSubscription: jest.fn().mockResolvedValue(snapshot),
    };
    stampExecute = jest.fn().mockResolvedValue({ affected: 1 });
    const stampBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: stampExecute,
    };
    userRepo = {
      findOne: jest.fn().mockResolvedValue(makeUser()),
      createQueryBuilder: jest.fn().mockReturnValue(stampBuilder),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        IapValidateService,
        { provide: APPLE_BILLING_CLIENT, useValue: apple },
        { provide: ProviderClaimService, useValue: providerClaim },
        { provide: StoreReconciliationService, useValue: storeReconciliation },
        { provide: AccountService, useValue: accountService },
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();

    service = moduleRef.get(IapValidateService);
  });

  // JWS verification failure → terminal 400 (retryable:false), nothing downstream
  it('maps a VerificationException from verifyTransaction to a terminal 400 with retryable:false and does nothing downstream', async () => {
    apple.verifyTransaction.mockRejectedValue(
      new VerificationException(VerificationStatus.VERIFICATION_FAILURE),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      retryable: false,
    });
    // The generic client-facing message must not leak the JWS or underlying detail.
    expect(
      JSON.stringify((error as BadRequestException).getResponse()),
    ).not.toContain('signed-jws');
    expect(apple.getSubscriptionStatus).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // Unconfigured client / missing root certs (the ships-dark state) → retryable 503, nothing downstream
  it('maps a ServiceUnavailableException from verifyTransaction (unconfigured client) to a retryable 503 and does nothing downstream', async () => {
    apple.verifyTransaction.mockRejectedValue(
      new ServiceUnavailableException('Apple IAP is not configured'),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    expect(apple.getSubscriptionStatus).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // Malformed verified payload (e.g. `requireField` throws a plain Error) → retryable 503, nothing downstream
  it('maps a generic Error from verifyTransaction (malformed verified payload) to a retryable 503 and does nothing downstream', async () => {
    apple.verifyTransaction.mockRejectedValue(
      new Error('Apple transaction is missing the required field "productId"'),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    expect(apple.getSubscriptionStatus).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // Non-outage re-query anomaly (e.g. Apple returned empty/unparseable status,
  // or the authoritative signedTransactionInfo failed verification) → retryable 503
  it('maps a non-outage getSubscriptionStatus anomaly to a retryable 503', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockRejectedValue(
      new Error('No subscription status returned for original transaction'),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // (a) binding mismatch → 409, no claim, no re-query
  it('rejects with 409 when appAccountToken does not match the userId, without mutating', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ appAccountToken: 'someone-else' }),
    );

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(apple.getSubscriptionStatus).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  it('rejects with 409 when the transaction has no appAccountToken', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ appAccountToken: null }),
    );
    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // (b) unknown AUTHORITATIVE product → 400 (Finding 1: tier derives from the
  // re-query, so the unrecognized product comes from getSubscriptionStatus)
  it('rejects with 400 when the AUTHORITATIVE product is unrecognized', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ productId: 'com.tarmoto.unknown' }),
    );
    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 4: an ACTIVE (still-charging) subscription whose product isn't in
  // IAP_PRODUCTS keeps renewing with no entitlement, and Apple has no
  // server-side cancel — so a deduplicated unrecognized_product reconciliation
  // is opened for ops BEFORE the terminal 400.
  it('opens an unrecognized_product reconciliation for an ACTIVE unknown product, then throws 400', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', productId: 'com.tarmoto.unknown' }),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      retryable: false,
    });
    expect(storeReconciliation.findOpen).toHaveBeenCalledWith({
      userId: USER_ID,
      provider: 'apple',
      reason: 'unrecognized_product',
    });
    expect(storeReconciliation.openConflict).toHaveBeenCalledWith({
      provider: 'apple',
      appleOriginalTransactionId: OTID,
      reason: 'unrecognized_product',
      userId: USER_ID,
    });
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 4: repeated validations of the same active unknown product must not
  // double-open — the `findOpen` guard finds the already-open row.
  it('opens the unrecognized_product reconciliation only once across repeated rejections', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', productId: 'com.tarmoto.unknown' }),
    );
    storeReconciliation.findOpen
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          apple_original_transaction_id: OTID,
          provider: 'apple',
          reason: 'unrecognized_product',
        },
      ]);

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(storeReconciliation.findOpen).toHaveBeenCalledTimes(2);
    expect(storeReconciliation.openConflict).toHaveBeenCalledTimes(1);
  });

  // Finding 4: a NON-entitling (expired) unknown product is rejected by the
  // terminal branch BEFORE the product lookup, so it opens NO reconciliation.
  it('does not open a reconciliation for a non-entitling (expired) unknown product', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'expired',
        productId: 'com.tarmoto.unknown',
        expiresDate: new Date('2020-01-01T00:00:00Z'),
        autoRenew: false,
      }),
    );

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 1: entitlement follows Apple's authoritative CURRENT product, never
  // the submitted (possibly stale) JWS.
  it('derives the tier from the AUTHORITATIVE product, not the submitted stale JWS', async () => {
    // Submitted JWS is a stale PREMIUM transaction; Apple's current product is
    // pro — the claim must be pro.
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PREMIUM_NO_TRIAL }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ productId: PRO_NO_TRIAL }),
    );

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'pro' }),
    );
  });

  // Finding 3: the client's productId is ADVISORY ONLY. A stale hint that
  // differs from the AUTHORITATIVE product must NOT terminally reject a valid,
  // still-renewing subscription — the claim proceeds with the tier derived from
  // the authoritative product, ignoring the hint (never stranding an upgrade).
  it('ignores a productId hint that differs from the AUTHORITATIVE product and claims the authoritative tier', async () => {
    // The hint says premium, but Apple's authoritative product is pro — the
    // claim must be pro (hint ignored, not rejected).
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ productId: PRO_NO_TRIAL }),
    );

    const result = await service.validate(
      USER_ID,
      dto({ productId: PREMIUM_NO_TRIAL }),
    );

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'pro' }),
    );
    expect(result).toEqual({ ...snapshot, retryable: false });
  });

  it('accepts when the productId hint matches the AUTHORITATIVE product even if the submitted JWS differs', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PREMIUM_NO_TRIAL }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ productId: PRO_NO_TRIAL }),
    );

    await service.validate(USER_ID, dto({ productId: PRO_NO_TRIAL }));

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'pro' }),
    );
  });

  // (d) genuinely-new ineligible trial (no owning otid) → reject + reconciliation
  it('rejects an ineligible trial and opens an ineligible_trial_rejected reconciliation without claiming', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_TRIAL, isTrial: true }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({ billing_trial_used_at: new Date('2025-01-01T00:00:00Z') }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ productId: PRO_TRIAL, isTrial: true, status: 'trialing' }),
    );

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(storeReconciliation.openConflict).toHaveBeenCalledWith({
      provider: 'apple',
      appleOriginalTransactionId: OTID,
      reason: 'ineligible_trial_rejected',
      userId: USER_ID,
    });
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // (d2) idempotent re-validation of the same ineligible trial: the second
  // rejection finds the already-open row (via the mocked `findOpen`) and
  // must NOT open a second reconciliation, while both calls still 409.
  it('opens the ineligible-trial reconciliation only once across repeated rejections', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_TRIAL, isTrial: true }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({ billing_trial_used_at: new Date('2025-01-01T00:00:00Z') }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ productId: PRO_TRIAL, isTrial: true, status: 'trialing' }),
    );
    storeReconciliation.findOpen
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          apple_original_transaction_id: OTID,
          provider: 'apple',
          reason: 'ineligible_trial_rejected',
        },
      ]);

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(storeReconciliation.findOpen).toHaveBeenCalledTimes(2);
    expect(storeReconciliation.findOpen).toHaveBeenCalledWith({
      userId: USER_ID,
      provider: 'apple',
      reason: 'ineligible_trial_rejected',
    });
    expect(storeReconciliation.openConflict).toHaveBeenCalledTimes(1);
  });

  // Finding 2: an already-owned trial transaction retried after a lost response
  // must succeed idempotently — no 409, no reconciliation, and a clean re-claim.
  it('allows an idempotent retry of an already-owned trial transaction (snapshot, no 409, no reconciliation)', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_TRIAL, isTrial: true }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: 'apple',
        apple_original_transaction_id: OTID,
        subscription_tier: 'pro',
        billing_trial_used_at: new Date('2025-01-01T00:00:00Z'),
      }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ productId: PRO_TRIAL, isTrial: true, status: 'trialing' }),
    );

    const result = await service.validate(USER_ID, dto());

    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ...snapshot, retryable: false });
    // Trial was already stamped → not a genuine first trial → no new stamp.
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // (e) exclusivity conflict → 409
  it('rejects with 409 when claimForApple reports a conflict (another provider/otid owns the slot)', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'active',
        expiresDate: new Date('2027-01-01T00:00:00Z'),
        autoRenew: true,
      }),
    );
    providerClaim.claimForApple.mockResolvedValue('conflict');

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(accountService.getSubscription).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // Finding 1 (round 12): a 'stale' claim result is a BENIGN monotonic no-op —
  // a concurrent NEWER validation for the same otid already committed. When
  // the row this request re-reads is still ENTITLING (a concurrent ACTIVE
  // recovery won the race), the rider IS entitled via that concurrent claim,
  // so this must be an idempotent SUCCESS: return the current snapshot, open
  // NO reconciliation, and do NOT 409/503.
  it('treats a "stale" claim result as an idempotent success when the current row is still entitling (snapshot, no 409, no reconciliation)', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('stale');
    // First findOne: the initial user load (step 3). Second findOne: the
    // stale-result re-read, showing a concurrent ACTIVE recovery won.
    userRepo.findOne.mockResolvedValueOnce(makeUser()).mockResolvedValueOnce(
      makeUser({
        subscription_provider: 'apple',
        apple_original_transaction_id: OTID,
        subscription_tier: 'pro',
        subscription_status: 'active',
      }),
    );

    const result = await service.validate(USER_ID, dto());

    expect(result).toEqual({ ...snapshot, retryable: false });
    expect(result.provider).toBe('apple');
    expect(result.retryable).toBe(false);
    expect(accountService.getSubscription).toHaveBeenCalledWith(USER_ID);
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(storeReconciliation.findOpen).not.toHaveBeenCalled();
  });

  // Finding 1 (round 12): a 'stale' claim result whose current row was won by
  // a NEWER TERMINAL clear (subscription_provider cleared to null, tier free,
  // status canceled) must NOT be reported as success — the newer authoritative
  // state TERMINATED the subscription. Mirrors the clear-loss re-read exactly:
  // not entitling -> a RETRYABLE 503 so the client re-validates and observes
  // the authoritative terminal response, instead of a misleading success.
  it('returns a retryable 503 for a "stale" claim result whose current row was won by a newer terminal clear', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('stale');
    userRepo.findOne.mockResolvedValueOnce(makeUser()).mockResolvedValueOnce(
      makeUser({
        subscription_provider: null,
        apple_original_transaction_id: OTID,
        subscription_tier: 'free',
        subscription_status: 'canceled',
      }),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    expect(accountService.getSubscription).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(storeReconciliation.findOpen).not.toHaveBeenCalled();
  });

  // (f) happy path → claim with derived tier+status, snapshot returned
  it('claims with the derived tier and authoritative status and returns the snapshot', async () => {
    const expires = new Date('2027-06-01T00:00:00Z');
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'active',
        productId: PRO_NO_TRIAL,
        expiresDate: expires,
        autoRenew: true,
      }),
    );

    const result = await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(USER_ID, OTID, {
      tier: 'pro',
      status: 'active',
      currentPeriodEnd: expires,
      signedDate: SIGNED_DATE,
      cancelAtPeriodEnd: false,
      markTrialUsed: false,
    });
    expect(accountService.getSubscription).toHaveBeenCalledWith(USER_ID);
    expect(result).toEqual({ ...snapshot, retryable: false });
    expect(result.provider).toBe('apple');
    expect(result.retryable).toBe(false);
    expect(stampExecute).not.toHaveBeenCalled();
  });

  it('maps autoRenew=false to cancelAtPeriodEnd=true and prefers the authoritative expiry', async () => {
    const authoritativeExpiry = new Date('2028-01-01T00:00:00Z');
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ expiresDate: new Date('2027-01-01T00:00:00Z') }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'past_due',
        expiresDate: authoritativeExpiry,
        autoRenew: false,
      }),
    );

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(USER_ID, OTID, {
      tier: 'pro',
      status: 'past_due',
      currentPeriodEnd: authoritativeExpiry,
      signedDate: SIGNED_DATE,
      cancelAtPeriodEnd: true,
      markTrialUsed: false,
    });
  });

  it('falls back to the verified expiry when Apple returns no authoritative expiry', async () => {
    const verifiedExpiry = new Date('2027-03-01T00:00:00Z');
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ expiresDate: verifiedExpiry }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', expiresDate: null, autoRenew: true }),
    );

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ currentPeriodEnd: verifiedExpiry }),
    );
  });

  // (g) idempotent re-validate of the owning otid → snapshot, no duplicate side effects
  it('is idempotent on re-validate of an already-owned otid (single claim, no reconciliation, no stamp)', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified({ isTrial: false }));
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: 'apple',
        apple_original_transaction_id: OTID,
        subscription_tier: 'pro',
        billing_trial_used_at: new Date('2025-01-01T00:00:00Z'),
      }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', isTrial: false }),
    );

    const result = await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledTimes(1);
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
    expect(result.retryable).toBe(false);
  });

  // (h) store re-query outage → retryable 5xx / retryable:true
  it('translates an AppleStoreUnavailableError re-query outage to a retryable 503', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockRejectedValue(
      new AppleStoreUnavailableError('down'),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 2: an UNKNOWN Apple status (mapSubscriptionStatus's default branch
  // now throws AppleStoreUnavailableError instead of silently returning
  // 'expired') must surface here as a retryable 503 — and, critically, an
  // existing owner must NOT be downgraded: neither `clearAppleTerminal` nor
  // `claimForApple` runs, so the row (and the rider's entitlement) is
  // untouched pending a retry.
  it('maps an unknown Apple status (AppleStoreUnavailableError from the re-query) to a retryable 503 without downgrading an owner', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: 'apple',
        apple_original_transaction_id: OTID,
        subscription_tier: 'pro',
        subscription_status: 'active',
      }),
    );
    apple.getSubscriptionStatus.mockRejectedValue(
      new AppleStoreUnavailableError(
        'Unrecognized Apple subscription status: 999',
      ),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    expect(providerClaim.clearAppleTerminal).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // genuine first trial → claim status 'trialing' + trial stamp UPDATE issued
  it('grants a genuine first trial: claims status trialing and stamps billing_trial_used_at', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_TRIAL, isTrial: true }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({ billing_trial_used_at: null }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'trialing',
        productId: PRO_TRIAL,
        isTrial: true,
        expiresDate: new Date('2027-01-15T00:00:00Z'),
      }),
    );

    await service.validate(USER_ID, dto());

    // Finding 3: the trial stamp is folded into the SAME claim UPDATE via
    // markTrialUsed — no separate post-claim stamp write.
    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({
        tier: 'pro',
        status: 'trialing',
        markTrialUsed: true,
      }),
    );
    expect(stampExecute).not.toHaveBeenCalled();
  });

  it('overrides an ACTIVE authoritative status to trialing for a genuine first trial', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_TRIAL, isTrial: true }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({ billing_trial_used_at: null }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'active',
        productId: PRO_TRIAL,
        isTrial: true,
        expiresDate: new Date('2027-01-15T00:00:00Z'),
      }),
    );

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ status: 'trialing' }),
    );
  });

  // Finding 1: Apple reports expired/canceled for a NON-owner → terminal reject,
  // no claim. The guarded clear is now ALWAYS attempted (a safe no-op for a
  // non-owner: 0 rows), and the fresh re-read confirms the rider doesn't own
  // this otid → terminal 400.
  it('rejects terminally with 400 for a non-owner submitting an expired transaction (guarded clear is a safe no-op)', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    // Genuine non-owner: the guarded clear matches no row.
    providerClaim.clearAppleTerminal.mockResolvedValue(false);
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'expired',
        expiresDate: new Date('2020-01-01T00:00:00Z'),
        autoRenew: false,
      }),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      retryable: false,
    });
    // Finding 1: the clear is ALWAYS attempted (unconditional), not gated on the
    // stale pre-re-query ownership snapshot.
    expect(providerClaim.clearAppleTerminal).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      SIGNED_DATE,
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  it('rejects terminally with 400 for a non-owner submitting a canceled (REVOKED) transaction', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    providerClaim.clearAppleTerminal.mockResolvedValue(false);
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'canceled', expiresDate: null, autoRenew: false }),
    );

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(providerClaim.clearAppleTerminal).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      SIGNED_DATE,
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 1: an OWNER re-validating a DEAD subscription (expired) is dropped
  // to no paid access via the identity-guarded terminal transition BEFORE the
  // terminal 400, so a deferred notification lifecycle can't leave them with
  // Pro/Premium after expiry.
  it('drops an owner to no paid access via clearAppleTerminal, then throws 400, when Apple reports expired', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: 'apple',
        apple_original_transaction_id: OTID,
        subscription_tier: 'pro',
      }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'expired',
        expiresDate: new Date('2020-01-01T00:00:00Z'),
        signedDate: SIGNED_DATE,
        autoRenew: false,
      }),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      retryable: false,
    });
    // Finding 1: the authoritative observed signedDate is threaded through so the
    // guarded clear can reject a stale write.
    expect(providerClaim.clearAppleTerminal).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      SIGNED_DATE,
    );
    // Still terminal — no claim/grant.
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 1: REVOKED (refund/family-removal) maps to `canceled`; an owner is
  // likewise dropped before the 400.
  it('drops an owner to no paid access via clearAppleTerminal, then throws 400, when Apple reports canceled (REVOKED)', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: 'apple',
        apple_original_transaction_id: OTID,
        subscription_tier: 'premium',
      }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'canceled',
        expiresDate: null,
        signedDate: SIGNED_DATE,
        autoRenew: false,
      }),
    );

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Finding 1: canceled/REVOKED carries no expiry, but the authoritative
    // signedDate is always present and is threaded through as the ordering key
    // for the guarded clear.
    expect(providerClaim.clearAppleTerminal).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      SIGNED_DATE,
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 1: an owner of a DIFFERENT otid submitting an expired transaction is
  // NOT dropped — the guarded clear is attempted but the identity guard means it
  // matches no row (→ false), and the fresh re-read still owns a different otid,
  // so it is a terminal 400 (no downgrade of the unrelated subscription).
  it('does not downgrade the owned subscription when the expired transaction is a different otid, and still 400s', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    // Identity guard: the row owns a DIFFERENT otid, so the clear no-ops.
    providerClaim.clearAppleTerminal.mockResolvedValue(false);
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: 'apple',
        apple_original_transaction_id: 'a-different-otid',
        subscription_tier: 'pro',
      }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'expired', autoRenew: false }),
    );

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(providerClaim.clearAppleTerminal).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      SIGNED_DATE,
    );
    // Fresh re-read still owns a-different-otid → not this otid → no success.
    expect(accountService.getSubscription).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 1 (case a): the INITIAL read showed the row UNOWNED, but a concurrent
  // OLDER active validation then claimed this OTID. Because the clear is now
  // attempted UNCONDITIONALLY (not gated on the stale pre-re-query snapshot),
  // this newer terminal signedDate clears that just-claimed stale row
  // (clearAppleTerminal → true), downgrading the stale claim's paid access — then
  // validate throws the terminal 400.
  it('downgrades a concurrently-claimed stale row (clear → true) even when the initial read was unowned, then 400s', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    // Initial read: unowned (the concurrent older claim lands AFTER this read).
    userRepo.findOne.mockResolvedValue(makeUser());
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'expired',
        expiresDate: new Date('2020-01-01T00:00:00Z'),
        autoRenew: false,
      }),
    );
    // The guarded clear APPLIES: the newer terminal signedDate clears the row a
    // concurrent older active validation had claimed for this OTID.
    providerClaim.clearAppleTerminal.mockResolvedValue(true);

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      retryable: false,
    });
    expect(providerClaim.clearAppleTerminal).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      SIGNED_DATE,
    );
    // clear → true short-circuits to the 400 with no re-read/no success path.
    expect(accountService.getSubscription).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 2: an owner's expired validation OVERLAPS a concurrent NEWER
  // recovery. The guarded clear affects no row (clearAppleTerminal → false)
  // because the recovery committed a strictly-greater signedDate; the re-read
  // shows the row is now ENTITLING for this rider (Apple-owned, active). The
  // rider IS entitled via the winning state, so validate returns that snapshot
  // as SUCCESS — NOT a terminal 400 that would make the client cancel a live sub.
  it('returns the winning entitling snapshot (no 400) when a guarded terminal clear loses to a concurrent recovery', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    // First findOne: the owner row (drives alreadyOwnsThisTransaction). Second
    // findOne (the clear-loss re-read): the row a concurrent recovery advanced.
    userRepo.findOne
      .mockResolvedValueOnce(
        makeUser({
          subscription_provider: 'apple',
          apple_original_transaction_id: OTID,
          subscription_tier: 'pro',
        }),
      )
      .mockResolvedValueOnce(
        makeUser({
          subscription_provider: 'apple',
          apple_original_transaction_id: OTID,
          subscription_tier: 'pro',
          subscription_status: 'active',
        }),
      );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'expired',
        expiresDate: new Date('2020-01-01T00:00:00Z'),
        autoRenew: false,
      }),
    );
    providerClaim.clearAppleTerminal.mockResolvedValue(false);

    const result = await service.validate(USER_ID, dto());

    expect(providerClaim.clearAppleTerminal).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      SIGNED_DATE,
    );
    expect(result).toEqual({ ...snapshot, retryable: false });
    expect(accountService.getSubscription).toHaveBeenCalledWith(USER_ID);
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 2: a genuine owner-expiry — the guarded clear APPLIES
  // (clearAppleTerminal → true) — keeps the terminal 400. (No re-read needed.)
  it('keeps the terminal 400 when the guarded clear applies (clearAppleTerminal → true)', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: 'apple',
        apple_original_transaction_id: OTID,
        subscription_tier: 'pro',
      }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'expired',
        expiresDate: new Date('2020-01-01T00:00:00Z'),
        autoRenew: false,
      }),
    );
    providerClaim.clearAppleTerminal.mockResolvedValue(true);

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      retryable: false,
    });
    expect(accountService.getSubscription).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 1 (case c): the guarded clear loses (→ false) and the FRESH re-read
  // shows a genuine non-owner (the row does not own this otid). This is a
  // terminal reject — a 400 (NOT the old perpetual-503, NOT a success) — because
  // a non-owner submitting a terminal transaction should be told, terminally,
  // that it cannot be applied.
  it('rejects terminally with 400 when the guarded clear loses and the fresh row is a genuine non-owner', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    userRepo.findOne
      .mockResolvedValueOnce(
        makeUser({
          subscription_provider: 'apple',
          apple_original_transaction_id: OTID,
          subscription_tier: 'pro',
        }),
      )
      .mockResolvedValueOnce(
        // Fresh re-read: a genuine non-owner (no apple otid on the row).
        makeUser({
          subscription_provider: null,
          apple_original_transaction_id: null,
          subscription_tier: 'free',
          subscription_status: 'canceled',
        }),
      );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'expired',
        expiresDate: new Date('2020-01-01T00:00:00Z'),
        autoRenew: false,
      }),
    );
    providerClaim.clearAppleTerminal.mockResolvedValue(false);

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      retryable: false,
    });
    expect(accountService.getSubscription).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 2: a TERMINAL App Store API rejection from the re-query (e.g.
  // INVALID_ORIGINAL_TRANSACTION_ID) is mapped to a terminal 400 (retryable:
  // false) — NOT the retryable 503 a contract-following client would spin on.
  it('maps a terminal AppleTerminalApiError from getSubscriptionStatus to a 400 retryable:false', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockRejectedValue(
      new AppleTerminalApiError('rejected'),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      retryable: false,
    });
    // The generic message must not leak Apple's raw error detail.
    expect(
      JSON.stringify((error as BadRequestException).getResponse()),
    ).not.toContain('rejected');
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 2: a terminal API rejection from the history lookup is likewise a
  // 400 retryable:false, and runs before any mutation.
  it('maps a terminal AppleTerminalApiError from the history lookup to a 400 retryable:false', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({ billing_trial_used_at: null }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', productId: PRO_NO_TRIAL, isTrial: false }),
    );
    apple.hasUsedIntroductoryOffer.mockRejectedValue(
      new AppleTerminalApiError('rejected'),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      retryable: false,
    });
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 1: BILLING_RETRY (no grace) → drop to the FREE tier so the
  // tier-based feature resolver denies Pro/Premium, while Apple ownership + the
  // otid are retained for a later renewal. Not terminal-rejected. Persisted as
  // past_due at the claim layer.
  it('claims with tier "free" (retaining Apple ownership) when Apple reports billing_retry', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'billing_retry',
        productId: PRO_NO_TRIAL,
        expiresDate: new Date('2027-01-01T00:00:00Z'),
        autoRenew: true,
      }),
    );

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'free', status: 'past_due' }),
    );
  });

  // Finding 1: BILLING_GRACE_PERIOD (still entitled) → keep the PAID tier +
  // past_due, matching how the Stripe path treats past_due.
  it('claims with the PAID tier and past_due when Apple reports the grace period', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'past_due',
        productId: PRO_NO_TRIAL,
        expiresDate: new Date('2027-01-01T00:00:00Z'),
        autoRenew: true,
      }),
    );

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'pro', status: 'past_due' }),
    );
  });

  // Finding 2: an exclusivity conflict opens a deduplicated
  // `exclusivity_conflict` reconciliation before the 409 so ops can find a rider
  // charged without entitlement.
  it('opens an exclusivity_conflict reconciliation and still throws 409 when claimForApple conflicts', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('conflict');

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(storeReconciliation.findOpen).toHaveBeenCalledWith({
      userId: USER_ID,
      provider: 'apple',
      reason: 'exclusivity_conflict',
    });
    expect(storeReconciliation.openConflict).toHaveBeenCalledWith({
      provider: 'apple',
      appleOriginalTransactionId: OTID,
      reason: 'exclusivity_conflict',
      userId: USER_ID,
    });
    expect(accountService.getSubscription).not.toHaveBeenCalled();
  });

  it('opens the exclusivity_conflict reconciliation only once across repeated conflicts', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('conflict');
    storeReconciliation.findOpen
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          apple_original_transaction_id: OTID,
          provider: 'apple',
          reason: 'exclusivity_conflict',
        },
      ]);

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(storeReconciliation.findOpen).toHaveBeenCalledTimes(2);
    expect(storeReconciliation.openConflict).toHaveBeenCalledTimes(1);
  });

  // Finding 4: latest authoritative transaction is not a trial, but the
  // subscription's HISTORY shows a prior introductory offer → stamp the trial
  // marker anyway (the intro period already renewed to paid).
  it('stamps billing_trial_used_at from transaction history when the latest transaction is not a trial', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({ billing_trial_used_at: null }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', productId: PRO_NO_TRIAL, isTrial: false }),
    );
    apple.hasUsedIntroductoryOffer.mockResolvedValue(true);

    await service.validate(USER_ID, dto());

    expect(apple.hasUsedIntroductoryOffer).toHaveBeenCalledWith(OTID);
    // Finding 3: history-derived trial usage is stamped atomically inside the
    // claim UPDATE (markTrialUsed), not via a separate stamp write.
    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ markTrialUsed: true }),
    );
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // Finding 2 (skip-optimization): the history lookup is skipped when the rider
  // ALREADY OWNS this exact transaction — an idempotent re-validate of the sub
  // they hold consumes no new trial, so no Apple round-trip is needed. (Note:
  // being already trial-stamped alone no longer skips history; see the next test.)
  it('skips the transaction-history lookup when the rider already owns this transaction', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: 'apple',
        apple_original_transaction_id: OTID,
        subscription_tier: 'pro',
        billing_trial_used_at: new Date('2025-01-01T00:00:00Z'),
      }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', productId: PRO_NO_TRIAL, isTrial: false }),
    );

    await service.validate(USER_ID, dto());

    expect(apple.hasUsedIntroductoryOffer).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // Finding 2 — THE FIX: an already-trial-stamped rider submits a NEW otid whose
  // introductory period has ALREADY renewed to paid (current isTrial=false), so
  // the previous skip-when-stamped optimization would have suppressed the history
  // lookup and CLAIMED the purchase. Now history is consulted (not already-owned,
  // not currently a trial), reveals the intro offer, and the ineligible-trial
  // rejection fires: 409 + deduped ineligible_trial_rejected reconciliation, no
  // claim.
  it('rejects an ineligible renewed trial for an already-stamped rider submitting a NEW otid (history reveals the intro)', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    // Already trial-stamped, and does NOT own this transaction (free slot).
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: null,
        apple_original_transaction_id: null,
        billing_trial_used_at: new Date('2025-01-01T00:00:00Z'),
      }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', productId: PRO_NO_TRIAL, isTrial: false }),
    );
    // The current transaction isn't a trial, but the subscription's HISTORY used
    // an introductory offer (it already renewed to paid).
    apple.hasUsedIntroductoryOffer.mockResolvedValue(true);

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(apple.hasUsedIntroductoryOffer).toHaveBeenCalledWith(OTID);
    expect(storeReconciliation.openConflict).toHaveBeenCalledWith({
      provider: 'apple',
      appleOriginalTransactionId: OTID,
      reason: 'ineligible_trial_rejected',
      userId: USER_ID,
    });
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // Finding 1 (round 7): a RETAINED OTID reactivation must be recognized as the
  // rider's OWN subscription for TRIAL purposes even though `clearAppleTerminal`
  // cleared `subscription_provider` to null. Without `matchesRetainedAppleTransaction`,
  // `alreadyOwnsThisTransaction` is false here (provider is null, not 'apple'),
  // so the OLD code would consult history, rediscover the intro offer, and —
  // because `billing_trial_used_at` is already stamped — wrongly 409 with
  // `ineligible_trial_rejected` instead of letting the rider reclaim their own
  // now-active subscription. The fix must skip history entirely (this is the
  // rider's own retained OTID) and fall through to `claimForApple`.
  it('reactivates a retained-OTID trial subscription without a 409 (history not consulted, claim proceeds)', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    // TERMINAL row that RETAINED this OTID: provider cleared to null, but the
    // OTID and the trial stamp are still present.
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: null,
        apple_original_transaction_id: OTID,
        subscription_tier: 'free',
        subscription_status: 'canceled',
        billing_trial_used_at: new Date('2025-01-01T00:00:00Z'),
      }),
    );
    // Reactivation: Apple's authoritative re-query now reports the SAME OTID
    // active again.
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', productId: PRO_NO_TRIAL, isTrial: false }),
    );

    const result = await service.validate(USER_ID, dto());

    expect(apple.hasUsedIntroductoryOffer).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'pro', status: 'active' }),
    );
    expect(result).toEqual({ ...snapshot, retryable: false });
  });

  // Same reactivation, but the authoritative re-query still carries the
  // intro-offer signal (isTrial=true) — the skip must also fire via
  // `authoritative.isTrial` OR `matchesRetainedAppleTransaction`; either way,
  // no 409 and the claim proceeds (recorded as `trialing`, not a NEW trial
  // stamp since `billing_trial_used_at` is already set and COALESCE preserves it).
  it('reactivates a retained-OTID subscription that is still intro-renewed without a 409', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_TRIAL, isTrial: true }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: null,
        apple_original_transaction_id: OTID,
        subscription_tier: 'free',
        subscription_status: 'canceled',
        billing_trial_used_at: new Date('2025-01-01T00:00:00Z'),
      }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'trialing', productId: PRO_TRIAL, isTrial: true }),
    );

    const result = await service.validate(USER_ID, dto());

    expect(apple.hasUsedIntroductoryOffer).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      // Not a genuine FIRST trial (billing_trial_used_at already set), so the
      // claim status is the authoritative status, not forced to 'trialing'
      // via isGenuineFirstTrial — but COALESCE means markTrialUsed=true is
      // harmless (preserves the existing stamp).
      expect.objectContaining({ markTrialUsed: true }),
    );
    expect(result).toEqual({ ...snapshot, retryable: false });
  });

  // Round-6 regression guard: an already-stamped rider submitting a DIFFERENT
  // NEW trial OTID (NOT the retained one) must still 409 + reconciliation —
  // `matchesRetainedAppleTransaction` must not broaden eligibility beyond the
  // rider's own OTID. (This otid differs from the user's retained OTID.)
  it('still rejects a DIFFERENT new trial OTID for an already-stamped rider holding an unrelated retained OTID', async () => {
    const DIFFERENT_OTID = 'apple-otid-different';
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({
        originalTransactionId: DIFFERENT_OTID,
        productId: PRO_TRIAL,
        isTrial: true,
      }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({
        subscription_provider: null,
        apple_original_transaction_id: OTID, // a DIFFERENT, retained OTID
        billing_trial_used_at: new Date('2025-01-01T00:00:00Z'),
      }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'trialing', productId: PRO_TRIAL, isTrial: true }),
    );

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(storeReconciliation.openConflict).toHaveBeenCalledWith({
      provider: 'apple',
      appleOriginalTransactionId: DIFFERENT_OTID,
      reason: 'ineligible_trial_rejected',
      userId: USER_ID,
    });
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 2: a non-trial NEW otid with NO history intro claims normally — the
  // history lookup runs (not owned, not a trial) but reveals no intro, so no
  // rejection and no trial stamp.
  it('claims normally for a non-trial NEW otid whose history shows no introductory offer', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({ billing_trial_used_at: new Date('2025-01-01T00:00:00Z') }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', productId: PRO_NO_TRIAL, isTrial: false }),
    );
    apple.hasUsedIntroductoryOffer.mockResolvedValue(false);

    await service.validate(USER_ID, dto());

    expect(apple.hasUsedIntroductoryOffer).toHaveBeenCalledWith(OTID);
    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ markTrialUsed: false }),
    );
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
  });

  it('maps an AppleStoreUnavailableError from the history lookup to a retryable 503', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({ billing_trial_used_at: null }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', productId: PRO_NO_TRIAL, isTrial: false }),
    );
    apple.hasUsedIntroductoryOffer.mockRejectedValue(
      new AppleStoreUnavailableError('down'),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    // The lookup runs BEFORE any mutation, so no claim was committed.
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });
});
