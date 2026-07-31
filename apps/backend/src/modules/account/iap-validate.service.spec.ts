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
  autoRenew: boolean;
}

// The AUTHORITATIVE re-query shape — the source of truth for product/trial as
// well as status/expiry after Finding 1. Defaults to a current, active pro
// subscription; overrides model stale/upgraded/downgraded/trial states.
function makeStatus(
  overrides: Partial<AuthoritativeStatus> = {},
): AuthoritativeStatus {
  return {
    status: 'active',
    productId: PRO_NO_TRIAL,
    isTrial: false,
    expiresDate: new Date('2027-01-01T00:00:00Z'),
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
    isConfigured: jest.Mock;
  };
  let providerClaim: { claimForApple: jest.Mock };
  let storeReconciliation: { openConflict: jest.Mock; findOpen: jest.Mock };
  let accountService: { getSubscription: jest.Mock };
  let stampExecute: jest.Mock;
  let userRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };

  const snapshot = { provider: 'apple', tier: 'pro', status: 'active' };

  beforeEach(async () => {
    apple = {
      verifyTransaction: jest.fn(),
      getSubscriptionStatus: jest.fn().mockResolvedValue(makeStatus()),
      isConfigured: jest.fn().mockReturnValue(true),
    };
    providerClaim = { claimForApple: jest.fn().mockResolvedValue('claimed') };
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

  // (c) hint is cross-checked against the AUTHORITATIVE product, not the JWS.
  it('rejects with 400 when the productId hint disagrees with the AUTHORITATIVE product', async () => {
    // The hint even matches the submitted JWS, but the authoritative product
    // differs — the hint must lose.
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_TRIAL }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ productId: PRO_NO_TRIAL }),
    );
    await expect(
      service.validate(USER_ID, dto({ productId: PRO_TRIAL })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
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
      cancelAtPeriodEnd: false,
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
      cancelAtPeriodEnd: true,
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

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'pro', status: 'trialing' }),
    );
    // The stamp UPDATE was issued after the claim.
    expect(userRepo.createQueryBuilder).toHaveBeenCalled();
    expect(stampExecute).toHaveBeenCalledTimes(1);
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

  // Apple reports expired/canceled → terminal reject, no claim
  it('rejects terminally when Apple reports the subscription is expired', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'expired',
        expiresDate: new Date('2020-01-01T00:00:00Z'),
        autoRenew: false,
      }),
    );

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  it('rejects terminally when Apple reports the subscription is canceled', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'canceled', expiresDate: null, autoRenew: false }),
    );

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });
});
