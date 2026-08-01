import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  APIError,
  APIException,
  Status,
  VerificationException,
  VerificationStatus,
  type HistoryResponse,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type StatusResponse,
} from '@apple/app-store-server-library';
import {
  AppleStoreKitBillingClient,
  AppleStoreUnavailableError,
  type AppleSignedDataVerifier,
  type AppleSubscriptionStatusApi,
} from './apple-billing.client.js';
import {
  AppleIapConfig,
  type AppleIapEnvironment,
} from './apple-iap.config.js';
import {
  APP_ACCOUNT_TOKEN,
  EXPIRES_DATE_MS,
  ORIGINAL_TRANSACTION_ID,
  emptyStatusResponse,
  historyResponse,
  introOfferTransactionPayload,
  multiStatusResponse,
  renewalInfoPayload,
  standardTransactionPayload,
  statusResponse,
} from '../../../test/fixtures/apple/transactions.js';

function stubConfigService(
  values: Record<string, string | undefined> = {},
): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function configuredAppleConfig(
  environment: AppleIapEnvironment = 'Sandbox',
): AppleIapConfig {
  return new AppleIapConfig(
    stubConfigService({
      TARMOTO_APPLE_IAP_ISSUER_ID: 'issuer-1',
      TARMOTO_APPLE_IAP_KEY_ID: 'key-1',
      TARMOTO_APPLE_IAP_PRIVATE_KEY:
        '-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----',
      TARMOTO_APPLE_IAP_BUNDLE_ID: 'com.tarmoto.app',
      TARMOTO_APPLE_IAP_ENVIRONMENT: environment,
    }),
  );
}

function unconfiguredAppleConfig(): AppleIapConfig {
  return new AppleIapConfig(stubConfigService());
}

/**
 * Exposes the `getVerifier` / `getApiClient` seam so tests can inject fakes
 * and drive the mapping logic without Apple's real root certs or a network.
 */
class TestAppleBillingClient extends AppleStoreKitBillingClient {
  constructor(
    config: AppleIapConfig,
    private readonly fakes: {
      verifier?: AppleSignedDataVerifier;
      api?: AppleSubscriptionStatusApi;
    } = {},
  ) {
    super(config);
  }

  protected override getVerifier(): AppleSignedDataVerifier {
    if (!this.fakes.verifier) {
      throw new Error('test verifier not provided');
    }
    return this.fakes.verifier;
  }

  protected override getApiClient(): AppleSubscriptionStatusApi {
    if (!this.fakes.api) {
      throw new Error('test api client not provided');
    }
    return this.fakes.api;
  }
}

function fakeVerifier(input: {
  transaction?: JWSTransactionDecodedPayload;
  transactionError?: Error;
  renewal?: JWSRenewalInfoDecodedPayload;
}): AppleSignedDataVerifier {
  return {
    verifyAndDecodeTransaction: jest.fn(() => {
      if (input.transactionError) {
        return Promise.reject(input.transactionError);
      }
      return Promise.resolve(input.transaction as JWSTransactionDecodedPayload);
    }),
    verifyAndDecodeRenewalInfo: jest.fn(() =>
      Promise.resolve(input.renewal as JWSRenewalInfoDecodedPayload),
    ),
  };
}

/**
 * A verifier that decodes each signed JWS to a distinct payload keyed by the
 * JWS string, so a test can assert WHICH last-transaction the client selected.
 */
function keyedFakeVerifier(
  byTransactionJws: Record<
    string,
    {
      transaction: JWSTransactionDecodedPayload;
      renewal?: JWSRenewalInfoDecodedPayload;
    }
  >,
): AppleSignedDataVerifier {
  return {
    verifyAndDecodeTransaction: jest.fn((jws: string) => {
      const entry = byTransactionJws[jws];
      if (!entry) {
        return Promise.reject(new Error(`unexpected transaction jws: ${jws}`));
      }
      return Promise.resolve(entry.transaction);
    }),
    verifyAndDecodeRenewalInfo: jest.fn(() =>
      Promise.resolve(renewalInfoPayload(true)),
    ),
  };
}

function fakeApi(result: StatusResponse | Error): AppleSubscriptionStatusApi {
  return {
    getAllSubscriptionStatuses: jest.fn(() => {
      if (result instanceof Error) {
        return Promise.reject(result);
      }
      return Promise.resolve(result);
    }),
    getTransactionHistory: jest.fn(() =>
      Promise.reject(new Error('getTransactionHistory not stubbed')),
    ),
  };
}

/**
 * A fake API whose `getTransactionHistory` returns the queued pages in order
 * (one per call), so a test can exercise the client's pagination loop. Each
 * subsequent call follows the previous page's `revision`.
 */
function fakeHistoryApi(pages: HistoryResponse[]): AppleSubscriptionStatusApi {
  let call = 0;
  return {
    getAllSubscriptionStatuses: jest.fn(() =>
      Promise.reject(new Error('getAllSubscriptionStatuses not stubbed')),
    ),
    getTransactionHistory: jest.fn(() => {
      const page = pages[call] ?? pages[pages.length - 1];
      call += 1;
      return Promise.resolve(page);
    }),
  };
}

describe('AppleStoreKitBillingClient', () => {
  describe('verifyTransaction', () => {
    it('maps a verified standard payload to VerifiedAppleTransaction', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        verifier: fakeVerifier({ transaction: standardTransactionPayload() }),
      });

      const result = await client.verifyTransaction('jws');

      expect(result).toEqual({
        originalTransactionId: ORIGINAL_TRANSACTION_ID,
        transactionId: '2000000000000002',
        productId: 'com.tarmoto.pro.annual',
        appAccountToken: APP_ACCOUNT_TOKEN,
        expiresDate: new Date(EXPIRES_DATE_MS),
        isTrial: false,
        bundleId: 'com.tarmoto.app',
        environment: 'Sandbox',
      });
    });

    it('marks an introductory-offer payload as a trial', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        verifier: fakeVerifier({ transaction: introOfferTransactionPayload() }),
      });

      const result = await client.verifyTransaction('jws');

      expect(result.isTrial).toBe(true);
    });

    it('passes a null appAccountToken through and null expiresDate', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        verifier: fakeVerifier({
          transaction: standardTransactionPayload({
            appAccountToken: undefined,
            expiresDate: undefined,
          }),
        }),
      });

      const result = await client.verifyTransaction('jws');

      expect(result.appAccountToken).toBeNull();
      expect(result.expiresDate).toBeNull();
    });

    it('throws (terminal) on a verification failure', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        verifier: fakeVerifier({
          transactionError: new VerificationException(
            VerificationStatus.VERIFICATION_FAILURE,
          ),
        }),
      });

      await expect(client.verifyTransaction('jws')).rejects.toBeInstanceOf(
        VerificationException,
      );
    });

    it('throws on a bundleId / environment mismatch', async () => {
      // The real SignedDataVerifier enforces bundleId + environment and
      // raises a VerificationException; the seam reproduces that surface.
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        verifier: fakeVerifier({
          transactionError: new VerificationException(
            VerificationStatus.INVALID_APP_IDENTIFIER,
          ),
        }),
      });

      await expect(client.verifyTransaction('jws')).rejects.toBeInstanceOf(
        VerificationException,
      );
    });
  });

  describe('getSubscriptionStatus', () => {
    const cases: Array<{
      name: string;
      status: Status;
      intro?: boolean;
      expected: string;
    }> = [
      { name: 'ACTIVE -> active', status: Status.ACTIVE, expected: 'active' },
      {
        name: 'ACTIVE + intro offer -> trialing',
        status: Status.ACTIVE,
        intro: true,
        expected: 'trialing',
      },
      {
        name: 'EXPIRED -> expired',
        status: Status.EXPIRED,
        expected: 'expired',
      },
      {
        name: 'BILLING_RETRY -> billing_retry (no grace)',
        status: Status.BILLING_RETRY,
        expected: 'billing_retry',
      },
      {
        name: 'BILLING_GRACE_PERIOD -> past_due (still entitled)',
        status: Status.BILLING_GRACE_PERIOD,
        expected: 'past_due',
      },
      {
        name: 'REVOKED -> canceled',
        status: Status.REVOKED,
        expected: 'canceled',
      },
    ];

    it.each(cases)('maps $name', async ({ status, intro, expected }) => {
      const transaction = intro
        ? introOfferTransactionPayload()
        : standardTransactionPayload();
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeApi(statusResponse({ status })),
        verifier: fakeVerifier({
          transaction,
          renewal: renewalInfoPayload(true),
        }),
      });

      const result = await client.getSubscriptionStatus(
        ORIGINAL_TRANSACTION_ID,
      );

      expect(result.status).toBe(expected);
    });

    it('derives expiresDate and autoRenew from the decoded payloads', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeApi(statusResponse({ status: Status.ACTIVE })),
        verifier: fakeVerifier({
          transaction: standardTransactionPayload(),
          renewal: renewalInfoPayload(false),
        }),
      });

      const result = await client.getSubscriptionStatus(
        ORIGINAL_TRANSACTION_ID,
      );

      expect(result.expiresDate).toEqual(new Date(EXPIRES_DATE_MS));
      expect(result.autoRenew).toBe(false);
    });

    it('returns the AUTHORITATIVE product and non-trial signal decoded from the signed transaction', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeApi(statusResponse({ status: Status.ACTIVE })),
        verifier: fakeVerifier({
          transaction: standardTransactionPayload(),
          renewal: renewalInfoPayload(true),
        }),
      });

      const result = await client.getSubscriptionStatus(
        ORIGINAL_TRANSACTION_ID,
      );

      expect(result.productId).toBe('com.tarmoto.pro.annual');
      expect(result.isTrial).toBe(false);
    });

    it('reports isTrial=true when the authoritative transaction carries an intro offer', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeApi(statusResponse({ status: Status.ACTIVE })),
        verifier: fakeVerifier({
          transaction: introOfferTransactionPayload({
            productId: 'com.tarmoto.premium.annual.trial',
          }),
          renewal: renewalInfoPayload(true),
        }),
      });

      const result = await client.getSubscriptionStatus(
        ORIGINAL_TRANSACTION_ID,
      );

      expect(result.productId).toBe('com.tarmoto.premium.annual.trial');
      expect(result.isTrial).toBe(true);
    });

    it('throws a retryable error on an App Store 5xx outage', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeApi(
          new APIException(500, APIError.GENERAL_INTERNAL_RETRYABLE),
        ),
        verifier: fakeVerifier({ transaction: standardTransactionPayload() }),
      });

      await expect(
        client.getSubscriptionStatus(ORIGINAL_TRANSACTION_ID),
      ).rejects.toBeInstanceOf(AppleStoreUnavailableError);
    });

    it('throws a retryable error on a network failure', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeApi(new Error('ECONNRESET')),
        verifier: fakeVerifier({ transaction: standardTransactionPayload() }),
      });

      await expect(
        client.getSubscriptionStatus(ORIGINAL_TRANSACTION_ID),
      ).rejects.toBeInstanceOf(AppleStoreUnavailableError);
    });

    it('rethrows a terminal (non-retryable) App Store 4xx error', async () => {
      const apiError = new APIException(
        400,
        APIError.INVALID_ORIGINAL_TRANSACTION_ID,
      );
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeApi(apiError),
        verifier: fakeVerifier({ transaction: standardTransactionPayload() }),
      });

      await expect(
        client.getSubscriptionStatus(ORIGINAL_TRANSACTION_ID),
      ).rejects.toBe(apiError);
    });

    it('throws when Apple returns no subscription data', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeApi(emptyStatusResponse()),
        verifier: fakeVerifier({ transaction: standardTransactionPayload() }),
      });

      await expect(
        client.getSubscriptionStatus(ORIGINAL_TRANSACTION_ID),
      ).rejects.toThrow(/No subscription status returned/);
    });

    it('throws (no silent fallback) when no entry matches the requested original transaction', async () => {
      // Apple returns another subscription in the group but NOT the requested
      // one. The client must not substitute the stray entry.
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeApi(
          multiStatusResponse([
            {
              status: Status.ACTIVE,
              originalTransactionId: '9000000000000009',
              signedTransactionInfo: 'jws-other',
            },
          ]),
        ),
        verifier: keyedFakeVerifier({
          'jws-other': { transaction: standardTransactionPayload() },
        }),
      });

      await expect(
        client.getSubscriptionStatus(ORIGINAL_TRANSACTION_ID),
      ).rejects.toThrow(/No subscription status returned/);
    });

    it('selects the matching entry, not the first, when several are returned', async () => {
      // First entry (a DIFFERENT subscription) is ACTIVE; the requested one is
      // EXPIRED with a distinct expiresDate. The old code returned the first
      // (ACTIVE) — the fix must select by originalTransactionId.
      const otherExpiresMs = EXPIRES_DATE_MS + 5_000_000;
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeApi(
          multiStatusResponse([
            {
              status: Status.ACTIVE,
              originalTransactionId: '9000000000000009',
              signedTransactionInfo: 'jws-other',
            },
            {
              status: Status.EXPIRED,
              originalTransactionId: ORIGINAL_TRANSACTION_ID,
              signedTransactionInfo: 'jws-match',
            },
          ]),
        ),
        verifier: keyedFakeVerifier({
          'jws-other': {
            transaction: standardTransactionPayload({
              originalTransactionId: '9000000000000009',
              expiresDate: otherExpiresMs,
            }),
          },
          'jws-match': {
            transaction: standardTransactionPayload({
              expiresDate: EXPIRES_DATE_MS,
            }),
          },
        }),
      });

      const result = await client.getSubscriptionStatus(
        ORIGINAL_TRANSACTION_ID,
      );

      expect(result.status).toBe('expired');
      expect(result.expiresDate).toEqual(new Date(EXPIRES_DATE_MS));
    });
  });

  describe('hasUsedIntroductoryOffer', () => {
    it('returns true when a history transaction carries an introductory offer', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeHistoryApi([
          historyResponse({ signedTransactions: ['jws-intro'] }),
        ]),
        verifier: keyedFakeVerifier({
          'jws-intro': { transaction: introOfferTransactionPayload() },
        }),
      });

      await expect(
        client.hasUsedIntroductoryOffer(ORIGINAL_TRANSACTION_ID),
      ).resolves.toBe(true);
    });

    it('returns false when no history transaction carries an introductory offer', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: fakeHistoryApi([
          historyResponse({ signedTransactions: ['jws-paid'] }),
        ]),
        verifier: keyedFakeVerifier({
          'jws-paid': { transaction: standardTransactionPayload() },
        }),
      });

      await expect(
        client.hasUsedIntroductoryOffer(ORIGINAL_TRANSACTION_ID),
      ).resolves.toBe(false);
    });

    it('paginates via revision until an introductory offer is found', async () => {
      const pages = [
        historyResponse({
          signedTransactions: ['jws-paid'],
          hasMore: true,
          revision: 'rev-1',
        }),
        historyResponse({ signedTransactions: ['jws-intro'] }),
      ];
      let call = 0;
      const getTransactionHistory = jest.fn(() => {
        const page = pages[call] ?? pages[pages.length - 1];
        call += 1;
        return Promise.resolve(page);
      });
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: {
          getAllSubscriptionStatuses: jest.fn(),
          getTransactionHistory,
        } as unknown as AppleSubscriptionStatusApi,
        verifier: keyedFakeVerifier({
          'jws-paid': { transaction: standardTransactionPayload() },
          'jws-intro': { transaction: introOfferTransactionPayload() },
        }),
      });

      await expect(
        client.hasUsedIntroductoryOffer(ORIGINAL_TRANSACTION_ID),
      ).resolves.toBe(true);
      expect(getTransactionHistory).toHaveBeenCalledTimes(2);
      // The second page request follows the first page's revision token.
      expect(getTransactionHistory.mock.calls[1]?.[1]).toBe('rev-1');
    });

    it('stops paginating when hasMore is false', async () => {
      const getTransactionHistory = jest.fn(() =>
        Promise.resolve(
          historyResponse({
            signedTransactions: ['jws-paid'],
            hasMore: false,
          }),
        ),
      );
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: {
          getAllSubscriptionStatuses: jest.fn(),
          getTransactionHistory,
        } as unknown as AppleSubscriptionStatusApi,
        verifier: keyedFakeVerifier({
          'jws-paid': { transaction: standardTransactionPayload() },
        }),
      });

      await expect(
        client.hasUsedIntroductoryOffer(ORIGINAL_TRANSACTION_ID),
      ).resolves.toBe(false);
      expect(getTransactionHistory).toHaveBeenCalledTimes(1);
    });

    it('throws a retryable error on an App Store outage during history paging', async () => {
      const client = new TestAppleBillingClient(configuredAppleConfig(), {
        api: {
          getAllSubscriptionStatuses: jest.fn(),
          getTransactionHistory: jest.fn(() =>
            Promise.reject(
              new APIException(500, APIError.GENERAL_INTERNAL_RETRYABLE),
            ),
          ),
        } as unknown as AppleSubscriptionStatusApi,
        verifier: fakeVerifier({ transaction: standardTransactionPayload() }),
      });

      await expect(
        client.hasUsedIntroductoryOffer(ORIGINAL_TRANSACTION_ID),
      ).rejects.toBeInstanceOf(AppleStoreUnavailableError);
    });
  });

  describe('when Apple IAP is not configured', () => {
    it('isConfigured() returns false', () => {
      const client = new TestAppleBillingClient(unconfiguredAppleConfig());
      expect(client.isConfigured()).toBe(false);
    });

    it('verifyTransaction throws ServiceUnavailableException', async () => {
      const client = new TestAppleBillingClient(unconfiguredAppleConfig());
      await expect(client.verifyTransaction('jws')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('getSubscriptionStatus throws ServiceUnavailableException', async () => {
      const client = new TestAppleBillingClient(unconfiguredAppleConfig());
      await expect(
        client.getSubscriptionStatus(ORIGINAL_TRANSACTION_ID),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('hasUsedIntroductoryOffer throws ServiceUnavailableException', async () => {
      const client = new TestAppleBillingClient(unconfiguredAppleConfig());
      await expect(
        client.hasUsedIntroductoryOffer(ORIGINAL_TRANSACTION_ID),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
