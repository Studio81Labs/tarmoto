import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IAP_PRODUCTS } from '@tarmoto/shared';
import { IapValidateService } from './iap-validate.service.js';
import {
  APPLE_BILLING_CLIENT,
  AppleStoreUnavailableError,
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
  let storeReconciliation: { openConflict: jest.Mock };
  let accountService: { getSubscription: jest.Mock };
  let stampExecute: jest.Mock;
  let userRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };

  const snapshot = { provider: 'apple', tier: 'pro', status: 'active' };

  beforeEach(async () => {
    apple = {
      verifyTransaction: jest.fn(),
      getSubscriptionStatus: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(true),
    };
    providerClaim = { claimForApple: jest.fn().mockResolvedValue('claimed') };
    storeReconciliation = { openConflict: jest.fn().mockResolvedValue({}) };
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

  // (b) unknown product → 400
  it('rejects with 400 for an unrecognized product', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: 'com.tarmoto.unknown' }),
    );
    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // (c) hint disagrees with verified product → 400
  it('rejects with 400 when the productId hint disagrees with the verified product', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL }),
    );
    await expect(
      service.validate(USER_ID, dto({ productId: PRO_TRIAL })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(apple.getSubscriptionStatus).not.toHaveBeenCalled();
  });

  // (d) ineligible trial → reject + reconciliation opened, no claim
  it('rejects an ineligible trial and opens an ineligible_trial_rejected reconciliation without claiming', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_TRIAL, isTrial: true }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({ billing_trial_used_at: new Date('2025-01-01T00:00:00Z') }),
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
    expect(apple.getSubscriptionStatus).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // (e) exclusivity conflict → 409
  it('rejects with 409 when claimForApple reports a conflict (another provider/otid owns the slot)', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue({
      status: 'active',
      expiresDate: new Date('2027-01-01T00:00:00Z'),
      autoRenew: true,
    });
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
    apple.getSubscriptionStatus.mockResolvedValue({
      status: 'active',
      expiresDate: expires,
      autoRenew: true,
    });

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
    apple.getSubscriptionStatus.mockResolvedValue({
      status: 'past_due',
      expiresDate: authoritativeExpiry,
      autoRenew: false,
    });

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
    apple.getSubscriptionStatus.mockResolvedValue({
      status: 'active',
      expiresDate: null,
      autoRenew: true,
    });

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
    apple.getSubscriptionStatus.mockResolvedValue({
      status: 'active',
      expiresDate: new Date('2027-01-01T00:00:00Z'),
      autoRenew: true,
    });

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
    apple.getSubscriptionStatus.mockResolvedValue({
      status: 'trialing',
      expiresDate: new Date('2027-01-15T00:00:00Z'),
      autoRenew: true,
    });

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
    apple.getSubscriptionStatus.mockResolvedValue({
      status: 'active',
      expiresDate: new Date('2027-01-15T00:00:00Z'),
      autoRenew: true,
    });

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
    apple.getSubscriptionStatus.mockResolvedValue({
      status: 'expired',
      expiresDate: new Date('2020-01-01T00:00:00Z'),
      autoRenew: false,
    });

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
  });

  it('rejects terminally when Apple reports the subscription is canceled', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue({
      status: 'canceled',
      expiresDate: null,
      autoRenew: false,
    });

    await expect(service.validate(USER_ID, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });
});
