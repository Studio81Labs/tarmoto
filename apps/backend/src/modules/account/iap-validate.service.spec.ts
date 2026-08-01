import { Test, TestingModule } from '@nestjs/testing';
import { EntityManager } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  Logger,
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
import { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';
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
    subscription_store_signed_date: null,
    subscription_tier: 'free',
    subscription_status: 'active',
    ...overrides,
  } as User;
}

// The row the caller's slot holds AFTER a successful claim: Apple-owned with a
// non-terminal status, so the Finding 2 single-read entitling check on the
// `'claimed'`/`'stale'` success paths passes. Its `id` is USER_ID, so it also
// reads as "owned by the caller" (never foreign) if the Finding 3 ownership
// query returns it. `claimForApple` is mocked, so the re-read must be supplied
// explicitly to reflect the committed claim.
function entitledRow(overrides: Partial<User> = {}): User {
  return makeUser({
    subscription_provider: 'apple',
    apple_original_transaction_id: OTID,
    subscription_tier: 'pro',
    subscription_status: 'active',
    ...overrides,
  });
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
  let accountService: {
    getSubscription: jest.Mock;
    getSubscriptionSnapshotForUser: jest.Mock;
  };
  let stampExecute: jest.Mock;
  let userRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    existsBy: jest.Mock;
  };
  let runExclusiveSpy: jest.Mock;

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
      getSubscriptionSnapshotForUser: jest.fn().mockResolvedValue(snapshot),
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
      // Pre-lock foreign-ownership check: default = OTID not held by another rider.
      existsBy: jest.fn().mockResolvedValue(false),
    };
    runExclusiveSpy = jest.fn(
      <T>(
        _userId: string,
        fn: (
          m: EntityManager,
          lease: { assertHeld: () => Promise<void>; fenceToken: number },
        ) => Promise<T>,
      ): Promise<T> =>
        fn({ getRepository: () => userRepo } as unknown as EntityManager, {
          assertHeld: () => Promise.resolve(),
          fenceToken: 1,
        }),
    );

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        IapValidateService,
        { provide: APPLE_BILLING_CLIENT, useValue: apple },
        { provide: ProviderClaimService, useValue: providerClaim },
        { provide: StoreReconciliationService, useValue: storeReconciliation },
        { provide: AccountService, useValue: accountService },
        {
          // Passthrough: the real per-rider Redis lock is verified by reasoning +
          // the proven POI upload-lock pattern, not in unit tests. Here it runs
          // the fn on the (mocked) pool manager with a lease (assertHeld passes,
          // a fixed fenceToken).
          provide: SubscriptionMutationLockService,
          useValue: {
            // A jest.fn passthrough, so tests can assert the lock (hence the
            // fence-publishing DB mutation) was NEVER entered on a mutation-free
            // rejection (verification/binding failure runs before the lock).
            runExclusive: runExclusiveSpy,
          },
        },
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();

    service = moduleRef.get(IapValidateService);
  });

  // A STRUCTURAL malformation of the client JWS (`FAILURE` — the schema
  // validator rejected an undecodable/malformed payload) is receipt-content →
  // terminal 400 (retryable:false), nothing downstream.
  it('maps a receipt-content VerificationException (FAILURE) to a terminal 400 with retryable:false and does nothing downstream', async () => {
    apple.verifyTransaction.mockRejectedValue(
      new VerificationException(VerificationStatus.FAILURE),
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

  // DEPLOYMENT-WIDE trust-store failure: a wrong/outdated mounted Apple root CA
  // makes `SignedDataVerifier` raise `VERIFICATION_FAILURE`. This must be
  // RETRYABLE (503) — NOT the terminal 400 that would strand every paying rider
  // — with a sanitized log (status name, never the JWS), and nothing downstream.
  it('maps a trust-store VerificationException (VERIFICATION_FAILURE, wrong/outdated root CA) to a retryable 503 with a sanitized log', async () => {
    const loggerSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    apple.verifyTransaction.mockRejectedValue(
      new VerificationException(VerificationStatus.VERIFICATION_FAILURE),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    // A sanitized cause was logged with the status NAME, never the JWS/secret.
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('VERIFICATION_FAILURE'),
    );
    expect(JSON.stringify(loggerSpy.mock.calls)).not.toContain('signed-jws');
    expect(apple.getSubscriptionStatus).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
    loggerSpy.mockRestore();
  });

  // A certificate-chain status (`INVALID_CERTIFICATE`) is likewise a
  // deployment/trust-store family failure → RETRYABLE 503, sanitized log.
  it('maps a certificate-chain VerificationException (INVALID_CERTIFICATE) to a retryable 503 with a sanitized log', async () => {
    const loggerSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    apple.verifyTransaction.mockRejectedValue(
      new VerificationException(VerificationStatus.INVALID_CERTIFICATE),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('INVALID_CERTIFICATE'),
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    loggerSpy.mockRestore();
  });

  // FAIL-SAFE default: an unrecognized / ambiguous status (a numeric code not in
  // the `VerificationStatus` enum) must be RETRYABLE 503, never terminal.
  it('maps an unrecognized/ambiguous VerificationException status to a retryable 503 (fail-safe)', async () => {
    const loggerSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    apple.verifyTransaction.mockRejectedValue(
      new VerificationException(99 as unknown as VerificationStatus),
    );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    expect(loggerSpy).toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    loggerSpy.mockRestore();
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

  // P2 Finding 3: a swallowed non-VerificationException must not vanish
  // silently — Nest never logs the cause of a thrown HttpException, so
  // without this operators get no signal whether an incident is config,
  // certs, or decoding. Assert the sanitized log fires (name/message/stack
  // only) without over-coupling to the exact wording.
  it('logs the sanitized cause before converting a non-verification verifyTransaction error to a retryable 503', async () => {
    const loggerSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const cause = new Error(
      'Apple transaction is missing the required field "productId"',
    );
    apple.verifyTransaction.mockRejectedValue(cause);

    await service.validate(USER_ID, dto()).catch((e: unknown) => e);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('non-verification error'),
      cause.stack,
    );
    // The client-facing message must never leak into the sanitized log call.
    expect(JSON.stringify(loggerSpy.mock.calls)).not.toContain('signed-jws');
    loggerSpy.mockRestore();
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

  // P2 Finding 3: same sanitized-logging requirement for the
  // getSubscriptionStatus catch-all that also swallows its cause into a
  // generic 503.
  it('logs the sanitized cause before converting a non-outage getSubscriptionStatus anomaly to a retryable 503', async () => {
    const loggerSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    const cause = new Error(
      'No subscription status returned for original transaction',
    );
    apple.getSubscriptionStatus.mockRejectedValue(cause);

    await service.validate(USER_ID, dto()).catch((e: unknown) => e);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('unrecognized error'),
      cause.stack,
    );
    loggerSpy.mockRestore();
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
    // MUTATION-FREE: the lock is never entered, so its fence-publish DB write
    // never runs for a binding failure.
    expect(runExclusiveSpy).not.toHaveBeenCalled();
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

  // Finding 3 (ownership-first, spec §74): the caller's binding passes, but the
  // verified OTID is already retained on ANOTHER rider's row. This must be a
  // MUTATION-FREE 409 discovered BEFORE any product/trial reconciliation — no
  // openConflict, no claim, no terminal clear, and (since the check precedes the
  // re-query) not even an Apple status call for a foreign purchase.
  it('rejects with a mutation-free 409 when the OTID is owned by a DIFFERENT rider, BEFORE the lock', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    // The pre-lock foreign-ownership check finds a DIFFERENT rider holding the
    // OTID (spec §74) — rejected before the lock is ever acquired.
    userRepo.existsBy.mockResolvedValue(true);

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      retryable: false,
    });
    // MUTATION-FREE: the lock is never entered (no fence publish), and no store
    // read/write of any kind happens.
    expect(runExclusiveSpy).not.toHaveBeenCalled();
    expect(storeReconciliation.findOpen).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
    expect(providerClaim.clearAppleTerminal).not.toHaveBeenCalled();
    expect(stampExecute).not.toHaveBeenCalled();
    // The foreign purchase is rejected BEFORE the authoritative re-query.
    expect(apple.getSubscriptionStatus).not.toHaveBeenCalled();
  });

  // Finding 3: when the OTID is UNOWNED (the ownership query finds no other
  // rider) the flow proceeds normally to the claim.
  it('proceeds normally when the ownership query finds the OTID unowned', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    userRepo.findOne
      .mockResolvedValueOnce(makeUser()) // caller load: unowned
      .mockResolvedValueOnce(null) // ownership query: nobody owns the OTID
      .mockResolvedValue(entitledRow()); // 'claimed' re-read

    const result = await service.validate(USER_ID, dto());

    expect(result).toEqual({ ...snapshot, retryable: false });
    expect(providerClaim.claimForApple).toHaveBeenCalledTimes(1);
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
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
    expect(storeReconciliation.findOpen).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        provider: 'apple',
        reason: 'unrecognized_product',
      },
      {},
      expect.anything(),
    );
    expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
      {
        provider: 'apple',
        appleOriginalTransactionId: OTID,
        reason: 'unrecognized_product',
        userId: USER_ID,
      },
      expect.anything(),
    );
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
    // Finding 2: after the claim the re-read row is entitling → success.
    userRepo.findOne
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValue(entitledRow());

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'pro' }),
      expect.anything(),
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
    userRepo.findOne
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValue(entitledRow());

    const result = await service.validate(
      USER_ID,
      dto({ productId: PREMIUM_NO_TRIAL }),
    );

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'pro' }),
      expect.anything(),
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
    userRepo.findOne
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValue(entitledRow());

    await service.validate(USER_ID, dto({ productId: PRO_NO_TRIAL }));

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'pro' }),
      expect.anything(),
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
    expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
      {
        provider: 'apple',
        appleOriginalTransactionId: OTID,
        reason: 'ineligible_trial_rejected',
        userId: USER_ID,
      },
      expect.anything(),
    );
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
    expect(storeReconciliation.findOpen).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        provider: 'apple',
        reason: 'ineligible_trial_rejected',
      },
      {},
      expect.anything(),
    );
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

  // P2 review round 21, Finding 1: `claimForApple`'s 23505 unique-violation
  // catch returns the DISTINCT 'ownership_conflict' result — the requested
  // OTID is already stored on ANOTHER user's row (a cross-rider OWNERSHIP
  // conflict), not the caller's slot being contested by another provider.
  // This must route to a MUTATION-FREE 409 that opens NO reconciliation —
  // opening `exclusivity_conflict` here would associate another rider's OTID
  // with the caller.
  it('rejects with a mutation-free 409 and opens NO reconciliation when claimForApple reports "ownership_conflict"', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('ownership_conflict');

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      message:
        'This App Store purchase is already associated with another account.',
      retryable: false,
    });
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(storeReconciliation.findOpen).not.toHaveBeenCalled();
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
    // findOne calls in order: (1) the initial user load (step 3); (2) the
    // Finding 3 ownership query (initial row is unowned → it runs) — the OTID is
    // the caller's own, so a USER_ID-owned row (never foreign); (3) the
    // stale-result re-read, showing a concurrent ACTIVE recovery won.
    const winningRow = makeUser({
      subscription_provider: 'apple',
      apple_original_transaction_id: OTID,
      subscription_tier: 'pro',
      subscription_status: 'active',
    });
    userRepo.findOne
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValueOnce(makeUser({ apple_original_transaction_id: OTID }))
      .mockResolvedValueOnce(winningRow);

    const result = await service.validate(USER_ID, dto());

    expect(result).toEqual({ ...snapshot, retryable: false });
    expect(result.provider).toBe('apple');
    expect(result.retryable).toBe(false);
    // Finding 3: the snapshot is built from the SAME `winningRow` read that
    // decided entitlement — no separate `getSubscription` re-read that could
    // observe a DIFFERENT (possibly since-terminated) state.
    expect(accountService.getSubscriptionSnapshotForUser).toHaveBeenCalledWith(
      winningRow,
    );
    expect(accountService.getSubscription).not.toHaveBeenCalled();
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
    // (1) initial load (unowned); (2) Finding 3 ownership query (caller's own
    // OTID, never foreign); (3) the stale re-read — a newer terminal clear won,
    // so the row is non-entitling → retryable 503.
    userRepo.findOne
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValueOnce(makeUser({ apple_original_transaction_id: OTID }))
      .mockResolvedValueOnce(
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
    // Finding 3: a NON-entitling loaded row must never be turned into a
    // returned snapshot — the 503 is thrown before any snapshot is built.
    expect(accountService.getSubscription).not.toHaveBeenCalled();
    expect(
      accountService.getSubscriptionSnapshotForUser,
    ).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(storeReconciliation.findOpen).not.toHaveBeenCalled();
  });

  // Finding 2 (round 24): a 'stale' result caused by a NEWER DIFFERENT-otid
  // tombstone winning the slot (Branch A ordering guard blocked this stale
  // replacement) must NOT be returned as success — the re-read row is a
  // null-provider tombstone (non-entitling) under ANOTHER otid, so the service
  // must return a RETRYABLE 503 (force re-validate), never a 201 with another
  // subscription's snapshot, and must open NO exclusivity reconciliation.
  it('returns a retryable 503 (no 201, no reconciliation) for a "stale" result whose current row is a newer DIFFERENT-otid tombstone', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('stale');
    userRepo.findOne
      .mockResolvedValueOnce(makeUser()) // caller load (unowned)
      .mockResolvedValueOnce(null) // ownership query: nobody else owns OTID
      .mockResolvedValueOnce(
        // stale re-read: a newer OTID was claimed + terminal-cleared into the
        // slot (provider null, DIFFERENT otid, tier free/canceled).
        makeUser({
          subscription_provider: null,
          apple_original_transaction_id: 'otid-newer-different',
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
    expect(
      accountService.getSubscriptionSnapshotForUser,
    ).not.toHaveBeenCalled();
    expect(accountService.getSubscription).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    expect(storeReconciliation.findOpen).not.toHaveBeenCalled();
  });

  // Finding 2 (round 24): even if a DIFFERENT-otid recovery is ACTIVE (entitling)
  // at the stale re-read, the snapshot belongs to ANOTHER subscription — the otid
  // check must still force a retryable 503, never hand back that snapshot as this
  // request's success.
  it('returns a retryable 503 for a "stale" result whose current row is entitling but owned by a DIFFERENT otid', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('stale');
    userRepo.findOne
      .mockResolvedValueOnce(makeUser()) // caller load
      .mockResolvedValueOnce(null) // ownership query
      .mockResolvedValueOnce(
        makeUser({
          subscription_provider: 'apple',
          apple_original_transaction_id: 'otid-newer-different',
          subscription_tier: 'pro',
          subscription_status: 'active',
        }),
      );

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    expect(
      accountService.getSubscriptionSnapshotForUser,
    ).not.toHaveBeenCalled();
  });

  // Finding 1 (round 25): a Branch A CAS-fail (`claimForApple` returns 'stale'
  // because the slot changed since the service's step-3 read) must force a clean
  // retryable re-validate when the re-read row is not owned by / not entitling for
  // THIS otid — never a 201 with a foreign/terminal snapshot, and no
  // reconciliation. This is the retry side of the round-25 fix (the claim side —
  // an unchanged row claiming even over a later-signed different-otid tombstone —
  // is covered in provider-claim.service.spec.ts).
  it('returns a retryable 503 (no 201, no reconciliation) for a "stale" CAS-fail whose current row is a non-owned/non-entitling changed slot', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('stale');
    userRepo.findOne
      .mockResolvedValueOnce(makeUser()) // caller load (unowned at step 3)
      .mockResolvedValueOnce(null) // ownership query: nobody else owns OTID
      .mockResolvedValueOnce(
        // CAS-fail re-read: a concurrent write changed the slot to a foreign-otid
        // tombstone (non-entitling, not this otid) since the observed baseline.
        makeUser({
          subscription_provider: null,
          apple_original_transaction_id: 'otid-changed-concurrently',
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
    expect(
      accountService.getSubscriptionSnapshotForUser,
    ).not.toHaveBeenCalled();
    expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
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
    // Finding 2: the 'claimed' success snapshot comes from a SINGLE re-read of
    // the just-claimed (entitling) row, not an independent getSubscription read.
    const claimedRow = entitledRow();
    userRepo.findOne
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValue(claimedRow);

    const result = await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      {
        tier: 'pro',
        status: 'active',
        currentPeriodEnd: expires,
        signedDate: SIGNED_DATE,
        cancelAtPeriodEnd: false,
        markTrialUsed: false,
        // CAS baseline threaded from the step-3 read (fresh, unowned row).
        observedProvider: null,
        observedOriginalTransactionId: null,
        observedSignedDate: null,
        fenceToken: 1,
      },
      expect.anything(),
    );
    expect(accountService.getSubscriptionSnapshotForUser).toHaveBeenCalledWith(
      claimedRow,
    );
    expect(accountService.getSubscription).not.toHaveBeenCalled();
    expect(result).toEqual({ ...snapshot, retryable: false });
    expect(result.provider).toBe('apple');
    expect(result.retryable).toBe(false);
    expect(stampExecute).not.toHaveBeenCalled();
  });

  // Finding 2: a 'claimed' result builds the success snapshot from a SINGLE
  // re-read of the just-claimed row, succeeding only when that row is still
  // entitling.
  it('returns the 201 success snapshot from the single re-read when a "claimed" row is still entitling', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('claimed');
    const claimedRow = entitledRow();
    userRepo.findOne
      .mockResolvedValueOnce(makeUser()) // caller load
      .mockResolvedValueOnce(null) // ownership query
      .mockResolvedValue(claimedRow); // 'claimed' re-read (entitling)

    const result = await service.validate(USER_ID, dto());

    expect(result).toEqual({ ...snapshot, retryable: false });
    expect(accountService.getSubscriptionSnapshotForUser).toHaveBeenCalledWith(
      claimedRow,
    );
    expect(accountService.getSubscription).not.toHaveBeenCalled();
  });

  // Finding 2 — THE FIX: an active validation CLAIMS the row, but a concurrent
  // NEWER TERMINAL validation clears it (subscription_provider → null, tier →
  // free, status → canceled) BEFORE the 'claimed' re-read. The endpoint must NOT
  // return a 201 with that free/canceled snapshot (which a client would finish
  // as validated on a terminal state) — it must return a RETRYABLE 503 so the
  // client re-validates and observes the authoritative terminal state.
  it('returns a retryable 503 (never a 201 free snapshot) when a "claimed" row is terminally cleared before the re-read', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('claimed');
    userRepo.findOne
      .mockResolvedValueOnce(makeUser()) // caller load
      .mockResolvedValueOnce(null) // ownership query
      .mockResolvedValueOnce(
        // 'claimed' re-read: a concurrent terminal clear won.
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
    // A non-entitling row is never turned into a returned (free) snapshot.
    expect(
      accountService.getSubscriptionSnapshotForUser,
    ).not.toHaveBeenCalled();
    expect(accountService.getSubscription).not.toHaveBeenCalled();
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
    userRepo.findOne
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValue(entitledRow());

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      {
        tier: 'pro',
        status: 'past_due',
        currentPeriodEnd: authoritativeExpiry,
        signedDate: SIGNED_DATE,
        cancelAtPeriodEnd: true,
        markTrialUsed: false,
        // CAS baseline threaded from the step-3 read (fresh, unowned row).
        observedProvider: null,
        observedOriginalTransactionId: null,
        observedSignedDate: null,
        fenceToken: 1,
      },
      expect.anything(),
    );
  });

  // P2 Finding 1: `currentPeriodEnd` must come from the AUTHORITATIVE
  // `expiresDate` ONLY. The prior `authoritative.expiresDate ?? verified.expiresDate`
  // fallback let a STALE client-submitted JWS backfill the persisted period
  // whenever Apple's re-query omitted `expiresDate` for an entitling status.
  // `getSubscriptionStatus` now itself requires `expiresDate` for every
  // entitling status (enforced in `apple-billing.client.ts`, covered by its
  // own spec) — but this test proves the SERVICE layer no longer has a
  // fallback wired up: even if the injected client mock returns a null
  // `expiresDate`, a much-older submitted JWS expiry can NEVER leak into the
  // claim. `currentPeriodEnd` is persisted as `null`, not the stale value.
  it('does not fall back to the submitted JWS expiry when the authoritative expiresDate is absent', async () => {
    const staleSubmittedExpiry = new Date('2020-01-01T00:00:00Z');
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ expiresDate: staleSubmittedExpiry }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', expiresDate: null, autoRenew: true }),
    );
    userRepo.findOne
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValue(entitledRow());

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ currentPeriodEnd: null }),
      expect.anything(),
    );
  });

  // P2 Finding 1: the AUTHORITATIVE expiresDate is used verbatim (no
  // submitted-JWS fallback in play) whenever Apple actually returns one.
  it('uses the authoritative expiresDate as currentPeriodEnd, never the submitted JWS', async () => {
    const authoritativeExpiry = new Date('2027-03-01T00:00:00Z');
    const staleSubmittedExpiry = new Date('2020-01-01T00:00:00Z');
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ expiresDate: staleSubmittedExpiry }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({
        status: 'active',
        expiresDate: authoritativeExpiry,
        autoRenew: true,
      }),
    );
    userRepo.findOne
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValue(entitledRow());

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ currentPeriodEnd: authoritativeExpiry }),
      expect.anything(),
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

  // P2 Finding 1 (round 17): the TYPED AppleStoreUnavailableError branch also
  // logs the sanitized cause before converting to the 503 — this typed branch
  // (post round-16) also fires for broken credentials/config, not only a
  // genuine outage, so without a log Nest records neither. Prefer the
  // wrapped `cause` when present.
  it('logs the sanitized wrapped cause before converting a typed AppleStoreUnavailableError re-query outage to a retryable 503', async () => {
    const loggerSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    const cause = new Error('ECONNRESET');
    apple.getSubscriptionStatus.mockRejectedValue(
      new AppleStoreUnavailableError(
        'Apple App Store Server API is unavailable',
        {
          cause,
        },
      ),
    );

    await service.validate(USER_ID, dto()).catch((e: unknown) => e);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('App Store unavailable'),
      cause.stack,
    );
    loggerSpy.mockRestore();
  });

  // Same typed branch, but with NO wrapped cause (e.g. a missing-field error
  // constructed without `{ cause }`) — the log must fall back to the
  // AppleStoreUnavailableError's own (already descriptive) stack rather than
  // logging nothing.
  it("falls back to the error's own stack when a typed AppleStoreUnavailableError re-query outage carries no wrapped cause", async () => {
    const loggerSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    const err = new AppleStoreUnavailableError(
      'Apple returned a subscription status without renewal information',
    );
    apple.getSubscriptionStatus.mockRejectedValue(err);

    await service.validate(USER_ID, dto()).catch((e: unknown) => e);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('App Store unavailable'),
      err.stack,
    );
    loggerSpy.mockRestore();
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
    userRepo.findOne
      .mockResolvedValueOnce(makeUser({ billing_trial_used_at: null }))
      .mockResolvedValue(entitledRow({ subscription_status: 'trialing' }));
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
      expect.anything(),
    );
    expect(stampExecute).not.toHaveBeenCalled();
  });

  it('overrides an ACTIVE authoritative status to trialing for a genuine first trial', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_TRIAL, isTrial: true }),
    );
    userRepo.findOne
      .mockResolvedValueOnce(makeUser({ billing_trial_used_at: null }))
      .mockResolvedValue(entitledRow({ subscription_status: 'trialing' }));
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
      expect.anything(),
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
      expect.any(Number),
      expect.anything(),
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
      expect.any(Number),
      expect.anything(),
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
      expect.any(Number),
      expect.anything(),
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
      expect.any(Number),
      expect.anything(),
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
      expect.any(Number),
      expect.anything(),
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
      expect.any(Number),
      expect.anything(),
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
    const winningRow = makeUser({
      subscription_provider: 'apple',
      apple_original_transaction_id: OTID,
      subscription_tier: 'pro',
      subscription_status: 'active',
    });
    userRepo.findOne
      .mockResolvedValueOnce(
        makeUser({
          subscription_provider: 'apple',
          apple_original_transaction_id: OTID,
          subscription_tier: 'pro',
        }),
      )
      .mockResolvedValueOnce(winningRow);
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
      expect.any(Number),
      expect.anything(),
    );
    expect(result).toEqual({ ...snapshot, retryable: false });
    // Finding 3: the snapshot is built from the SAME `winningRow` read that
    // decided entitlement — no separate `getSubscription` re-read that could
    // observe a state a concurrent later terminal clear had since changed.
    expect(accountService.getSubscriptionSnapshotForUser).toHaveBeenCalledWith(
      winningRow,
    );
    expect(accountService.getSubscription).not.toHaveBeenCalled();
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Round-14 P1: the guarded clear returned 0 rows because THIS flow's FENCE is
  // stale (a newer holder advanced `subscription_lock_fence` past our token —
  // possibly via a no-op that recovered nothing), NOT a genuine concurrent
  // recovery. The re-read row is still entitling, but Apple reported expired — we
  // must NOT return it as success. Bail with a retryable 503 so a fresh flow
  // re-decides.
  it('returns a retryable 503 (not the entitling snapshot) when the terminal clear lost to a STALE FENCE', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    userRepo.findOne
      .mockResolvedValueOnce(
        makeUser({
          subscription_provider: 'apple',
          apple_original_transaction_id: OTID,
          subscription_tier: 'pro',
        }),
      )
      // Clear-loss re-read: still entitling, but the fence has advanced PAST our
      // token (the lease-mock's fenceToken is 1), so this flow is stale.
      .mockResolvedValueOnce(
        makeUser({
          subscription_provider: 'apple',
          apple_original_transaction_id: OTID,
          subscription_tier: 'pro',
          subscription_status: 'active',
          subscription_lock_fence: 2,
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

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      retryable: true,
    });
    // Never returned a (stale) entitling snapshot.
    expect(
      accountService.getSubscriptionSnapshotForUser,
    ).not.toHaveBeenCalled();
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
    userRepo.findOne
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValue(entitledRow({ subscription_status: 'past_due' }));

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'free', status: 'past_due' }),
      expect.anything(),
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
    userRepo.findOne
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValue(entitledRow({ subscription_status: 'past_due' }));

    await service.validate(USER_ID, dto());

    expect(providerClaim.claimForApple).toHaveBeenCalledWith(
      USER_ID,
      OTID,
      expect.objectContaining({ tier: 'pro', status: 'past_due' }),
      expect.anything(),
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
    expect(storeReconciliation.findOpen).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        provider: 'apple',
        reason: 'exclusivity_conflict',
      },
      {},
      expect.anything(),
    );
    expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
      {
        provider: 'apple',
        appleOriginalTransactionId: OTID,
        reason: 'exclusivity_conflict',
        userId: USER_ID,
      },
      expect.anything(),
    );
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

  // P2 Finding 2 (round 17): a 'trial_ineligible' claim result — the atomic
  // Branch A trial guard lost a concurrent race — must route to the SAME
  // `ineligible_trial_rejected` 409 + reconciliation as the pre-claim
  // ineligible-trial check, NOT `exclusivity_conflict`: the slot is unowned,
  // so "another subscription is active" would be the wrong remediation.
  it('opens an ineligible_trial_rejected reconciliation (not exclusivity_conflict) and throws the ineligible-trial 409 when claimForApple returns "trial_ineligible"', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('trial_ineligible');

    const error = await service
      .validate(USER_ID, dto())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      message:
        'Your free trial has already been used and cannot be granted again.',
      retryable: false,
    });
    expect(storeReconciliation.findOpen).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        provider: 'apple',
        reason: 'ineligible_trial_rejected',
      },
      {},
      expect.anything(),
    );
    expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
      {
        provider: 'apple',
        appleOriginalTransactionId: OTID,
        reason: 'ineligible_trial_rejected',
        userId: USER_ID,
      },
      expect.anything(),
    );
    // NEVER the exclusivity path.
    expect(storeReconciliation.findOpen).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exclusivity_conflict' }),
      {},
      expect.anything(),
    );
    expect(storeReconciliation.openConflict).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exclusivity_conflict' }),
      expect.anything(),
    );
    expect(accountService.getSubscription).not.toHaveBeenCalled();
  });

  // Idempotent: a repeated 'trial_ineligible' result for the same otid must not
  // accumulate duplicate `open` reconciliation rows — same dedup shape as the
  // pre-claim ineligible-trial path.
  it('opens the ineligible_trial_rejected reconciliation only once across repeated "trial_ineligible" claim results', async () => {
    apple.verifyTransaction.mockResolvedValue(makeVerified());
    apple.getSubscriptionStatus.mockResolvedValue(makeStatus());
    providerClaim.claimForApple.mockResolvedValue('trial_ineligible');
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
    expect(storeReconciliation.openConflict).toHaveBeenCalledTimes(1);
  });

  // Finding 4: latest authoritative transaction is not a trial, but the
  // subscription's HISTORY shows a prior introductory offer → stamp the trial
  // marker anyway (the intro period already renewed to paid).
  it('stamps billing_trial_used_at from transaction history when the latest transaction is not a trial', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    userRepo.findOne
      .mockResolvedValueOnce(makeUser({ billing_trial_used_at: null }))
      .mockResolvedValue(entitledRow());
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
      expect.anything(),
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
    expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
      {
        provider: 'apple',
        appleOriginalTransactionId: OTID,
        reason: 'ineligible_trial_rejected',
        userId: USER_ID,
      },
      expect.anything(),
    );
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
    userRepo.findOne
      .mockResolvedValueOnce(
        makeUser({
          subscription_provider: null,
          apple_original_transaction_id: OTID,
          subscription_tier: 'free',
          subscription_status: 'canceled',
          billing_trial_used_at: new Date('2025-01-01T00:00:00Z'),
        }),
      )
      .mockResolvedValue(entitledRow());
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
      expect.anything(),
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
    userRepo.findOne
      .mockResolvedValueOnce(
        makeUser({
          subscription_provider: null,
          apple_original_transaction_id: OTID,
          subscription_tier: 'free',
          subscription_status: 'canceled',
          billing_trial_used_at: new Date('2025-01-01T00:00:00Z'),
        }),
      )
      .mockResolvedValue(entitledRow({ subscription_status: 'trialing' }));
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
      expect.anything(),
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
    expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
      {
        provider: 'apple',
        appleOriginalTransactionId: DIFFERENT_OTID,
        reason: 'ineligible_trial_rejected',
        userId: USER_ID,
      },
      expect.anything(),
    );
    expect(providerClaim.claimForApple).not.toHaveBeenCalled();
  });

  // Finding 2: a non-trial NEW otid with NO history intro claims normally — the
  // history lookup runs (not owned, not a trial) but reveals no intro, so no
  // rejection and no trial stamp.
  it('claims normally for a non-trial NEW otid whose history shows no introductory offer', async () => {
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    userRepo.findOne
      .mockResolvedValueOnce(
        makeUser({ billing_trial_used_at: new Date('2025-01-01T00:00:00Z') }),
      )
      .mockResolvedValue(entitledRow());
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
      expect.anything(),
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

  // P2 Finding 1 (round 17): the TYPED AppleStoreUnavailableError branch from
  // the history lookup must ALSO log the sanitized cause before converting to
  // the 503 (previously only the untyped/generic branch below it logged).
  it('logs the sanitized wrapped cause before converting a typed AppleStoreUnavailableError history-lookup outage to a retryable 503', async () => {
    const loggerSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({ billing_trial_used_at: null }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', productId: PRO_NO_TRIAL, isTrial: false }),
    );
    const cause = new Error('ETIMEDOUT');
    apple.hasUsedIntroductoryOffer.mockRejectedValue(
      new AppleStoreUnavailableError(
        'Apple App Store Server API is unavailable',
        {
          cause,
        },
      ),
    );

    await service.validate(USER_ID, dto()).catch((e: unknown) => e);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('App Store unavailable'),
      cause.stack,
    );
    loggerSpy.mockRestore();
  });

  // P2 Finding 3: an unrecognized (non-typed) error from the history lookup is
  // likewise swallowed into a generic 503 — assert the sanitized cause is
  // logged here too.
  it('logs the sanitized cause before converting an unrecognized history-lookup error to a retryable 503', async () => {
    const loggerSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    apple.verifyTransaction.mockResolvedValue(
      makeVerified({ productId: PRO_NO_TRIAL, isTrial: false }),
    );
    userRepo.findOne.mockResolvedValue(
      makeUser({ billing_trial_used_at: null }),
    );
    apple.getSubscriptionStatus.mockResolvedValue(
      makeStatus({ status: 'active', productId: PRO_NO_TRIAL, isTrial: false }),
    );
    const cause = new Error('unexpected history-lookup failure');
    apple.hasUsedIntroductoryOffer.mockRejectedValue(cause);

    await service.validate(USER_ID, dto()).catch((e: unknown) => e);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('unrecognized error'),
      cause.stack,
    );
    loggerSpy.mockRestore();
  });
});
