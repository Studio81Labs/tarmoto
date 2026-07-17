import {
  type SupportedLocale,
  type TranslationValues,
  type UnitSystem,
} from '@tarmoto/shared';
import { translateEmail, type EmailMessageKey } from '../i18n/index.js';
import { escapeHtml, renderLayout, renderTextFooter } from './layout.js';
import {
  accountDeletionCompletedPresentation,
  accountDeletionScheduledPresentation,
  dataExportReadyPresentation,
  digestPresentation,
  subscriptionCancelledPresentation,
  subscriptionConfirmedPresentation,
} from '../presentation/index.js';

/**
 * Each entry rendered into the same `{ subject, html, text }`
 * envelope. Templates are pure functions of their typed context — no
 * runtime template engine, no file IO. The trade-off: less
 * designer-friendly, but every template is type-checked end-to-end so
 * a missing field is a compile error instead of an empty string in a
 * customer's inbox.
 *
 * i18n hook: each context can grow a `locale` field. Templates use the
 * shared `makeTranslator` with ICU plural formatting. Adding a new locale
 * requires providing translated catalogs via the i18n module.
 */

export type EmailTag =
  | 'verification'
  | 'password-reset'
  | 'password-changed'
  | 'subscription-confirmed'
  | 'subscription-cancelled'
  | 'data-export-ready'
  | 'account-deletion-scheduled'
  | 'account-deletion-completed'
  | 'trip-invite'
  | 'weekly-digest';

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
  tag: EmailTag;
}

interface BaseContext {
  preferencesUrl: string;
  locale: SupportedLocale;
}

export interface VerificationContext extends BaseContext {
  displayName: string;
  verifyUrl: string;
  expiresInHours: number;
}

export const verificationTemplate = (
  ctx: VerificationContext,
): RenderedTemplate => {
  const t = (k: EmailMessageKey, v?: TranslationValues): string =>
    translateEmail(k, v, ctx.locale);
  const greeting = ctx.displayName
    ? t('common.greeting.named', { name: ctx.displayName }) // text: raw name
    : t('common.greeting.anon');
  const greetingHtml = ctx.displayName
    ? t('common.greeting.named', { name: escapeHtml(ctx.displayName) })
    : t('common.greeting.anon');
  const subject = t('verification.subject');

  const text = `${greeting}

${t('verification.text.intro')}

${t('verification.text.confirmLine')}

${ctx.verifyUrl}

${t('verification.expiry', { hours: ctx.expiresInHours })}${renderTextFooter(ctx.preferencesUrl, false, ctx.locale)}`;

  const html = renderLayout({
    preheader: t('verification.preheader'),
    preferencesUrl: ctx.preferencesUrl,
    locale: ctx.locale,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('verification.html.welcome')}</p>
      <p style="margin:32px 0;">
        <a href="${escapeHtml(ctx.verifyUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${t('verification.button')}</a>
      </p>
      <p style="color:#94a3b8;font-size:13px;">${t('common.html.pasteLink')}<br/><a href="${escapeHtml(ctx.verifyUrl)}" style="color:#06b6d4;word-break:break-all;">${escapeHtml(ctx.verifyUrl)}</a></p>
      <p style="color:#94a3b8;font-size:13px;">${t('verification.expiry', { hours: ctx.expiresInHours })}</p>
    `,
  });

  return { subject, html, text, tag: 'verification' };
};

export interface PasswordResetContext extends BaseContext {
  displayName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export const passwordResetTemplate = (
  ctx: PasswordResetContext,
): RenderedTemplate => {
  const t = (k: EmailMessageKey, v?: TranslationValues): string =>
    translateEmail(k, v, ctx.locale);
  const greeting = ctx.displayName
    ? t('common.greeting.named', { name: ctx.displayName })
    : t('common.greeting.anon');
  const greetingHtml = ctx.displayName
    ? t('common.greeting.named', { name: escapeHtml(ctx.displayName) })
    : t('common.greeting.anon');
  const subject = t('passwordReset.subject');

  const text = `${greeting}

${t('passwordReset.text.intro')}

${ctx.resetUrl}

${t('passwordReset.expiryText', { minutes: ctx.expiresInMinutes })}${renderTextFooter(ctx.preferencesUrl, false, ctx.locale)}`;

  const html = renderLayout({
    preheader: t('passwordReset.preheader'),
    preferencesUrl: ctx.preferencesUrl,
    locale: ctx.locale,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('passwordReset.html.intro')}</p>
      <p style="margin:32px 0;">
        <a href="${escapeHtml(ctx.resetUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${t('passwordReset.button')}</a>
      </p>
      <p style="color:#94a3b8;font-size:13px;">${t('passwordReset.expiryHtml', { minutes: ctx.expiresInMinutes })}</p>
      <p style="color:#94a3b8;font-size:13px;">${t('passwordReset.noRequest')}</p>
    `,
  });

  return { subject, html, text, tag: 'password-reset' };
};

export interface PasswordChangedContext extends BaseContext {
  displayName: string;
  supportEmail: string;
  changedAt: Date;
}

export const passwordChangedTemplate = (
  ctx: PasswordChangedContext,
): RenderedTemplate => {
  const t = (k: EmailMessageKey, v?: TranslationValues): string =>
    translateEmail(k, v, ctx.locale);
  const subject = t('passwordChanged.subject');
  const when = ctx.changedAt.toUTCString();
  const greeting = ctx.displayName
    ? t('common.greeting.named', { name: ctx.displayName })
    : t('common.greeting.anon');
  const greetingHtml = ctx.displayName
    ? t('common.greeting.named', { name: escapeHtml(ctx.displayName) })
    : t('common.greeting.anon');
  const text = `${greeting}

${t('passwordChanged.text.body', { when })}

${t('passwordChanged.text.contact', { email: ctx.supportEmail })}${renderTextFooter(ctx.preferencesUrl, false, ctx.locale)}`;

  const html = renderLayout({
    preheader: t('passwordChanged.preheader'),
    preferencesUrl: ctx.preferencesUrl,
    locale: ctx.locale,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('passwordChanged.html.changed')}</p>
      <p style="color:#94a3b8;font-size:13px;">${t('passwordChanged.when', { when: escapeHtml(when) })}</p>
      <p>${t('passwordChanged.html.ifYou')}</p>
      <p style="color:#fca5a5;">${t('passwordChanged.html.contact', {
        // already-escaped HTML fragment — do not re-escape
        emailLink: `<a href="mailto:${escapeHtml(ctx.supportEmail)}" style="color:#06b6d4;">${escapeHtml(ctx.supportEmail)}</a>`,
      })}</p>
    `,
  });

  return { subject, html, text, tag: 'password-changed' };
};

export interface SubscriptionConfirmedContext extends BaseContext {
  displayName: string;
  planName: string;
  priceLabel: string;
  renewsAt: Date | null;
  manageBillingUrl: string;
}

export const subscriptionConfirmedTemplate = (
  ctx: SubscriptionConfirmedContext,
): RenderedTemplate => {
  const t = (k: EmailMessageKey, v?: TranslationValues): string =>
    translateEmail(k, v, ctx.locale);
  const presentation = subscriptionConfirmedPresentation(ctx);
  const { displayName, planName, priceLabel, renewsText, renewsDate } =
    presentation.textVars;
  const { manageBillingUrl } = presentation.urlVars;
  const subject = t('subscriptionConfirmed.subject', { plan: planName });
  const greeting = displayName
    ? t('common.greeting.named', { name: displayName })
    : t('common.greeting.anon');
  const greetingHtml = displayName
    ? t('common.greeting.named', { name: escapeHtml(displayName) })
    : t('common.greeting.anon');
  const text = `${greeting}

${t('subscriptionConfirmed.text.welcome', { plan: planName })}

${t('subscriptionConfirmed.table.plan')}: ${planName}
${t('subscriptionConfirmed.table.price')}: ${priceLabel}
${renewsText}

${t('subscriptionConfirmed.text.manageIntro')}: ${manageBillingUrl}${renderTextFooter(ctx.preferencesUrl, false, ctx.locale)}`;

  const html = renderLayout({
    preheader: t('subscriptionConfirmed.preheader', { plan: planName }),
    preferencesUrl: ctx.preferencesUrl,
    locale: ctx.locale,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('subscriptionConfirmed.welcome', { plan: escapeHtml(planName) })}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;border:1px solid #334155;border-radius:8px;">
        <tr><td style="padding:12px 16px;color:#94a3b8;">${t('subscriptionConfirmed.table.plan')}</td><td style="padding:12px 16px;text-align:right;"><strong>${escapeHtml(planName)}</strong></td></tr>
        <tr><td style="padding:12px 16px;color:#94a3b8;border-top:1px solid #334155;">${t('subscriptionConfirmed.table.price')}</td><td style="padding:12px 16px;text-align:right;border-top:1px solid #334155;"><strong>${escapeHtml(priceLabel)}</strong></td></tr>
        ${renewsDate ? `<tr><td style="padding:12px 16px;color:#94a3b8;border-top:1px solid #334155;">${t('subscriptionConfirmed.table.renewal')}</td><td style="padding:12px 16px;text-align:right;border-top:1px solid #334155;"><strong>${escapeHtml(renewsDate)}</strong></td></tr>` : ''}
      </table>
      <p style="margin:24px 0;">
        <a href="${escapeHtml(manageBillingUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${t('subscriptionConfirmed.manageButton')}</a>
      </p>
    `,
  });

  return { subject, html, text, tag: 'subscription-confirmed' };
};

export interface SubscriptionCancelledContext extends BaseContext {
  displayName: string;
  planName: string;
  endsAt: Date | null;
  resubscribeUrl: string;
}

export const subscriptionCancelledTemplate = (
  ctx: SubscriptionCancelledContext,
): RenderedTemplate => {
  const t = (k: EmailMessageKey, v?: TranslationValues): string =>
    translateEmail(k, v, ctx.locale);
  const presentation = subscriptionCancelledPresentation(ctx);
  const { displayName, planName, accessText } = presentation.textVars;
  const { resubscribeUrl } = presentation.urlVars;
  const subject = t('subscriptionCancelled.subject', { plan: planName });
  const greeting = displayName
    ? t('common.greeting.named', { name: displayName })
    : t('common.greeting.anon');
  const greetingHtml = displayName
    ? t('common.greeting.named', { name: escapeHtml(displayName) })
    : t('common.greeting.anon');
  const text = `${greeting}

${t('subscriptionCancelled.text.cancelled', { plan: planName })}

${accessText}

${t('subscriptionCancelled.text.resubscribeIntro')}: ${resubscribeUrl}${renderTextFooter(ctx.preferencesUrl, false, ctx.locale)}`;

  const html = renderLayout({
    preheader: t('subscriptionCancelled.preheader', { plan: planName }),
    preferencesUrl: ctx.preferencesUrl,
    locale: ctx.locale,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('subscriptionCancelled.html.cancelled', { plan: escapeHtml(planName) })}</p>
      <p>${escapeHtml(accessText)}</p>
      <p style="margin:24px 0;">
        <a href="${escapeHtml(resubscribeUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${t('subscriptionCancelled.resubscribeButton')}</a>
      </p>
    `,
  });

  return { subject, html, text, tag: 'subscription-cancelled' };
};

export interface DataExportReadyContext extends BaseContext {
  displayName: string;
  downloadUrl: string;
  expiresAt: Date;
}

export const dataExportReadyTemplate = (
  ctx: DataExportReadyContext,
): RenderedTemplate => {
  const t = (k: EmailMessageKey, v?: TranslationValues): string =>
    translateEmail(k, v, ctx.locale);
  const presentation = dataExportReadyPresentation(ctx);
  const { displayName, expiresText } = presentation.textVars;
  const { downloadUrl } = presentation.urlVars;
  const subject = t('dataExportReady.subject');
  const greeting = displayName
    ? t('common.greeting.named', { name: displayName })
    : t('common.greeting.anon');
  const greetingHtml = displayName
    ? t('common.greeting.named', { name: escapeHtml(displayName) })
    : t('common.greeting.anon');
  const text = `${greeting}

${t('dataExportReady.text.ready')}

${downloadUrl}

${t('dataExportReady.text.expiry', { date: expiresText })}${renderTextFooter(ctx.preferencesUrl, false, ctx.locale)}`;

  const html = renderLayout({
    preheader: t('dataExportReady.preheader'),
    preferencesUrl: ctx.preferencesUrl,
    locale: ctx.locale,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('dataExportReady.html.ready')}</p>
      <p style="margin:24px 0;">
        <a href="${escapeHtml(downloadUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${t('dataExportReady.button')}</a>
      </p>
      <p style="color:#94a3b8;font-size:13px;">${t('dataExportReady.html.expiry', { date: escapeHtml(expiresText) })}</p>
    `,
  });

  return { subject, html, text, tag: 'data-export-ready' };
};

export interface AccountDeletionScheduledContext extends BaseContext {
  displayName: string;
  scheduledFor: Date;
  supportEmail: string;
}

export const accountDeletionScheduledTemplate = (
  ctx: AccountDeletionScheduledContext,
): RenderedTemplate => {
  const t = (k: EmailMessageKey, v?: TranslationValues): string =>
    translateEmail(k, v, ctx.locale);
  const presentation = accountDeletionScheduledPresentation(ctx);
  const { displayName, scheduledDate, supportEmail } = presentation.textVars;
  const subject = t('accountDeletionScheduled.subject');
  const greeting = displayName
    ? t('common.greeting.named', { name: displayName })
    : t('common.greeting.anon');
  const greetingHtml = displayName
    ? t('common.greeting.named', { name: escapeHtml(displayName) })
    : t('common.greeting.anon');
  // Restoration during the grace window is support-only: a soft-
  // deleted account is locked out of /auth/login and /auth/refresh
  // (see AuthService — `deleted_at != null` rejects with the same
  // "invalid credentials" message as wrong passwords). Earlier copy
  // promised "sign back in to restore" which always failed; users
  // were sent to a path that quietly drops them. Direct them to
  // support instead so they can actually exercise the right of
  // restoration the GDPR grace window grants.
  const text = `${greeting}

${t('accountDeletionScheduled.text.scheduled', { date: scheduledDate })}

${t('accountDeletionScheduled.text.changedMind', { email: supportEmail })} ${t('accountDeletionScheduled.graceWindow')}

${t('accountDeletionScheduled.afterDate')}${renderTextFooter(ctx.preferencesUrl, false, ctx.locale)}`;

  const html = renderLayout({
    preheader: t('accountDeletionScheduled.preheader', {
      date: scheduledDate,
    }),
    preferencesUrl: ctx.preferencesUrl,
    locale: ctx.locale,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('accountDeletionScheduled.html.scheduled', { date: escapeHtml(scheduledDate) })}</p>
      <p>${t('accountDeletionScheduled.html.changedMind', {
        // already-escaped HTML fragment — do not re-escape
        emailLink: `<a href="mailto:${escapeHtml(supportEmail)}" style="color:#06b6d4;">${escapeHtml(supportEmail)}</a>`,
      })}</p>
      <p style="color:#94a3b8;font-size:13px;">${t('accountDeletionScheduled.graceWindow')}</p>
      <p style="color:#94a3b8;font-size:13px;">${t('accountDeletionScheduled.afterDate')}</p>
    `,
  });

  return { subject, html, text, tag: 'account-deletion-scheduled' };
};

export interface TripInviteContext extends BaseContext {
  inviterDisplayName: string;
  tripTitle: string;
  joinUrl: string;
  inviteCode: string;
  message: string | null;
}

export const tripInviteTemplate = (
  ctx: TripInviteContext,
): RenderedTemplate => {
  const t = (k: EmailMessageKey, v?: TranslationValues): string =>
    translateEmail(k, v, ctx.locale);
  // Trip invites always greet an unauthenticated recipient — there's no
  // displayName on this context, so it's the anon greeting, always.
  const greeting = t('common.greeting.anon');
  const subject = t('tripInvite.subject', {
    inviter: ctx.inviterDisplayName, // subject is plain text — raw, not HTML-escaped
    trip: ctx.tripTitle,
  });
  const intro = t('tripInvite.intro', {
    inviter: ctx.inviterDisplayName,
    trip: ctx.tripTitle,
  });
  const introHtml = t('tripInvite.intro', {
    inviter: escapeHtml(ctx.inviterDisplayName),
    trip: escapeHtml(ctx.tripTitle),
  });
  const messageBlock = ctx.message
    ? `\n\n${t('tripInvite.text.messageBlock', { inviter: ctx.inviterDisplayName })}\n${ctx.message}\n`
    : '';
  const text = `${greeting}

${intro}${messageBlock}

${t('tripInvite.text.openLine')}

${ctx.joinUrl}

${t('tripInvite.text.codeLine', { code: ctx.inviteCode })}

${t('tripInvite.text.noAccount')}${renderTextFooter(ctx.preferencesUrl, false, ctx.locale)}`;

  const html = renderLayout({
    preheader: t('tripInvite.preheader', {
      inviter: ctx.inviterDisplayName,
      trip: ctx.tripTitle,
    }),
    preferencesUrl: ctx.preferencesUrl,
    locale: ctx.locale,
    bodyHtml: `
      <p>${greeting}</p>
      <p>${introHtml}</p>
      ${
        ctx.message
          ? `<blockquote style="margin:24px 0;padding:12px 16px;border-left:3px solid #06b6d4;color:#cbd5e1;background:#0f172a;border-radius:4px;">${escapeHtml(ctx.message)}</blockquote>`
          : ''
      }
      <p style="margin:32px 0;">
        <a href="${escapeHtml(ctx.joinUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${t('tripInvite.button')}</a>
      </p>
      <p style="color:#94a3b8;font-size:13px;">${t('common.html.pasteLink')}<br/><a href="${escapeHtml(ctx.joinUrl)}" style="color:#06b6d4;word-break:break-all;">${escapeHtml(ctx.joinUrl)}</a></p>
      <p style="color:#94a3b8;font-size:13px;">${t('tripInvite.inviteCodeHtml', { code: escapeHtml(ctx.inviteCode) })}</p>
      <p style="color:#94a3b8;font-size:13px;">${t('tripInvite.noAccountHtml')}</p>
    `,
  });

  return { subject, html, text, tag: 'trip-invite' };
};

export interface WeeklyDigestContext extends BaseContext {
  displayName: string;
  /** Completed rides in the window (guaranteed > 0 — empty weeks aren't sent). */
  rideCount: number;
  totalKm: number;
  totalMinutes: number;
  /** Best avg road quality (0–5) across the window's rides, or null. */
  bestQuality: number | null;
  percentExplored: number;
  riddenSegments: number;
  units: UnitSystem;
  exploreUrl: string;
}

export const weeklyDigestTemplate = (
  ctx: WeeklyDigestContext,
): RenderedTemplate => {
  const t = (k: EmailMessageKey, v?: TranslationValues): string =>
    translateEmail(k, v, ctx.locale);
  const presentation = digestPresentation(ctx);
  const {
    displayName,
    rideCount,
    rideSummary,
    distance,
    duration,
    quality,
    riddenSegments,
    percentExplored,
  } = presentation.textVars;
  const { exploreUrl } = presentation.urlVars;
  const greeting = displayName
    ? t('common.greeting.named', { name: displayName })
    : t('common.greeting.anon');
  const greetingHtml = displayName
    ? t('common.greeting.named', { name: escapeHtml(displayName) })
    : t('common.greeting.anon');
  const subject = t('digest.subject', { rideSummary, distance });
  // Shared stem for the line right after the greeting — text appends ":"
  // (it introduces the bullet list below), html appends "." (standalone
  // sentence ahead of the table).
  const weekLead = t('digest.greeting.lead');

  const text = `${greeting}

${weekLead}:

  • ${rideSummary}
  • ${t('digest.text.distanceRidden', { distance })}
  • ${t('digest.text.timeInSaddle', { duration })}${quality ? `\n  • ${t('digest.row.quality')}: ${quality}` : ''}

${t('digest.intro', { segments: riddenSegments, percentExplored })}

${t('digest.button')}:
${exploreUrl}${renderTextFooter(ctx.preferencesUrl, true, ctx.locale)}`;

  const row = (label: string, value: string): string => `
      <tr>
        <td style="padding:6px 0;color:#94a3b8;font-size:14px;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#f8fafc;font-size:16px;font-weight:600;text-align:right;">${escapeHtml(value)}</td>
      </tr>`;

  const html = renderLayout({
    preheader: t('digest.preheader', { rideSummary, distance }),
    preferencesUrl: ctx.preferencesUrl,
    locale: ctx.locale,
    marketingFooter: true,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${weekLead}.</p>
      <table role="presentation" width="100%" style="margin:20px 0;border-collapse:collapse;">
        ${row(t('digest.row.rides'), rideCount)}
        ${row(t('digest.row.distance'), distance)}
        ${row(t('digest.row.time'), duration)}
        ${quality ? row(t('digest.row.quality'), quality) : ''}
      </table>
      <p style="color:#cbd5e1;">${t('digest.explored', { segments: riddenSegments, percentExplored })}</p>
      <p style="margin:32px 0;">
        <a href="${escapeHtml(exploreUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${t('digest.button')}</a>
      </p>
    `,
  });

  return { subject, html, text, tag: 'weekly-digest' };
};

export interface AccountDeletionCompletedContext extends BaseContext {
  displayName: string;
  deletedAt: Date;
  supportEmail: string;
}

export const accountDeletionCompletedTemplate = (
  ctx: AccountDeletionCompletedContext,
): RenderedTemplate => {
  const t = (k: EmailMessageKey, v?: TranslationValues): string =>
    translateEmail(k, v, ctx.locale);
  const presentation = accountDeletionCompletedPresentation(ctx);
  const { displayName, deletedDate, supportEmail } = presentation.textVars;
  const subject = t('accountDeletionCompleted.subject');
  const greeting = displayName
    ? t('common.greeting.named', { name: displayName })
    : t('common.greeting.anon');
  const greetingHtml = displayName
    ? t('common.greeting.named', { name: escapeHtml(displayName) })
    : t('common.greeting.anon');
  const text = `${greeting}

${t('accountDeletionCompleted.text.deleted', { date: deletedDate })}

${t('accountDeletionCompleted.erased')}

${t('accountDeletionCompleted.text.contact', { email: supportEmail })}${renderTextFooter(ctx.preferencesUrl, false, ctx.locale)}`;

  const html = renderLayout({
    preheader: t('accountDeletionCompleted.preheader'),
    preferencesUrl: ctx.preferencesUrl,
    locale: ctx.locale,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('accountDeletionCompleted.html.deleted', { date: escapeHtml(deletedDate) })}</p>
      <p>${t('accountDeletionCompleted.erased')}</p>
      <p style="color:#94a3b8;font-size:13px;">${t(
        'accountDeletionCompleted.html.contact',
        {
          // already-escaped HTML fragment — do not re-escape
          emailLink: `<a href="mailto:${escapeHtml(supportEmail)}" style="color:#06b6d4;">${escapeHtml(supportEmail)}</a>`,
        },
      )}</p>
    `,
  });

  return { subject, html, text, tag: 'account-deletion-completed' };
};
