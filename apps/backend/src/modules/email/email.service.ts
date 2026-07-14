import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DEFAULT_LOCALE,
  isEmailBlockDocument,
  type SupportedLocale,
} from '@tarmoto/shared';
import { EmailLog } from '../../entities/email-log.entity.js';
import { EmailTemplate } from '../../entities/email-template.entity.js';
import { getCompanionUrl } from '../../common/companion-url.js';
import {
  EMAIL_PROVIDER,
  type EmailProvider,
  type EmailSendResult,
} from './email-provider.js';
import { LogEmailProvider } from './providers/log.provider.js';
import {
  accountDeletionCompletedPresentation,
  accountDeletionScheduledPresentation,
  dataExportReadyPresentation,
  digestPresentation,
  subscriptionCancelledPresentation,
  subscriptionConfirmedPresentation,
  EDITABLE_TAGS,
  type EditableTag,
} from './presentation/index.js';
import { renderBlocks } from './render/render-blocks.js';
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

type ContextWithoutBase<T> = Omit<T, 'preferencesUrl' | 'locale'>;

/** Contexts of the 6 editable tags — each already carries `preferencesUrl` +
 * `locale` via `BaseContext` once run through `withBase`. */
type OverridableContext =
  | WeeklyDigestContext
  | SubscriptionConfirmedContext
  | SubscriptionCancelledContext
  | DataExportReadyContext
  | AccountDeletionScheduledContext
  | AccountDeletionCompletedContext;

// `EDITABLE_TAGS` is a `readonly EditableTag[]` (narrower than `EmailTag`);
// widen to `readonly string[]` so `.includes` accepts any `EmailTag`,
// including the locked ones this guard exists to reject.
function isEditableTag(tag: EmailTag): tag is EditableTag {
  return (EDITABLE_TAGS as readonly string[]).includes(tag);
}

/**
 * Strip control characters (CR, LF, other C0/C1 controls + DEL) from a subject
 * before it reaches the provider. A legitimate subject never contains them, but
 * every subject is interpolated raw — an admin-authored block-template var and a
 * user-controlled value (e.g. a display name, as in the trip-invite subject)
 * both flow in unescaped — so a CR/LF inside one of those values would, on a
 * raw-SMTP transport, smuggle extra headers. The current Resend HTTP transport
 * already treats the subject as inert JSON, but sanitizing at this dispatch
 * chokepoint keeps a future provider swap from silently reopening the hole —
 * the same "reject defensively on provider swap" rationale as the write-path
 * subject validator, here applied to the fully-rendered value.
 */
function sanitizeSubject(subject: string): string {
  return subject.replace(/\p{Cc}/gu, ' ');
}

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
    // Same rationale as `emailLog` above — optional so tests without the DB
    // layer still construct the service. Bound in production via the same
    // `TypeOrmModule.forFeature`.
    @Optional()
    @InjectRepository(EmailTemplate)
    private readonly emailTemplate: Repository<EmailTemplate> | null = null,
  ) {
    this.fallback = new LogEmailProvider();
  }

  /** Send an already-rendered email (used by the admin template editor's test-send). */
  async sendRendered(
    to: string,
    rendered: RenderedTemplate,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(to, rendered);
  }

  /** The notification-preferences URL used in email footers, exposed so the admin
   *  template preview/test-send renders the same footer chrome a real send would.
   *  Single source of truth — do NOT duplicate the URL logic in the template service. */
  resolvePreferencesUrl(): string {
    return this.preferencesUrl();
  }

  async sendVerification(
    to: string,
    ctx: ContextWithoutBase<VerificationContext>,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(to, verificationTemplate(this.withBase(ctx, locale)));
  }

  async sendPasswordReset(
    to: string,
    ctx: ContextWithoutBase<PasswordResetContext>,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(to, passwordResetTemplate(this.withBase(ctx, locale)));
  }

  async sendPasswordChanged(
    to: string,
    ctx: ContextWithoutBase<Omit<PasswordChangedContext, 'supportEmail'>>,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(
      to,
      passwordChangedTemplate(
        this.withBase({ ...ctx, supportEmail: this.supportEmail() }, locale),
      ),
    );
  }

  async sendSubscriptionConfirmed(
    to: string,
    ctx: ContextWithoutBase<SubscriptionConfirmedContext>,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<EmailSendResult | null> {
    const base = this.withBase(ctx, locale);
    const overridden = await this.renderOverride(
      'subscription-confirmed',
      base,
    );
    return this.dispatch(to, overridden ?? subscriptionConfirmedTemplate(base));
  }

  async sendSubscriptionCancelled(
    to: string,
    ctx: ContextWithoutBase<SubscriptionCancelledContext>,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<EmailSendResult | null> {
    const base = this.withBase(ctx, locale);
    const overridden = await this.renderOverride(
      'subscription-cancelled',
      base,
    );
    return this.dispatch(to, overridden ?? subscriptionCancelledTemplate(base));
  }

  async sendDataExportReady(
    to: string,
    ctx: ContextWithoutBase<DataExportReadyContext>,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<EmailSendResult | null> {
    const base = this.withBase(ctx, locale);
    const overridden = await this.renderOverride('data-export-ready', base);
    return this.dispatch(to, overridden ?? dataExportReadyTemplate(base));
  }

  async sendTripInvite(
    to: string,
    ctx: ContextWithoutBase<TripInviteContext>,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<EmailSendResult | null> {
    return this.dispatch(to, tripInviteTemplate(this.withBase(ctx, locale)));
  }

  async sendWeeklyDigest(
    to: string,
    ctx: ContextWithoutBase<WeeklyDigestContext>,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<EmailSendResult | null> {
    const base = this.withBase(ctx, locale);
    const overridden = await this.renderOverride('weekly-digest', base);
    return this.dispatch(to, overridden ?? weeklyDigestTemplate(base));
  }

  async sendAccountDeletionScheduled(
    to: string,
    ctx: ContextWithoutBase<
      Omit<AccountDeletionScheduledContext, 'supportEmail'>
    >,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<EmailSendResult | null> {
    const base = this.withBase(
      { ...ctx, supportEmail: this.supportEmail() },
      locale,
    );
    const overridden = await this.renderOverride(
      'account-deletion-scheduled',
      base,
    );
    return this.dispatch(
      to,
      overridden ?? accountDeletionScheduledTemplate(base),
    );
  }

  async sendAccountDeletionCompleted(
    to: string,
    ctx: ContextWithoutBase<
      Omit<AccountDeletionCompletedContext, 'supportEmail'>
    >,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<EmailSendResult | null> {
    const base = this.withBase(
      { ...ctx, supportEmail: this.supportEmail() },
      locale,
    );
    const overridden = await this.renderOverride(
      'account-deletion-completed',
      base,
    );
    return this.dispatch(
      to,
      overridden ?? accountDeletionCompletedTemplate(base),
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
      subject: sanitizeSubject(template.subject),
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
   * Admin-authored render override (admin email template editor, Phase 1).
   * For one of the 6 editable tags, looks up the single `published`
   * `EmailTemplate` row for `(tag, ctx.locale)` and — if it exists and is a
   * structurally valid `EmailBlockDocument` — renders it through the
   * code-owned block renderer instead of the code template. Locked tags
   * (verification, password-reset, trip-invite, password-changed) never
   * reach this from a `send*` method, but the guard below makes that
   * contractual rather than incidental on caller discipline.
   *
   * Every failure mode — no published row, an invalid doc, or any thrown
   * error (DB down, bad query, etc.) — resolves to `null` so the caller
   * falls back to the code template. An override LOOKUP must never block a
   * send; same rationale as `recordSend`'s best-effort `email_log` write.
   */
  private async renderOverride(
    tag: EmailTag,
    ctx: OverridableContext,
  ): Promise<RenderedTemplate | null> {
    try {
      if (!isEditableTag(tag) || !this.emailTemplate) return null;
      const row = await this.emailTemplate.findOne({
        where: { template_tag: tag, locale: ctx.locale, status: 'published' },
      });
      if (!row) return null;
      const doc = { subject: row.subject, blocks: row.blocks };
      if (!isEmailBlockDocument(doc)) return null;
      const { subject, html, text } = renderBlocks(
        doc,
        this.presentationFor(tag, ctx),
        {
          locale: ctx.locale,
          preferencesUrl: ctx.preferencesUrl,
          marketingFooter: tag === 'weekly-digest',
        },
      );
      return { subject, html, text, tag };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Email template override lookup failed: tag=${tag} locale=${ctx.locale} error="${msg}". Falling back to the code template.`,
      );
      return null;
    }
  }

  /** tag → presentation function dispatch (Task 3's `{ textVars, urlVars }`
   * shape). Each editable tag's presentation function takes a differently
   * shaped context, so this can't be a uniform record lookup — the switch is
   * exhaustive over `EditableTag`, so a new editable tag without a case here
   * is a compile error, not a silent no-op at render time. */
  private presentationFor(
    tag: EditableTag,
    ctx: OverridableContext,
  ): { textVars: Record<string, string>; urlVars: Record<string, string> } {
    switch (tag) {
      case 'weekly-digest':
        return digestPresentation(ctx as WeeklyDigestContext);
      case 'subscription-confirmed':
        return subscriptionConfirmedPresentation(
          ctx as SubscriptionConfirmedContext,
        );
      case 'subscription-cancelled':
        return subscriptionCancelledPresentation(
          ctx as SubscriptionCancelledContext,
        );
      case 'data-export-ready':
        return dataExportReadyPresentation(ctx as DataExportReadyContext);
      case 'account-deletion-scheduled':
        return accountDeletionScheduledPresentation(
          ctx as AccountDeletionScheduledContext,
        );
      case 'account-deletion-completed':
        return accountDeletionCompletedPresentation(
          ctx as AccountDeletionCompletedContext,
        );
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

  private withBase<T>(
    ctx: T,
    locale: SupportedLocale,
  ): T & { preferencesUrl: string; locale: SupportedLocale } {
    return { ...ctx, preferencesUrl: this.preferencesUrl(), locale };
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
