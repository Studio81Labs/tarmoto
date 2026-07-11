import {
  formatDistance,
  type SupportedLocale,
  type TranslationValues,
  type UnitSystem,
} from '@tarmoto/shared';
import { translateEmail, type EmailMessageKey } from '../i18n/index.js';
import { escapeHtml, renderLayout, renderTextFooter } from './layout.js';

/**
 * Each entry rendered into the same `{ subject, html, text }`
 * envelope. Templates are pure functions of their typed context — no
 * runtime template engine, no file IO. The trade-off: less
 * designer-friendly, but every template is type-checked end-to-end so
 * a missing field is a compile error instead of an empty string in a
 * customer's inbox.
 *
 * i18n hook: each context can grow a `locale` field. We start with
 * English-only and pick a real i18n library when the second locale
 * lands — premature abstraction would lock us into the wrong shape.
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

${t('verification.expiry', { hours: ctx.expiresInHours })}${renderTextFooter(ctx.preferencesUrl)}`;

  const html = renderLayout({
    preheader: t('verification.preheader'),
    preferencesUrl: ctx.preferencesUrl,
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

${t('passwordReset.expiryText', { minutes: ctx.expiresInMinutes })}${renderTextFooter(ctx.preferencesUrl)}`;

  const html = renderLayout({
    preheader: t('passwordReset.preheader'),
    preferencesUrl: ctx.preferencesUrl,
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

${t('passwordChanged.text.contact', { email: ctx.supportEmail })}${renderTextFooter(ctx.preferencesUrl)}`;

  const html = renderLayout({
    preheader: t('passwordChanged.preheader'),
    preferencesUrl: ctx.preferencesUrl,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('passwordChanged.html.changed')}</p>
      <p style="color:#94a3b8;font-size:13px;">${t('passwordChanged.when', { when: escapeHtml(when) })}</p>
      <p>${t('passwordChanged.html.ifYou')}</p>
      <p style="color:#fca5a5;">${t('passwordChanged.html.contact', {
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
  const subject = t('subscriptionConfirmed.subject', { plan: ctx.planName });
  const renews = ctx.renewsAt
    ? t('subscriptionConfirmed.text.renews', {
        date: ctx.renewsAt.toUTCString(),
      })
    : t('subscriptionConfirmed.text.noRenew');
  const greeting = ctx.displayName
    ? t('common.greeting.named', { name: ctx.displayName })
    : t('common.greeting.anon');
  const greetingHtml = ctx.displayName
    ? t('common.greeting.named', { name: escapeHtml(ctx.displayName) })
    : t('common.greeting.anon');
  const text = `${greeting}

${t('subscriptionConfirmed.text.welcome', { plan: ctx.planName })}

${t('subscriptionConfirmed.table.plan')}: ${ctx.planName}
${t('subscriptionConfirmed.table.price')}: ${ctx.priceLabel}
${renews}

${t('subscriptionConfirmed.text.manageIntro')}: ${ctx.manageBillingUrl}${renderTextFooter(ctx.preferencesUrl)}`;

  const html = renderLayout({
    preheader: t('subscriptionConfirmed.preheader', { plan: ctx.planName }),
    preferencesUrl: ctx.preferencesUrl,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('subscriptionConfirmed.welcome', { plan: escapeHtml(ctx.planName) })}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;border:1px solid #334155;border-radius:8px;">
        <tr><td style="padding:12px 16px;color:#94a3b8;">${t('subscriptionConfirmed.table.plan')}</td><td style="padding:12px 16px;text-align:right;"><strong>${escapeHtml(ctx.planName)}</strong></td></tr>
        <tr><td style="padding:12px 16px;color:#94a3b8;border-top:1px solid #334155;">${t('subscriptionConfirmed.table.price')}</td><td style="padding:12px 16px;text-align:right;border-top:1px solid #334155;"><strong>${escapeHtml(ctx.priceLabel)}</strong></td></tr>
        ${ctx.renewsAt ? `<tr><td style="padding:12px 16px;color:#94a3b8;border-top:1px solid #334155;">${t('subscriptionConfirmed.table.renewal')}</td><td style="padding:12px 16px;text-align:right;border-top:1px solid #334155;"><strong>${escapeHtml(ctx.renewsAt.toUTCString())}</strong></td></tr>` : ''}
      </table>
      <p style="margin:24px 0;">
        <a href="${escapeHtml(ctx.manageBillingUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${t('subscriptionConfirmed.manageButton')}</a>
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
  const subject = t('subscriptionCancelled.subject', { plan: ctx.planName });
  const accessLine = ctx.endsAt
    ? t('subscriptionCancelled.accessKept', {
        plan: ctx.planName,
        date: ctx.endsAt.toUTCString(),
      })
    : t('subscriptionCancelled.accessEnded', { plan: ctx.planName });
  const greeting = ctx.displayName
    ? t('common.greeting.named', { name: ctx.displayName })
    : t('common.greeting.anon');
  const greetingHtml = ctx.displayName
    ? t('common.greeting.named', { name: escapeHtml(ctx.displayName) })
    : t('common.greeting.anon');
  const text = `${greeting}

${t('subscriptionCancelled.text.cancelled', { plan: ctx.planName })}

${accessLine}

${t('subscriptionCancelled.text.resubscribeIntro')}: ${ctx.resubscribeUrl}${renderTextFooter(ctx.preferencesUrl)}`;

  const html = renderLayout({
    preheader: t('subscriptionCancelled.preheader', { plan: ctx.planName }),
    preferencesUrl: ctx.preferencesUrl,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('subscriptionCancelled.html.cancelled', { plan: escapeHtml(ctx.planName) })}</p>
      <p>${escapeHtml(accessLine)}</p>
      <p style="margin:24px 0;">
        <a href="${escapeHtml(ctx.resubscribeUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${t('subscriptionCancelled.resubscribeButton')}</a>
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
  const subject = t('dataExportReady.subject');
  const greeting = ctx.displayName
    ? t('common.greeting.named', { name: ctx.displayName })
    : t('common.greeting.anon');
  const greetingHtml = ctx.displayName
    ? t('common.greeting.named', { name: escapeHtml(ctx.displayName) })
    : t('common.greeting.anon');
  const text = `${greeting}

${t('dataExportReady.text.ready')}

${ctx.downloadUrl}

${t('dataExportReady.text.expiry', { date: ctx.expiresAt.toUTCString() })}${renderTextFooter(ctx.preferencesUrl)}`;

  const html = renderLayout({
    preheader: t('dataExportReady.preheader'),
    preferencesUrl: ctx.preferencesUrl,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t('dataExportReady.html.ready')}</p>
      <p style="margin:24px 0;">
        <a href="${escapeHtml(ctx.downloadUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${t('dataExportReady.button')}</a>
      </p>
      <p style="color:#94a3b8;font-size:13px;">${t('dataExportReady.html.expiry', { date: escapeHtml(ctx.expiresAt.toUTCString()) })}</p>
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
  const subject = 'Your Tarmoto account is scheduled for deletion';
  const greeting = ctx.displayName ? `Hi ${ctx.displayName},` : 'Hi there,';
  // Restoration during the grace window is support-only: a soft-
  // deleted account is locked out of /auth/login and /auth/refresh
  // (see AuthService — `deleted_at != null` rejects with the same
  // "invalid credentials" message as wrong passwords). Earlier copy
  // promised "sign back in to restore" which always failed; users
  // were sent to a path that quietly drops them. Direct them to
  // support instead so they can actually exercise the right of
  // restoration the GDPR grace window grants.
  const text = `${greeting}

Your Tarmoto account is scheduled for permanent deletion on ${ctx.scheduledFor.toUTCString()}.

Changed your mind? Email ${ctx.supportEmail} before that date and our team will restore your account. Self-service restore from the app isn't possible during the grace window — the account is locked from sign-in until it's either restored by support or permanently erased.

After the scheduled date, your personal data will be permanently erased. Anonymized road-quality contributions will remain in the community dataset.${renderTextFooter(ctx.preferencesUrl)}`;

  const html = renderLayout({
    preheader: `Your account will be permanently deleted on ${ctx.scheduledFor.toUTCString()}.`,
    preferencesUrl: ctx.preferencesUrl,
    bodyHtml: `
      <p>${escapeHtml(greeting)}</p>
      <p>Your Tarmoto account is scheduled for <strong>permanent deletion</strong> on ${escapeHtml(ctx.scheduledFor.toUTCString())}.</p>
      <p>Changed your mind? Email <a href="mailto:${escapeHtml(ctx.supportEmail)}" style="color:#06b6d4;">${escapeHtml(ctx.supportEmail)}</a> before that date and our team will restore your account.</p>
      <p style="color:#94a3b8;font-size:13px;">Self-service restore from the app isn't possible during the grace window — the account is locked from sign-in until it's either restored by support or permanently erased.</p>
      <p style="color:#94a3b8;font-size:13px;">After the scheduled date, your personal data will be permanently erased. Anonymized road-quality contributions will remain in the community dataset.</p>
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
  const subject = `${ctx.inviterDisplayName} invited you to plan "${ctx.tripTitle}" on Tarmoto`;
  const intro = `${ctx.inviterDisplayName} invited you to collaborate on a Tarmoto trip: ${ctx.tripTitle}.`;
  const messageBlock = ctx.message
    ? `\n\nMessage from ${ctx.inviterDisplayName}:\n${ctx.message}\n`
    : '';
  const text = `Hi there,

${intro}${messageBlock}

Open the trip planner to accept the invite:

${ctx.joinUrl}

If the link doesn't open automatically, sign in to Tarmoto and enter this invite code on the join screen: ${ctx.inviteCode}

If you don't have a Tarmoto account yet, you can create one with this email and the invite will be waiting for you.${renderTextFooter(ctx.preferencesUrl)}`;

  const html = renderLayout({
    preheader: `${ctx.inviterDisplayName} invited you to "${ctx.tripTitle}".`,
    preferencesUrl: ctx.preferencesUrl,
    bodyHtml: `
      <p>Hi there,</p>
      <p>${escapeHtml(intro)}</p>
      ${
        ctx.message
          ? `<blockquote style="margin:24px 0;padding:12px 16px;border-left:3px solid #06b6d4;color:#cbd5e1;background:#0f172a;border-radius:4px;">${escapeHtml(ctx.message)}</blockquote>`
          : ''
      }
      <p style="margin:32px 0;">
        <a href="${escapeHtml(ctx.joinUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">Open trip in Tarmoto</a>
      </p>
      <p style="color:#94a3b8;font-size:13px;">Or paste this link in your browser:<br/><a href="${escapeHtml(ctx.joinUrl)}" style="color:#06b6d4;word-break:break-all;">${escapeHtml(ctx.joinUrl)}</a></p>
      <p style="color:#94a3b8;font-size:13px;">Invite code (in case the link doesn't open): <strong style="color:#f8fafc;">${escapeHtml(ctx.inviteCode)}</strong></p>
      <p style="color:#94a3b8;font-size:13px;">Don't have a Tarmoto account? Sign up with this email and the invite will be waiting for you.</p>
    `,
  });

  return { subject, html, text, tag: 'trip-invite' };
};

/** "2h 15m" / "45m" from a raw minute count. */
function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return h > 0 ? `${h}h ${rem}m` : `${rem}m`;
}

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
  const greeting = ctx.displayName ? `Hi ${ctx.displayName},` : 'Hi there,';
  const distance = formatDistance(ctx.totalKm, ctx.units);
  const duration = formatDuration(ctx.totalMinutes);
  const rideWord = ctx.rideCount === 1 ? 'ride' : 'rides';
  const quality =
    ctx.bestQuality != null ? `${ctx.bestQuality.toFixed(1)} / 5` : null;
  const subject = `Your week on Tarmoto — ${ctx.rideCount} ${rideWord}, ${distance}`;

  const text = `${greeting}

Here's your week on the road:

  • ${ctx.rideCount} ${rideWord}
  • ${distance} ridden
  • ${duration} in the saddle${quality ? `\n  • Best road quality: ${quality}` : ''}

Exploration: you've now ridden ${ctx.riddenSegments} road sections — ${ctx.percentExplored}% of your area.

Find your next road:
${ctx.exploreUrl}${renderTextFooter(ctx.preferencesUrl, true)}`;

  const row = (label: string, value: string): string => `
      <tr>
        <td style="padding:6px 0;color:#94a3b8;font-size:14px;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#f8fafc;font-size:16px;font-weight:600;text-align:right;">${escapeHtml(value)}</td>
      </tr>`;

  const html = renderLayout({
    preheader: `${ctx.rideCount} ${rideWord}, ${distance} this week on Tarmoto.`,
    preferencesUrl: ctx.preferencesUrl,
    marketingFooter: true,
    bodyHtml: `
      <p>${escapeHtml(greeting)}</p>
      <p>Here's your week on the road.</p>
      <table role="presentation" width="100%" style="margin:20px 0;border-collapse:collapse;">
        ${row('Rides', String(ctx.rideCount))}
        ${row('Distance', distance)}
        ${row('Time in the saddle', duration)}
        ${quality ? row('Best road quality', quality) : ''}
      </table>
      <p style="color:#cbd5e1;">You've now ridden <strong style="color:#f8fafc;">${ctx.riddenSegments}</strong> road sections — <strong style="color:#f8fafc;">${ctx.percentExplored}%</strong> of your area explored.</p>
      <p style="margin:32px 0;">
        <a href="${escapeHtml(ctx.exploreUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">Find your next road</a>
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
  const subject = 'Your Tarmoto account has been deleted';
  const greeting = ctx.displayName ? `Hi ${ctx.displayName},` : 'Hi there,';
  const text = `${greeting}

Your Tarmoto account was permanently deleted on ${ctx.deletedAt.toUTCString()}.

Personal data has been erased. Anonymized road-quality contributions remain in the community dataset, as outlined in our deletion notice.

If this wasn't you or you have questions, contact ${ctx.supportEmail}.${renderTextFooter(ctx.preferencesUrl)}`;

  const html = renderLayout({
    preheader: 'Your Tarmoto account has been permanently deleted.',
    preferencesUrl: ctx.preferencesUrl,
    bodyHtml: `
      <p>${escapeHtml(greeting)}</p>
      <p>Your Tarmoto account was permanently deleted on <strong>${escapeHtml(ctx.deletedAt.toUTCString())}</strong>.</p>
      <p>Personal data has been erased. Anonymized road-quality contributions remain in the community dataset, as outlined in our deletion notice.</p>
      <p style="color:#94a3b8;font-size:13px;">Questions? Contact <a href="mailto:${escapeHtml(ctx.supportEmail)}" style="color:#06b6d4;">${escapeHtml(ctx.supportEmail)}</a>.</p>
    `,
  });

  return { subject, html, text, tag: 'account-deletion-completed' };
};
