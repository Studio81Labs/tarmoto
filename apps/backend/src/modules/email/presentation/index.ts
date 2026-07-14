import {
  formatDistance,
  type SupportedLocale,
  type UnitSystem,
} from '@tarmoto/shared';
import { translateEmail } from '../i18n/index.js';

/**
 * Per-template presentation formatting for the 6 editable emails (admin
 * email template editor Phase 1: weekly-digest, subscription-confirmed,
 * subscription-cancelled, data-export-ready, account-deletion-scheduled,
 * account-deletion-completed). Each function takes a template's raw
 * send-time context and returns PRE-FORMATTED text/url vars — numbers
 * unit-formatted, counts pluralized, dates rendered — extracted verbatim
 * from the current code templates. `../templates/index.ts` renders from
 * these values instead of formatting inline, so the code-template path and
 * the future admin block-render path share exactly one formatting source.
 * `TEMPLATE_WHITELIST` is the per-template list of vars an admin block
 * document may reference; it's derived from each function's actual output
 * below so it can't silently drift from what the functions really return.
 *
 * The 4 locked templates (verification, password-reset, trip-invite,
 * password-changed) have no presentation function — they stay code-only.
 *
 * See docs/superpowers/specs/2026-07-14-admin-email-template-editor-phase1-design.md
 */

/** "2h 15m" / "45m" from a raw minute count. Single source — every editable
 * template's duration flows through here (templates/index.ts no longer
 * carries its own copy). */
function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return h > 0 ? `${h}h ${rem}m` : `${rem}m`;
}

// --- weekly-digest ---

export interface DigestPresentationInput {
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
  locale: SupportedLocale;
}

export function digestPresentation(ctx: DigestPresentationInput) {
  // Pluralization stays in code: which catalog key is picked is the plural
  // rule, not something `t()`'s dumb {placeholder} substitution can express.
  const rideWord =
    ctx.rideCount === 1
      ? translateEmail('digest.rideWord.one', undefined, ctx.locale)
      : translateEmail('digest.rideWord.other', undefined, ctx.locale);
  return {
    textVars: {
      displayName: ctx.displayName,
      // Raw count alone (no word) — the HTML summary table's "Rides" row
      // shows just the number. `rideSummary` below (count + pluralized
      // word) is what the subject/preheader/text bullet use instead.
      rideCount: String(ctx.rideCount),
      rideSummary: `${ctx.rideCount} ${rideWord}`,
      distance: formatDistance(ctx.totalKm, ctx.units),
      duration: formatDuration(ctx.totalMinutes),
      quality:
        ctx.bestQuality != null ? `${ctx.bestQuality.toFixed(1)} / 5` : '',
      riddenSegments: String(ctx.riddenSegments),
      percentExplored: `${ctx.percentExplored}%`,
    },
    urlVars: { exploreUrl: ctx.exploreUrl },
  };
}

// --- subscription-confirmed ---

export interface SubscriptionConfirmedPresentationInput {
  displayName: string;
  planName: string;
  priceLabel: string;
  renewsAt: Date | null;
  manageBillingUrl: string;
  locale: SupportedLocale;
}

export function subscriptionConfirmedPresentation(
  ctx: SubscriptionConfirmedPresentationInput,
) {
  // Raw date alone — the HTML summary table's conditional "Next renewal" row
  // shows just the date (row omitted entirely when there's no renewal).
  // `renewsText` is the full sentence used in the text body.
  const renewsDate = ctx.renewsAt ? ctx.renewsAt.toUTCString() : '';
  const renewsText = ctx.renewsAt
    ? translateEmail(
        'subscriptionConfirmed.text.renews',
        { date: renewsDate },
        ctx.locale,
      )
    : translateEmail(
        'subscriptionConfirmed.text.noRenew',
        undefined,
        ctx.locale,
      );
  return {
    textVars: {
      displayName: ctx.displayName,
      planName: ctx.planName,
      priceLabel: ctx.priceLabel,
      renewsText,
      renewsDate,
    },
    urlVars: { manageBillingUrl: ctx.manageBillingUrl },
  };
}

// --- subscription-cancelled ---

export interface SubscriptionCancelledPresentationInput {
  displayName: string;
  planName: string;
  endsAt: Date | null;
  resubscribeUrl: string;
  locale: SupportedLocale;
}

export function subscriptionCancelledPresentation(
  ctx: SubscriptionCancelledPresentationInput,
) {
  const accessText = ctx.endsAt
    ? translateEmail(
        'subscriptionCancelled.accessKept',
        { plan: ctx.planName, date: ctx.endsAt.toUTCString() },
        ctx.locale,
      )
    : translateEmail(
        'subscriptionCancelled.accessEnded',
        { plan: ctx.planName },
        ctx.locale,
      );
  return {
    textVars: {
      displayName: ctx.displayName,
      planName: ctx.planName,
      accessText,
    },
    urlVars: { resubscribeUrl: ctx.resubscribeUrl },
  };
}

// --- data-export-ready ---

export interface DataExportReadyPresentationInput {
  displayName: string;
  downloadUrl: string;
  expiresAt: Date;
}

export function dataExportReadyPresentation(
  ctx: DataExportReadyPresentationInput,
) {
  return {
    textVars: {
      displayName: ctx.displayName,
      expiresText: ctx.expiresAt.toUTCString(),
    },
    urlVars: { downloadUrl: ctx.downloadUrl },
  };
}

// --- account-deletion-scheduled ---

export interface AccountDeletionScheduledPresentationInput {
  displayName: string;
  scheduledFor: Date;
  supportEmail: string;
}

export function accountDeletionScheduledPresentation(
  ctx: AccountDeletionScheduledPresentationInput,
) {
  return {
    textVars: {
      displayName: ctx.displayName,
      scheduledDate: ctx.scheduledFor.toUTCString(),
      supportEmail: ctx.supportEmail,
    },
    // No CTA button in Phase 1 — support is shown as mailto text, not a URL.
    urlVars: {} as Record<string, string>,
  };
}

// --- account-deletion-completed ---

export interface AccountDeletionCompletedPresentationInput {
  displayName: string;
  deletedAt: Date;
  supportEmail: string;
}

export function accountDeletionCompletedPresentation(
  ctx: AccountDeletionCompletedPresentationInput,
) {
  return {
    textVars: {
      displayName: ctx.displayName,
      deletedDate: ctx.deletedAt.toUTCString(),
      supportEmail: ctx.supportEmail,
    },
    urlVars: {} as Record<string, string>,
  };
}

// --- per-template variable whitelist (for the future admin block editor) ---

export const EDITABLE_TAGS = [
  'weekly-digest',
  'subscription-confirmed',
  'subscription-cancelled',
  'data-export-ready',
  'account-deletion-scheduled',
  'account-deletion-completed',
] as const;

export type EditableTag = (typeof EDITABLE_TAGS)[number];

export interface TemplateWhitelistEntry {
  textVars: string[];
  urlVars: string[];
}

function whitelistEntry(presentation: {
  textVars: Record<string, string>;
  urlVars: Record<string, string>;
}): TemplateWhitelistEntry {
  return {
    textVars: Object.keys(presentation.textVars),
    urlVars: Object.keys(presentation.urlVars),
  };
}

/**
 * Each entry is derived from a real call to its presentation function (with
 * throwaway sample values — only the returned KEYS matter here, never the
 * values) rather than hand-typed, so the whitelist can't drift from what the
 * function actually returns.
 */
export const TEMPLATE_WHITELIST: Record<EditableTag, TemplateWhitelistEntry> = {
  'weekly-digest': whitelistEntry(
    digestPresentation({
      displayName: '',
      rideCount: 1,
      totalKm: 0,
      totalMinutes: 0,
      bestQuality: null,
      percentExplored: 0,
      riddenSegments: 0,
      units: 'metric',
      exploreUrl: '',
      locale: 'en',
    }),
  ),
  'subscription-confirmed': whitelistEntry(
    subscriptionConfirmedPresentation({
      displayName: '',
      planName: '',
      priceLabel: '',
      renewsAt: null,
      manageBillingUrl: '',
      locale: 'en',
    }),
  ),
  'subscription-cancelled': whitelistEntry(
    subscriptionCancelledPresentation({
      displayName: '',
      planName: '',
      endsAt: null,
      resubscribeUrl: '',
      locale: 'en',
    }),
  ),
  'data-export-ready': whitelistEntry(
    dataExportReadyPresentation({
      displayName: '',
      downloadUrl: '',
      expiresAt: new Date(0),
    }),
  ),
  'account-deletion-scheduled': whitelistEntry(
    accountDeletionScheduledPresentation({
      displayName: '',
      scheduledFor: new Date(0),
      supportEmail: '',
    }),
  ),
  'account-deletion-completed': whitelistEntry(
    accountDeletionCompletedPresentation({
      displayName: '',
      deletedAt: new Date(0),
      supportEmail: '',
    }),
  ),
};
