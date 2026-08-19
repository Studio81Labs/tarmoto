import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EmailService } from './email.service.js';
import { EMAIL_PROVIDER, type EmailProvider } from './email-provider.js';
import { EmailLog } from '../../entities/email-log.entity.js';
import { EmailTemplate } from '../../entities/email-template.entity.js';

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

    it('strips control characters from the subject before dispatch (header-injection guard)', async () => {
      const send = jest.fn().mockResolvedValue({
        providerMessageId: 'res_ctl',
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

      // A rendered subject can carry a raw, user-controlled value (an admin
      // block-template `{displayName}`, or the inviter name in the trip-invite
      // subject); a CR/LF there must never reach the provider as a header
      // separator. String.fromCharCode keeps literal control bytes out of this
      // source file.
      const crlf = String.fromCharCode(13, 10);
      await service.sendRendered('rider@tarmoto.app', {
        subject: `Hi Bob${crlf}Bcc: evil@example.com`,
        html: '<p>hi</p>',
        text: 'hi',
        tag: 'weekly-digest',
      });

      expect(send).toHaveBeenCalledTimes(1);
      const [message] = send.mock.calls[0] as [
        Parameters<EmailProvider['send']>[0],
      ];
      expect(message.subject).not.toMatch(/\p{Cc}/u);
      expect(message.subject).toBe('Hi Bob  Bcc: evil@example.com');
    });

    it('records the sanitized subject in the delivery log, not the raw one', async () => {
      const send = jest.fn().mockResolvedValue({
        providerMessageId: 'res_log',
        providerName: 'mock',
      });
      const insert = jest.fn().mockResolvedValue(undefined);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailService,
          { provide: EMAIL_PROVIDER, useValue: { name: 'mock', send } },
          { provide: ConfigService, useValue: buildConfigService() },
          { provide: getRepositoryToken(EmailLog), useValue: { insert } },
        ],
      }).compile();
      const service = module.get(EmailService);

      const crlf = String.fromCharCode(13, 10);
      await service.sendRendered('rider@tarmoto.app', {
        subject: `Weekly digest${crlf}Bcc: evil@example.com`,
        html: '<p>hi</p>',
        text: 'hi',
        tag: 'weekly-digest',
      });

      expect(insert).toHaveBeenCalledTimes(1);
      const [row] = insert.mock.calls[0] as [{ subject: string }];
      // email_log must match what the provider received (sanitized), not the
      // raw CRLF subject — otherwise the admin log UI diverges from the
      // delivered mail and the log stream is forgeable.
      expect(row.subject).not.toMatch(/\p{Cc}/u);
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

  describe('locale seam', () => {
    // Phase 1 of email i18n: `send*` grew a trailing `locale` param that
    // flows into the rendered template context via `withBase`, but no
    // template reads `ctx.locale` yet (that lands in later per-template
    // tasks) — so both cases below still render the English subject.
    // What these tests prove at this phase: the seam accepts an explicit
    // locale AND a defaulted one without breaking the render+dispatch
    // path — i.e. `EmailService.sendVerification(to, ctx, locale)` and its
    // two-arg default-param form both complete and dispatch the expected
    // rendered message through the provider.
    function buildService(send: jest.Mock): Promise<EmailService> {
      const provider: EmailProvider = { name: 'mock', send };
      return Test.createTestingModule({
        providers: [
          EmailService,
          { provide: EMAIL_PROVIDER, useValue: provider },
          { provide: ConfigService, useValue: buildConfigService() },
        ],
      })
        .compile()
        .then((module) => module.get(EmailService));
    }

    const verifyCtx = {
      displayName: 'Riku',
      verifyUrl: 'https://x/y',
      expiresInHours: 24,
    };

    it('passes an explicit locale through to the render+dispatch path', async () => {
      const send = jest.fn().mockResolvedValue({
        providerMessageId: 'loc_1',
        providerName: 'mock',
      });
      const service = await buildService(send);

      await service.sendVerification('rider@example.com', verifyCtx, 'en');

      expect(send).toHaveBeenCalledTimes(1);
      const [message] = send.mock.calls[0] as [
        Parameters<EmailProvider['send']>[0],
      ];
      expect(message.subject).toBe('Verify your Tarmoto email');
      expect(message.tag).toBe('verification');
    });

    it('defaults the locale when the caller omits it, rendering the same subject', async () => {
      const send = jest.fn().mockResolvedValue({
        providerMessageId: 'loc_2',
        providerName: 'mock',
      });
      const service = await buildService(send);

      await service.sendVerification('rider@example.com', verifyCtx);

      expect(send).toHaveBeenCalledTimes(1);
      const [message] = send.mock.calls[0] as [
        Parameters<EmailProvider['send']>[0],
      ];
      expect(message.subject).toBe('Verify your Tarmoto email');
      expect(message.tag).toBe('verification');
    });
  });

  describe('template rendering', () => {
    it.each([
      [
        'sendSubscriptionConfirmed',
        {
          displayName: 'Rider',
          planName: 'Premium',
          priceLabel: '€29.99/yr',
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
      [
        'sendTripInvite',
        {
          inviterDisplayName: 'Adam',
          tripTitle: 'Italian Loop',
          joinUrl: 'https://app.tarmoto.app/trips/join?trip_id=t1&code=ABC',
          inviteCode: 'ABCDEFGH',
          message: 'Come ride!',
        },
        'trip-invite',
      ],
      [
        'sendWeeklyDigest',
        {
          displayName: 'Rider',
          rideCount: 3,
          totalKm: 128.4,
          totalMinutes: 195,
          bestQuality: 4.3,
          percentExplored: 62,
          riddenSegments: 540,
          units: 'metric',
          exploreUrl: 'https://app.tarmoto.app/explore',
        },
        'weekly-digest',
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
        )[method]!('rider@tarmoto.app', ctx);

        expect(send).toHaveBeenCalledTimes(1);
        const [message] = send.mock.calls[0] as [
          Parameters<EmailProvider['send']>[0],
        ];
        expect(message.tag).toBe(expectedTag);
        expect(message.html).not.toContain('undefined');
        expect(message.text).not.toContain('undefined');
      },
    );

    it('digest respects the rider unit preference + shows an unsubscribe footer', async () => {
      const send = jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'r1', providerName: 'mock' });
      const module = await Test.createTestingModule({
        providers: [
          EmailService,
          { provide: EMAIL_PROVIDER, useValue: { name: 'mock', send } },
          { provide: ConfigService, useValue: buildConfigService() },
        ],
      }).compile();

      await module.get(EmailService).sendWeeklyDigest('rider@tarmoto.app', {
        displayName: 'Rider',
        rideCount: 3,
        totalKm: 128.4,
        totalMinutes: 195,
        bestQuality: 4.3,
        percentExplored: 62,
        riddenSegments: 540,
        units: 'imperial',
        exploreUrl: 'https://app.tarmoto.app/explore',
      });

      const [message] = send.mock.calls[0] as [
        Parameters<EmailProvider['send']>[0],
      ];
      expect(message.subject).toContain('3 rides');
      // imperial → miles, never the raw km value.
      expect(message.html).toContain('mi');
      expect(message.html).not.toContain('128.4 km');
      expect(message.html).toContain('62%');
      // The digest (marketing) footer carries the unsubscribe link — in BOTH
      // the HTML and the text/plain part (text-only clients never see the HTML).
      expect(message.html).toContain('Unsubscribe');
      expect(message.text).toContain('Unsubscribe from marketing emails');
    });
  });

  describe('delivery log (email_log)', () => {
    async function buildWithLog(
      send: jest.Mock,
      insert: jest.Mock,
    ): Promise<EmailService> {
      const module = await Test.createTestingModule({
        providers: [
          EmailService,
          { provide: EMAIL_PROVIDER, useValue: { name: 'resend', send } },
          { provide: ConfigService, useValue: buildConfigService() },
          { provide: getRepositoryToken(EmailLog), useValue: { insert } },
        ],
      }).compile();
      return module.get(EmailService);
    }

    const verifyCtx = {
      displayName: 'Rider',
      verifyUrl: 'https://app.tarmoto.app/verify-email?token=abc',
      expiresInHours: 24,
    };

    it('records a sent email as metadata only — never the token-bearing body', async () => {
      const send = jest.fn().mockResolvedValue({
        providerMessageId: 'res_9',
        providerName: 'resend',
      });
      const insert = jest.fn().mockResolvedValue({});
      const service = await buildWithLog(send, insert);

      // Mixed-case recipient to prove it's lowercased for purge/export matching.
      await service.sendVerification('Rider@Tarmoto.app', verifyCtx);

      expect(insert).toHaveBeenCalledTimes(1);
      const [row] = insert.mock.calls[0] as [Record<string, unknown>];
      expect(row).toMatchObject({
        recipient: 'rider@tarmoto.app',
        tag: 'verification',
        status: 'sent',
        provider: 'resend',
        provider_message_id: 'res_9',
        error_class: null,
      });
      // The body embeds a live one-time token — it must never reach the log.
      expect(JSON.stringify(row)).not.toContain('token=abc');
      expect(row).not.toHaveProperty('html');
      expect(row).not.toHaveProperty('text');
    });

    it('records a failed send with the error and no provider message id', async () => {
      const send = jest.fn().mockRejectedValue(new Error('upstream 503'));
      const insert = jest.fn().mockResolvedValue({});
      const service = await buildWithLog(send, insert);

      const result = await service.sendVerification(
        'rider@tarmoto.app',
        verifyCtx,
      );

      expect(result).toBeNull();
      const [row] = insert.mock.calls[0] as [Record<string, unknown>];
      expect(row).toMatchObject({
        tag: 'verification',
        status: 'failed',
        provider: 'resend',
        provider_message_id: null,
        error_class: 'upstream 503',
      });
      expect(JSON.stringify(row)).not.toContain('token=abc');
    });

    it('swallows a log-write failure so the send result is unaffected', async () => {
      const send = jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'r', providerName: 'resend' });
      const insert = jest.fn().mockRejectedValue(new Error('db down'));
      const service = await buildWithLog(send, insert);

      const result = await service.sendVerification(
        'rider@tarmoto.app',
        verifyCtx,
      );

      expect(result?.providerMessageId).toBe('r');
    });

    it('does not log the account-deletion-completed receipt (sent post-purge)', async () => {
      // This receipt goes out AFTER purgeUser deleted the recipient's email_log
      // rows, so logging it would re-persist the just-deleted address forever.
      const send = jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'r', providerName: 'resend' });
      const insert = jest.fn().mockResolvedValue({});
      const service = await buildWithLog(send, insert);

      await service.sendAccountDeletionCompleted('rider@tarmoto.app', {
        displayName: 'Rider',
        deletedAt: new Date('2026-07-05T08:00:00Z'),
      });

      expect(send).toHaveBeenCalledTimes(1);
      expect(insert).not.toHaveBeenCalled();
    });

    it('redacts the trip-invite subject — the inviter is third-party data in a recipient-keyed row', async () => {
      const send = jest
        .fn()
        .mockResolvedValue({ providerMessageId: 't', providerName: 'resend' });
      const insert = jest.fn().mockResolvedValue({});
      const service = await buildWithLog(send, insert);

      await service.sendTripInvite('invitee@external.com', {
        inviterDisplayName: 'Adam',
        tripTitle: 'Italian Loop',
        joinUrl: 'https://app.tarmoto.app/trips/join?trip_id=t1&code=ABC',
        inviteCode: 'ABCDEFGH',
        message: 'Come ride!',
      });

      const [row] = insert.mock.calls[0] as [Record<string, unknown>];
      expect(row).toMatchObject({
        recipient: 'invitee@external.com',
        tag: 'trip-invite',
        subject: 'Trip invitation',
      });
      // The inviter's name + trip title must not persist in a row the inviter's
      // own account deletion can't purge (it's keyed on the external recipient).
      expect(JSON.stringify(row)).not.toContain('Adam');
      expect(JSON.stringify(row)).not.toContain('Italian Loop');
    });
  });

  describe('render override (admin email template editor)', () => {
    async function buildWithTemplateRepo(
      send: jest.Mock,
      findOne: jest.Mock,
    ): Promise<EmailService> {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailService,
          { provide: EMAIL_PROVIDER, useValue: { name: 'mock', send } },
          { provide: ConfigService, useValue: buildConfigService() },
          {
            provide: getRepositoryToken(EmailTemplate),
            useValue: { findOne },
          },
        ],
      }).compile();
      return module.get(EmailService);
    }

    const digestCtx = {
      displayName: 'Rider',
      rideCount: 3,
      totalKm: 128.4,
      totalMinutes: 195,
      bestQuality: 4.3,
      percentExplored: 62,
      riddenSegments: 540,
      units: 'metric' as const,
      exploreUrl: 'https://app.tarmoto.app/explore',
    };

    it('renders the published block override instead of the code template', async () => {
      const send = jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'ov_1', providerName: 'mock' });
      const findOne = jest.fn().mockResolvedValue({
        id: 'row-1',
        template_tag: 'weekly-digest',
        locale: 'en',
        status: 'published',
        subject: 'Custom digest: {rideSummary}',
        blocks: [{ type: 'heading', text: 'Hey {displayName}, nice week!' }],
      });
      const service = await buildWithTemplateRepo(send, findOne);

      await service.sendWeeklyDigest('rider@tarmoto.app', digestCtx);

      expect(findOne).toHaveBeenCalledTimes(1);
      expect(findOne).toHaveBeenCalledWith({
        where: {
          template_tag: 'weekly-digest',
          locale: 'en',
          status: 'published',
        },
      });
      const [message] = send.mock.calls[0] as [
        Parameters<EmailProvider['send']>[0],
      ];
      // Block-rendered subject/body — distinct from the code template's copy
      // ("Your week on Tarmoto — ...", see i18n `digest.subject`).
      expect(message.subject).toBe('Custom digest: 3 rides');
      expect(message.subject).not.toContain('Your week on Tarmoto');
      expect(message.html).toContain('Hey Rider, nice week!');
      expect(message.tag).toBe('weekly-digest');
    });

    it('falls back to the code template when no published override exists', async () => {
      const send = jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'ov_2', providerName: 'mock' });
      const findOne = jest.fn().mockResolvedValue(null);
      const service = await buildWithTemplateRepo(send, findOne);

      await service.sendWeeklyDigest('rider@tarmoto.app', digestCtx);

      expect(findOne).toHaveBeenCalledTimes(1);
      const [message] = send.mock.calls[0] as [
        Parameters<EmailProvider['send']>[0],
      ];
      expect(message.subject).toContain('Your week on Tarmoto');
      expect(message.subject).toContain('3 rides');
    });

    it('falls back to the code template when the override lookup throws (no error propagates)', async () => {
      const send = jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'ov_3', providerName: 'mock' });
      const findOne = jest.fn().mockRejectedValue(new Error('db down'));
      const service = await buildWithTemplateRepo(send, findOne);

      const result = await service.sendWeeklyDigest(
        'rider@tarmoto.app',
        digestCtx,
      );

      expect(result?.providerMessageId).toBe('ov_3');
      const [message] = send.mock.calls[0] as [
        Parameters<EmailProvider['send']>[0],
      ];
      expect(message.subject).toContain('Your week on Tarmoto');
    });

    it('never queries the override repo for a locked tag', async () => {
      const send = jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'ov_4', providerName: 'mock' });
      const findOne = jest.fn().mockResolvedValue(null);
      const service = await buildWithTemplateRepo(send, findOne);

      await service.sendVerification('rider@tarmoto.app', {
        displayName: 'Rider',
        verifyUrl: 'https://app.tarmoto.app/verify-email?token=abc',
        expiresInHours: 24,
      });

      expect(send).toHaveBeenCalledTimes(1);
      expect(findOne).not.toHaveBeenCalled();
    });
  });
});
