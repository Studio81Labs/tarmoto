import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EmailLog } from '../../entities/email-log.entity.js';
import { getCompanionUrl } from '../../common/companion-url.js';
import {
  EMAIL_PROVIDER,
  type EmailProvider,
  type EmailSendResult,
} from './email-provider.js';
import { LogEmailProvider } from './providers/log.provider.js';
import {
  type AccountDeletionCompletedContext,
  type AccountDeletionScheduledContext,
  type DataExportReadyContext,
  type EmailTag,
  type PasswordChangedContext,
  type PasswordResetContext,
  type RenderedTemplate,
  type SubscriptionCancelledContext,
  type SubscriptionConfirmedContext,
  type TripInviteContext,
  type VerificationContext,
  type WeeklyDigestContext,
  accountDeletionCompletedTemplate,
  accountDeletionScheduledTemplate,
  dataExportReadyTemplate,
  passwordChangedTemplate,
  passwordResetTemplate,
  subscriptionCancelledTemplate,
  subscriptionConfirmedTemplate,
  tripInviteTemplate,
  verificationTemplate,
  weeklyDigestTemplate,
} from './templates/index.js';

const DEFAULT_SUPPORT_EMAIL = 'support@tarmoto.app';

type ContextWithoutBase<T> = Omit<T, 'preferencesUrl'>;

/**
 * Public surface for every place in the backend that needs to send a
 * transactional email. Wraps:
 *
 *   - rendering: caller supplies typed context, service injects shared
 *     base fields (preferences URL, etc.) and runs the template.
 *   - dispatch: hands off to the configured `EmailProvider`. When no
 *     provider is bound (test or `TARMOTO_EMAIL_PROVIDER=log`), uses
 *     the in-process `LogEmailProvider` so dev/CI still see the
 *     rendered output. On send failure, emits a metadata-only
 *     warning — the body is NOT re-routed to the log provider
 *     because verification and reset templates embed live one-time
 *     tokens, and centralised production logs would turn a mail
 *     outage into a credential-takeover surface.
 *   - bulk-sender headers: List-Unsubscribe is set on every send so
 *     Gmail/Yahoo group us with bulk-compliant senders even though
 *     these are transactional. The body itself does NOT render an
 *     unsubscribe button — transactional mail is exempt per AC.
 *
 * Sends are best-effort. Callers MUST NOT propagate send failures
 * back to user-facing API responses (registration shouldn't 500
 * because Resend is having a bad afternoon).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly fallback: EmailProvider;

  constructor(
    @Inject(EMAIL_PROVIDER)
    @Optional()
    private readonly provider: EmailProvider | null,
    private readonly config: ConfigService,
    // Optional so unit tests can construct the service without the DB layer.
    // Bound in production via `EmailModule`'s `TypeOrmModule.forFeature`.
    @Optional()
    @InjectRepository(EmailLog)
    private readonly emailLog: Repository<EmailLog> | null = null,
  ) {
    this.fallback = new LogEmailProvider();
  }

  async sendVerification(
    to: string,
    ctx: ContextWithoutBase<VerificationContext>,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(to, verificationTemplate(this.withBase(ctx)));
  }

  async sendPasswordReset(
    to: string,
    ctx: ContextWithoutBase<PasswordResetContext>,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(to, passwordResetTemplate(this.withBase(ctx)));
  }

  async sendPasswordChanged(
    to: string,
    ctx: ContextWithoutBase<Omit<PasswordChangedContext, 'supportEmail'>>,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(
      to,
      passwordChangedTemplate(
        this.withBase({ ...ctx, supportEmail: this.supportEmail() }),
      ),
    );
  }

  async sendSubscriptionConfirmed(
    to: string,
    ctx: ContextWithoutBase<SubscriptionConfirmedContext>,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(to, subscriptionConfirmedTemplate(this.withBase(ctx)));
  }

  async sendSubscriptionCancelled(
    to: string,
    ctx: ContextWithoutBase<SubscriptionCancelledContext>,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(to, subscriptionCancelledTemplate(this.withBase(ctx)));
  }

  async sendDataExportReady(
    to: string,
    ctx: ContextWithoutBase<DataExportReadyContext>,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(to, dataExportReadyTemplate(this.withBase(ctx)));
  }

  async sendTripInvite(
    to: string,
    ctx: ContextWithoutBase<TripInviteContext>,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(to, tripInviteTemplate(this.withBase(ctx)));
  }

  async sendWeeklyDigest(
    to: string,
    ctx: ContextWithoutBase<WeeklyDigestContext>,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(to, weeklyDigestTemplate(this.withBase(ctx)));
  }

  async sendAccountDeletionScheduled(
    to: string,
    ctx: ContextWithoutBase<
      Omit<AccountDeletionScheduledContext, 'supportEmail'>
    >,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(
      to,
      accountDeletionScheduledTemplate(
        this.withBase({ ...ctx, supportEmail: this.supportEmail() }),
      ),
    );
  }

  async sendAccountDeletionCompleted(
    to: string,
    ctx: ContextWithoutBase<
      Omit<AccountDeletionCompletedContext, 'supportEmail'>
    >,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(
      to,
      accountDeletionCompletedTemplate(
        this.withBase({ ...ctx, supportEmail: this.supportEmail() }),
      ),
    );
  }

  /**
   * Render-then-send. If the configured provider throws, the service
   * emits a metadata-only delivery-failed warning so on-call sees the
   * miss, but does NOT fall back to the log provider with the full
   * body — verification and reset templates embed live one-time
   * tokens, and centralised production logs would turn a mail
   * outage into a credential-takeover surface (anyone with log
   * access can read the URL and consume the token before expiry).
   * The caller never sees the error — see the class docstring on why.
   */
  private async dispatch(
    to: string,
    template: RenderedTemplate,
  ): Promise<EmailSendResult | null> {
    const headers = this.bulkHeaders(template.tag);
    const message = {
      to,
      subject: template.subject,
      html: template.html,
      text: template.text,
      headers,
      tag: template.tag,
    };

    const primary = this.provider ?? this.fallback;

    try {
      const result = await primary.send(message);
      this.logger.log(
        `Sent ${template.tag} to ${to} via ${result.providerName}` +
          (result.providerMessageId ? ` (${result.providerMessageId})` : ''),
      );
      await this.recordSend(to, template, {
        status: 'sent',
        provider: result.providerName,
        providerMessageId: result.providerMessageId ?? null,
      });
      return result;
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      // Metadata-only — `template.text` and `.html` may contain a live
      // verification or reset token. The log provider primary path
      // (dev) still emits full bodies because it IS the configured
      // provider; this redaction only applies when a real provider
      // failed and we'd otherwise leak the token into log aggregators.
      this.logger.warn(
        `Email NOT delivered: tag=${template.tag} to=${to} subject="${template.subject}" provider=${primary.name} error="${errMessage}". Body redacted from logs to avoid leaking one-time tokens; if the user expected this mail, ask them to retry the originating action.`,
      );
      await this.recordSend(to, template, {
        status: 'failed',
        provider: primary.name,
        error: errMessage,
      });
      return null;
    }
  }

  /**
   * Best-effort delivery-log write (metadata only — never the body, which can
   * embed a one-time token). Failures here are swallowed with a warning: the
   * send itself is best-effort, and a log outage must never change what the
   * caller sees. No-ops when the repo isn't bound (unit tests).
   */
  private async recordSend(
    to: string,
    template: RenderedTemplate,
    outcome:
      | { status: 'sent'; provider: string; providerMessageId: string | null }
      | { status: 'failed'; provider: string; error: string },
  ): Promise<void> {
    if (!this.emailLog) return;
    // The account-deletion-completed receipt is sent AFTER `purgeUser` has
    // already deleted this recipient's email_log rows (and the user row). Logging
    // it would re-persist the just-deleted address with no user — and no future
    // purge — able to remove it, so this one receipt is deliberately not logged.
    if (template.tag === 'account-deletion-completed') return;
    try {
      await this.emailLog.insert({
        recipient: to.toLowerCase(),
        tag: template.tag,
        subject: this.loggableSubject(template).slice(0, 255),
        status: outcome.status,
        provider: outcome.provider,
        provider_message_id:
          outcome.status === 'sent' ? outcome.providerMessageId : null,
        error_class:
          outcome.status === 'failed' ? outcome.error.slice(0, 255) : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `email_log write failed: tag=${template.tag} status=${outcome.status} error="${msg}"`,
      );
    }
  }

  /**
   * The subject to persist in the recipient-keyed log. Most subjects are generic
   * or about the recipient, so they're safe. The trip-invite subject embeds the
   * INVITER's display name + trip title, though — third-party data relative to
   * the (possibly external) recipient this row is keyed on, which the inviter's
   * own account deletion could never purge. Store a generic subject for it so no
   * third party's data lingers in the log.
   */
  private loggableSubject(template: RenderedTemplate): string {
    if (template.tag === 'trip-invite') return 'Trip invitation';
    return template.subject;
  }

  private withBase<T>(ctx: T): T & { preferencesUrl: string } {
    return { ...ctx, preferencesUrl: this.preferencesUrl() };
  }

  private preferencesUrl(): string {
    const override = this.config
      .get<string>('TARMOTO_EMAIL_PREFERENCES_URL')
      ?.trim();
    if (override) return override;
    return `${getCompanionUrl(this.config)}/settings/notifications`;
  }

  private supportEmail(): string {
    // Truthy fallback (`||` not `??`): a blank or whitespace-only env
    // var would otherwise produce an empty `mailto:` link in the
    // password-changed and deletion-scheduled emails — exactly the
    // recovery surface where users need a working contact address.
    return (
      this.config.get<string>('TARMOTO_SUPPORT_EMAIL')?.trim() ||
      DEFAULT_SUPPORT_EMAIL
    );
  }

  private bulkHeaders(tag: EmailTag): Record<string, string> {
    // Gmail/Yahoo bulk-sender requirements: include a `List-Unsubscribe`
    // header pointing at a place where the user can manage receipts.
    // The companion `/settings/notifications` page is a real,
    // user-authenticated UI for this — mailbox providers treat the
    // URL form as a "click here to manage" link.
    //
    // We deliberately do NOT advertise `List-Unsubscribe-Post` /
    // RFC 8058 one-click unsubscribe yet: that requires a backend
    // POST endpoint that accepts an unauthenticated request from
    // mailbox providers, and we don't have one. Advertising it
    // without a working endpoint would hurt deliverability worse
    // than omitting it. Add the header back in the same change that
    // ships the `POST /unsubscribe?token=...` route.
    return {
      'List-Unsubscribe': `<${this.preferencesUrl()}>`,
      'X-Tarmoto-Email-Category': tag,
    };
  }
}
