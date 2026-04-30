import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  type VerificationContext,
  accountDeletionCompletedTemplate,
  accountDeletionScheduledTemplate,
  dataExportReadyTemplate,
  passwordChangedTemplate,
  passwordResetTemplate,
  subscriptionCancelledTemplate,
  subscriptionConfirmedTemplate,
  verificationTemplate,
} from './templates/index.js';

const DEFAULT_SUPPORT_EMAIL = 'support@tarmoto.app';

type ContextWithoutBase<T> = Omit<T, 'preferencesUrl'>;

/**
 * Public surface for every place in the backend that needs to send a
 * transactional email. Wraps:
 *
 *   - rendering: caller supplies typed context, service injects shared
 *     base fields (preferences URL, etc.) and runs the template.
 *   - dispatch: hands off to the configured `EmailProvider`. On
 *     transport failure, falls back to the always-available
 *     `LogEmailProvider` so the message is at least captured for ops.
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
   * captures the message via the log fallback so a transient SES /
   * Resend outage doesn't silently drop verification or reset mail.
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
      return result;
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Primary email provider (${primary.name}) failed sending ${template.tag} to ${to}: ${errMessage}. Falling back to log provider.`,
      );

      // If the primary IS the log provider, no point falling back.
      if (primary === this.fallback) {
        return null;
      }

      try {
        return await this.fallback.send(message);
      } catch (fallbackErr) {
        this.logger.error(
          `Fallback log provider also failed for ${template.tag} to ${to}: ${
            fallbackErr instanceof Error
              ? fallbackErr.message
              : String(fallbackErr)
          }`,
        );
        return null;
      }
    }
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
    return (
      this.config.get<string>('TARMOTO_SUPPORT_EMAIL')?.trim() ??
      DEFAULT_SUPPORT_EMAIL
    );
  }

  private bulkHeaders(tag: EmailTag): Record<string, string> {
    // Gmail/Yahoo bulk-sender requirements: include a List-Unsubscribe
    // header on every transactional message even when the body skips
    // the marketing unsubscribe link. Pointing at the preferences page
    // gives a single canonical place for users to manage receipts.
    return {
      'List-Unsubscribe': `<${this.preferencesUrl()}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Tarmoto-Email-Category': tag,
    };
  }
}
