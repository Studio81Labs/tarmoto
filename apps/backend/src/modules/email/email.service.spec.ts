/* eslint-disable @typescript-eslint/unbound-method */
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service.js';
import { EMAIL_PROVIDER, type EmailProvider } from './email-provider.js';

const buildConfigService = (): ConfigService =>
  ({
    get: jest.fn((key: string): string | undefined => {
      if (key === 'TARMOTO_COMPANION_URL') return 'https://app.tarmoto.app';
      if (key === 'TARMOTO_SUPPORT_EMAIL') return 'support@tarmoto.app';
      return undefined;
    }),
  }) as unknown as ConfigService;

describe('EmailService', () => {
  describe('provider abstraction', () => {
    it('dispatches a rendered template through the configured provider with bulk-sender headers', async () => {
      const send = jest.fn().mockResolvedValue({
        providerMessageId: 'res_123',
        providerName: 'mock',
      });
      const provider: EmailProvider = { name: 'mock', send };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailService,
          { provide: EMAIL_PROVIDER, useValue: provider },
          { provide: ConfigService, useValue: buildConfigService() },
        ],
      }).compile();
      const service = module.get(EmailService);

      const result = await service.sendVerification('rider@tarmoto.app', {
        displayName: 'Rider',
        verifyUrl: 'https://app.tarmoto.app/verify-email?token=abc',
        expiresInHours: 24,
      });

      expect(result?.providerMessageId).toBe('res_123');
      expect(send).toHaveBeenCalledTimes(1);
      const [message] = send.mock.calls[0] as [
        Parameters<EmailProvider['send']>[0],
      ];

      expect(message.to).toBe('rider@tarmoto.app');
      expect(message.subject).toContain('Verify your Tarmoto email');
      expect(message.text).toContain(
        'https://app.tarmoto.app/verify-email?token=abc',
      );
      expect(message.html).toContain(
        'https://app.tarmoto.app/verify-email?token=abc',
      );
      expect(message.tag).toBe('verification');
      // Per the AC, transactional emails carry `List-Unsubscribe`
      // (URL form) so bulk-sender filters group us with compliant
      // senders even though the body itself omits the marketing
      // unsubscribe link. We deliberately do NOT advertise
      // `List-Unsubscribe-Post` until a real POST `/unsubscribe`
      // endpoint exists — see comment in `bulkHeaders`.
      expect(message.headers?.['List-Unsubscribe']).toBe(
        '<https://app.tarmoto.app/settings/notifications>',
      );
      expect(message.headers?.['List-Unsubscribe-Post']).toBeUndefined();
      expect(message.headers?.['X-Tarmoto-Email-Category']).toBe(
        'verification',
      );
    });

    it('returns null and emits a metadata-only warning when the primary throws (no body re-logged)', async () => {
      const failing: EmailProvider = {
        name: 'flaky',
        send: jest.fn().mockRejectedValue(new Error('upstream 503')),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailService,
          { provide: EMAIL_PROVIDER, useValue: failing },
          { provide: ConfigService, useValue: buildConfigService() },
        ],
      }).compile();
      const service = module.get(EmailService);

      // Call must still resolve — a failed verification/reset mail
      // never bubbles up to the user-facing endpoint that triggered
      // it. The body must NOT fall through to the log provider:
      // verification and reset templates contain live one-time
      // tokens, and centralised production logs would turn a mail
      // outage into a credential-takeover surface.
      const resetUrl = 'https://app.tarmoto.app/reset-password?token=xyz';
      const result = await service.sendPasswordReset('rider@tarmoto.app', {
        displayName: 'Rider',
        resetUrl,
        expiresInMinutes: 15,
      });

      expect(failing.send).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('uses the log provider when no EMAIL_PROVIDER is registered', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailService,
          { provide: ConfigService, useValue: buildConfigService() },
        ],
      }).compile();
      const service = module.get(EmailService);

      const result = await service.sendPasswordChanged('rider@tarmoto.app', {
        displayName: 'Rider',
        changedAt: new Date('2026-04-30T10:00:00Z'),
      });

      expect(result?.providerName).toBe('log');
    });
  });

  describe('template rendering', () => {
    it.each([
      [
        'sendSubscriptionConfirmed',
        {
          displayName: 'Rider',
          planName: 'Premium',
          priceLabel: '$29.99/yr',
          renewsAt: new Date('2027-04-30T00:00:00Z'),
          manageBillingUrl: 'https://app.tarmoto.app/settings/subscription',
        },
        'subscription-confirmed',
      ],
      [
        'sendSubscriptionCancelled',
        {
          displayName: 'Rider',
          planName: 'Premium',
          endsAt: new Date('2026-05-30T00:00:00Z'),
          resubscribeUrl: 'https://app.tarmoto.app/settings/subscription',
        },
        'subscription-cancelled',
      ],
      [
        'sendDataExportReady',
        {
          displayName: 'Rider',
          downloadUrl: 'https://app.tarmoto.app/exports/abc.zip',
          expiresAt: new Date('2026-05-07T00:00:00Z'),
        },
        'data-export-ready',
      ],
      [
        'sendAccountDeletionScheduled',
        {
          displayName: 'Rider',
          scheduledFor: new Date('2026-05-30T00:00:00Z'),
        },
        'account-deletion-scheduled',
      ],
      [
        'sendAccountDeletionCompleted',
        {
          displayName: 'Rider',
          deletedAt: new Date('2026-05-30T00:00:00Z'),
        },
        'account-deletion-completed',
      ],
    ])(
      '%s renders with the right tag and reaches the provider',
      async (method, ctx, expectedTag) => {
        const send = jest.fn().mockResolvedValue({
          providerMessageId: 'mid',
          providerName: 'mock',
        });
        const provider: EmailProvider = { name: 'mock', send };
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            EmailService,
            { provide: EMAIL_PROVIDER, useValue: provider },
            { provide: ConfigService, useValue: buildConfigService() },
          ],
        }).compile();
        const service = module.get(EmailService);

        await (
          service as unknown as Record<
            string,
            (to: string, c: unknown) => Promise<unknown>
          >
        )[method]('rider@tarmoto.app', ctx);

        expect(send).toHaveBeenCalledTimes(1);
        const [message] = send.mock.calls[0] as [
          Parameters<EmailProvider['send']>[0],
        ];
        expect(message.tag).toBe(expectedTag);
        expect(message.html).not.toContain('undefined');
        expect(message.text).not.toContain('undefined');
      },
    );
  });
});
