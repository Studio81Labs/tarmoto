import {
  formatSubscriptionAmountLabel,
  formatSubscriptionPriceLabel,
  formatCurrencyMinorAmount,
  DEFAULT_FORMAT_LOCALE,
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_MANAGED_BY,
  type Formatters,
  type SubscriptionTier,
  type SubscriptionProvider,
  type SubscriptionManagedBy,
  FEATURE_DEFINITIONS,
  type ToggleFeatureKey,
  type LimitFeatureKey,
} from "@tarmoto/shared";
import { ApiError } from "@/lib/api";
import type { EnglishMessageKey, Translate } from "@/i18n";

export type { SubscriptionTier, SubscriptionProvider, SubscriptionManagedBy };
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled";
export type InvoiceStatus = "paid" | "open" | "refunded";

export interface SubscriptionPlanSummary {
  tier: SubscriptionTier;
  name: string;
  priceLabel: string;
  features: string[];
  description?: string;
  highlighted?: boolean;
}

export interface CurrentSubscriptionPlan {
  tier: SubscriptionTier;
  name: string;
  status: SubscriptionStatus;
  priceLabel: string;
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  manageUrl: string | null;
}

export interface SubscriptionPaymentMethod {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface SubscriptionInvoice {
  id: string;
  date: string;
  amountLabel: string;
  status: InvoiceStatus;
  invoiceUrl: string | null;
}

export interface SubscriptionSnapshot {
  currentPlan: CurrentSubscriptionPlan;
  plans: SubscriptionPlanSummary[];
  paymentMethod: SubscriptionPaymentMethod | null;
  billingHistory: SubscriptionInvoice[];
  portalAvailable: boolean;
  preview: boolean;
  provider: SubscriptionProvider | null;
  managedBy: SubscriptionManagedBy | null;
  /**
   * Whether this rider has never consumed the introductory trial.
   *
   * NOT sufficient on its own to advertise one: it stays true for an active
   * paid rider who subscribed without a trial (the backend deliberately leaves
   * `billing_trial_used_at` unset in that case), and their plan buttons open
   * the billing portal, which starts nothing.
   */
  trialEligible: boolean;
}

// Pro is the €29.99 mid tier, Premium the €49.99 top tier (naming
// decided 2026-07 — earlier copy had the two names swapped).
//
// ## Why the bullets come from the registry
//
// They used to be a hand-written list per tier, which drifted: it claimed
// capabilities the registry grants a DIFFERENT tier, and omitted ones it does
// grant. A plan card is a commercial promise, so the tier that owns a
// capability has to be read from the thing that enforces it.
//
// The registry decides WHAT each tier gets. This map decides only how a
// capability is worded, whether it is honest to advertise at all, and where it
// works — three things a flag definition cannot know.
type PlanFeaturePlatform =
  /** Works on this web app (possibly alongside mobile). */
  | "web"
  /** Real, but only in the mobile app — say so rather than implying web. */
  | "mobile";
type PlanFeatureStatus =
  | "marketable"
  /**
   * Granted by the registry but NOT BUILT. These must never render: the
   * registry is the vocabulary of what a tier *would* include, and deriving
   * copy from it naively turns three unimplemented grants into paid promises.
   */
  | "unbuilt";

type PlanFeatureCopy =
  | {
      kind: "toggle";
      label: EnglishMessageKey;
      platform: PlanFeaturePlatform;
      status: PlanFeatureStatus;
    }
  | {
      kind: "limit";
      /** Wording when the tier has a finite allowance; receives `count`. */
      finite: EnglishMessageKey;
      /** Wording when the tier's allowance is unlimited (`null`). */
      unlimited: EnglishMessageKey;
      platform: PlanFeaturePlatform;
      status: PlanFeatureStatus;
    };

// EXHAUSTIVE over both key unions on purpose. A new registry key, a retired
// one, or a re-tiered one is then a typecheck failure here rather than a stale
// claim on a €49.99 card that nobody notices.
const FEATURE_COPY: Record<
  ToggleFeatureKey | LimitFeatureKey,
  PlanFeatureCopy
> = {
  // ── Free-tier capabilities ──
  basic_navigation: {
    kind: "toggle",
    label: "Basic navigation",
    platform: "web",
    status: "marketable",
  },
  ride_tracking: {
    kind: "toggle",
    label: "Ride tracking",
    platform: "mobile",
    status: "marketable",
  },
  road_quality_overlay: {
    kind: "toggle",
    label: "Road quality overlay",
    platform: "web",
    status: "marketable",
  },
  hazard_alerts: {
    kind: "toggle",
    label: "Hazard alerts",
    platform: "web",
    status: "marketable",
  },
  hazard_reporting: {
    kind: "toggle",
    label: "Hazard reporting",
    platform: "web",
    status: "marketable",
  },
  crash_detection: {
    kind: "toggle",
    label: "Crash detection",
    platform: "mobile",
    status: "marketable",
  },
  weather_alerts: {
    kind: "toggle",
    label: "Weather alerts",
    platform: "mobile",
    status: "marketable",
  },
  trip_planning: {
    kind: "toggle",
    label: "Trip planning",
    platform: "web",
    status: "marketable",
  },
  gpx_import: {
    kind: "toggle",
    label: "GPX import",
    platform: "web",
    status: "marketable",
  },
  community_access: {
    kind: "toggle",
    label: "Community",
    platform: "web",
    status: "marketable",
  },
  carplay_android_auto: {
    kind: "toggle",
    label: "CarPlay and Android Auto",
    platform: "mobile",
    status: "marketable",
  },
  // ── Pro ──
  offline_maps: {
    kind: "toggle",
    label: "Offline maps",
    platform: "mobile",
    status: "marketable",
  },
  gpx_export: {
    kind: "toggle",
    label: "GPX export",
    platform: "web",
    status: "marketable",
  },
  commuter_mode: {
    kind: "toggle",
    label: "Commuter mode",
    platform: "mobile",
    status: "marketable",
  },
  advanced_ride_stats: {
    kind: "toggle",
    label: "Advanced ride stats",
    platform: "web",
    status: "marketable",
  },
  collaborative_trips: {
    kind: "toggle",
    label: "Collaborative trips",
    platform: "web",
    status: "marketable",
  },
  // ── Premium ──
  group_rides: {
    kind: "toggle",
    label: "Group rides",
    platform: "mobile",
    status: "marketable",
  },
  advanced_analytics: {
    kind: "toggle",
    label: "Advanced analytics",
    platform: "web",
    status: "marketable",
  },
  // Registry grants, deferred features. `docs/feature-flags.md` lists all three
  // among the not-built set, and none has ever been on a card.
  priority_hazard_alerts: {
    kind: "toggle",
    label: "Priority hazard alerts",
    platform: "mobile",
    status: "unbuilt",
  },
  api_access: {
    kind: "toggle",
    label: "Personal API token",
    platform: "web",
    status: "unbuilt",
  },
  garmin_export: {
    kind: "toggle",
    label: "Direct route export to Garmin",
    platform: "mobile",
    status: "unbuilt",
  },
  // ── Limits ──
  max_active_trips: {
    kind: "limit",
    finite: "{count, plural, one {# active trip} other {# active trips}}",
    unlimited: "Unlimited trip planning",
    platform: "web",
    status: "marketable",
  },
  max_trip_collaborators: {
    kind: "limit",
    finite:
      "{count, plural, one {# trip collaborator} other {# trip collaborators}}",
    unlimited: "Unlimited trip collaborators",
    platform: "web",
    status: "marketable",
  },
  max_group_ride_members: {
    kind: "limit",
    finite:
      "{count, plural, one {# group ride member} other {# group ride members}}",
    unlimited: "Unlimited group rides",
    platform: "mobile",
    status: "marketable",
  },
  road_quality_max_zoom: {
    kind: "limit",
    finite: "Road quality overlay (limited)",
    unlimited: "Full road quality zoom",
    platform: "web",
    status: "marketable",
  },
  max_offline_regions: {
    kind: "limit",
    finite: "{count, plural, one {# offline region} other {# offline regions}}",
    unlimited: "Unlimited offline regions",
    platform: "mobile",
    status: "marketable",
  },
  hazard_reports_per_day: {
    kind: "limit",
    finite:
      "{count, plural, one {# hazard report a day} other {# hazard reports a day}}",
    unlimited: "Unlimited hazard reports",
    platform: "web",
    status: "marketable",
  },
};

// WHICH capabilities each card leads with. Editorial, not authoritative: every
// key here is still checked against the registry before it renders, so a
// capability that moves tiers drops off the card it no longer belongs to
// instead of lingering as a false claim.
const CARD_FEATURES: Record<
  SubscriptionTier,
  readonly (ToggleFeatureKey | LimitFeatureKey)[]
> = {
  free: [
    "basic_navigation",
    "road_quality_max_zoom",
    "hazard_alerts",
    "max_active_trips",
    // Listed on every card, rendered only where the registry grants a non-zero
    // allowance — Free is `0`, so it drops out. Selecting a capability is an
    // editorial choice; whether it appears stays the registry's answer.
    "max_trip_collaborators",
  ],
  pro: [
    "max_active_trips",
    "road_quality_max_zoom",
    "offline_maps",
    "gpx_export",
    "max_trip_collaborators",
  ],
  premium: ["group_rides", "advanced_analytics", "max_trip_collaborators"],
};

const PLAN_EXTRA_COPY: Record<
  SubscriptionTier,
  {
    description?: EnglishMessageKey;
    highlighted?: boolean;
    lead?: EnglishMessageKey;
  }
> = {
  free: {},
  pro: { highlighted: true },
  premium: {
    description: "For group organisers and power users.",
    lead: "Everything in Pro",
  },
};

/** Whether the registry grants this toggle to this tier. */
function toggleGrantedAt(
  key: ToggleFeatureKey,
  tier: SubscriptionTier,
): boolean {
  const tiers = FEATURE_DEFINITIONS[key].tiers as readonly SubscriptionTier[];
  return tiers.includes(tier);
}

/** This tier's allowance for a limit: a number, or `null` for unlimited. */
function limitValueAt(
  key: LimitFeatureKey,
  tier: SubscriptionTier,
): number | null {
  const tiers = FEATURE_DEFINITIONS[key].tiers as Record<
    SubscriptionTier,
    number | null
  >;
  return tiers[tier];
}

function planFeatureLabels(tier: SubscriptionTier, t: Translate): string[] {
  const labels: string[] = [];
  for (const key of CARD_FEATURES[tier]) {
    const copy = FEATURE_COPY[key];
    // Never advertise something that does not exist yet, whatever the registry
    // says the tier is entitled to.
    if (copy.status === "unbuilt") continue;

    let text: string;
    if (copy.kind === "toggle") {
      // The registry, not this file, decides whether the tier has it.
      if (!toggleGrantedAt(key as ToggleFeatureKey, tier)) continue;
      text = t(copy.label);
    } else {
      const value = limitValueAt(key as LimitFeatureKey, tier);
      // `0` is how the registry DISABLES a capability for a tier, not an
      // allowance of none — so it is dropped exactly as an ungranted toggle
      // is. Formatting it would advertise the absence of a capability as a
      // feature ("0 trip collaborators") on the card that lacks it.
      if (value === 0) continue;
      text =
        value === null ? t(copy.unlimited) : t(copy.finite, { count: value });
    }
    // Annotate rather than imply: these capabilities are real, but not here.
    labels.push(
      copy.platform === "mobile"
        ? t("{feature} (mobile app)", { feature: text })
        : text,
    );
  }
  return labels;
}

const TIER_ORDER: Record<SubscriptionTier, number> = {
  free: 0,
  pro: 1,
  premium: 2,
};

function subscriptionPriceLabel(
  tier: SubscriptionTier,
  locale: string,
  t: Translate,
): string {
  return formatSubscriptionPriceLabel(tier, {
    locale,
    yearLabel: t("yr"),
    monthLabel: t("mo"),
  });
}

export function buildFallbackSubscriptionSnapshot(
  t: Translate,
  locale = DEFAULT_FORMAT_LOCALE,
): SubscriptionSnapshot {
  return {
    currentPlan: {
      tier: "pro",
      name: tierLabel("pro", t),
      status: "active",
      priceLabel: subscriptionPriceLabel("pro", locale, t),
      renewsAt: "2026-11-15T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      manageUrl: null,
    },
    plans: (["free", "pro", "premium"] as const).map((tier) =>
      buildPlan(tier, t, locale),
    ),
    paymentMethod: {
      brand: "Visa",
      last4: "4242",
      expMonth: 8,
      expYear: 2028,
    },
    billingHistory: [
      {
        id: "preview-invoice-2026-03",
        date: "2026-03-15T00:00:00.000Z",
        amountLabel: formatSubscriptionAmountLabel("pro", locale),
        status: "paid",
        invoiceUrl: null,
      },
      {
        id: "preview-invoice-2026-02",
        date: "2026-02-15T00:00:00.000Z",
        amountLabel: formatSubscriptionAmountLabel("pro", locale),
        status: "paid",
        invoiceUrl: null,
      },
    ],
    portalAvailable: false,
    preview: true,
    provider: null,
    managedBy: null,
    // The safe claim: the fallback renders before anything is known, and
    // offering a trial we cannot honour is worse than omitting one we could.
    trialEligible: false,
  };
}

export function normalizeSubscriptionSnapshot(
  raw: unknown,
  t: Translate,
  locale = DEFAULT_FORMAT_LOCALE,
): SubscriptionSnapshot {
  const fallback = buildFallbackSubscriptionSnapshot(t, locale);
  const root = asRecord(raw);

  const currentPlanRaw = asRecord(root.current_plan);
  const normalizedTier = normalizeTier(currentPlanRaw.tier);
  const normalizedStatus = normalizeStatus(currentPlanRaw.status);
  const preview = normalizedTier === null || normalizedStatus === null;
  const currentTier = normalizedTier ?? fallback.currentPlan.tier;
  const currentPlan: CurrentSubscriptionPlan = {
    tier: currentTier,
    name: tierLabel(currentTier, t),
    status: normalizedStatus ?? fallback.currentPlan.status,
    priceLabel: subscriptionPriceLabel(currentTier, locale, t),
    renewsAt: optionalString(currentPlanRaw.renews_at),
    cancelAtPeriodEnd: Boolean(currentPlanRaw.cancel_at_period_end),
    manageUrl: normalizeUrl(currentPlanRaw.manage_url),
  };

  const plans = normalizePlans(root.plans, fallback.plans, t, locale);
  const currentInPlans = plans.some((plan) => plan.tier === currentPlan.tier);

  return {
    currentPlan,
    plans: currentInPlans
      ? plans
      : sortPlans([...plans, buildPlanFromCurrent(currentPlan, t, locale)]),
    paymentMethod: normalizePaymentMethod(root.payment_method),
    billingHistory: normalizeInvoices(root.billing_history, t, locale),
    portalAvailable:
      Boolean(root.portal_available) || currentPlan.manageUrl !== null,
    preview,
    provider: normalizeProvider(root.provider),
    managedBy: normalizeManagedBy(root.managed_by),
    // Absent (an older backend, or the preview fallback path) reads as NOT
    // eligible: `Boolean(undefined)` is false, which is the claim we want.
    trialEligible: Boolean(root.trial_eligible),
  };
}

export function shouldUseSubscriptionPreview(error: unknown): boolean {
  return (
    (error instanceof ApiError ? error.status : getErrorStatus(error)) === 404
  );
}

/**
 * Whether THIS rider's upgrade routes through Stripe Checkout rather than the
 * billing portal or an app store — the one question `sys_billing_checkout`
 * actually answers. The switch kills Checkout only; every portal flow stays
 * open on purpose (`account.service.ts` leaves `createPortalSession`
 * ungated), so "the switch is off" is never on its own a reason to withhold an
 * upgrade route from a rider who still has a working one.
 *
 * Answers what the BACKEND will accept, which is what the rider experiences.
 * That is the billing page's `handlePlanAction` routing in every case but one
 * — see `past_due` below, where the page currently sends the rider to a
 * Checkout that `createCheckoutSession` rejects, and this helper deliberately
 * does not follow it there.
 *
 * Deliberately does NOT reduce to `tier === "free"`. A free tier never means
 * "no subscription", only "not currently entitled", and three states reach it
 * with billing still live somewhere:
 *
 * - A **store-managed** plan is not a Stripe flow at all. `managed_by` is
 *   derived from the elected subscription provider independent of tier, so a
 *   LAPSED App Store / Play Store rider reads `tier: "free"` while their
 *   upgrade path is still the store — which this switch does not gate.
 * - A **paid, canceled** plan has no live Stripe subscription behind it (an
 *   operator grant, or an abandoned Checkout that still left a customer), so
 *   the page routes its every plan action through Checkout.
 * - A **`past_due`** plan has a Stripe subscription that still EXISTS and needs
 *   recovering, whatever tier the snapshot reports. `unpaid` stops entitling,
 *   so `buildSubscriptionSnapshot` falls back to the stored `free` tier while
 *   the status keeps the live value (`account.service.ts` maps `unpaid` →
 *   `past_due`) — and `createCheckoutSession` rejects that rider outright with
 *   "Existing subscriptions must be changed in the billing portal". Reading the
 *   tier alone would strand exactly the rider who most needs to reach billing.
 *   The billing page has the same bug in its own routing today (#1198); this
 *   helper answers correctly rather than reproducing it.
 * - Any other **paid** state changes plan through `subscription_update` on the
 *   portal, which stays reachable.
 *
 * A `preview` snapshot is a synthesized demo plan — the `/account/subscription`
 * 404 fallback, or a payload whose tier/status failed to normalize. It
 * describes no real routing, so it claims none.
 */
export function upgradeNeedsCheckout(snapshot: SubscriptionSnapshot): boolean {
  if (
    snapshot.managedBy === "app_store" ||
    snapshot.managedBy === "play_store"
  ) {
    return false;
  }
  if (snapshot.preview) return false;
  if (snapshot.currentPlan.status === "past_due") return false;
  return (
    snapshot.currentPlan.tier === "free" ||
    snapshot.currentPlan.status === "canceled"
  );
}

export function tierLabel(tier: SubscriptionTier, t: Translate): string {
  if (tier === "pro") return t("Pro");
  if (tier === "premium") return t("Premium");
  return t("Free");
}

export function planActionLabel(
  planTier: SubscriptionTier,
  currentTier: SubscriptionTier,
  t: Translate,
): string {
  if (planTier === currentTier) return t("Current plan");
  return TIER_ORDER[planTier] > TIER_ORDER[currentTier]
    ? t("Upgrade")
    : t("Downgrade");
}

export function describeRenewal(
  plan: CurrentSubscriptionPlan,
  format: Formatters,
  t: Translate,
): string {
  // `format.date()` renders "" for an unparseable timestamp; without the
  // "soon" fallback a malformed (but present) `renews_at` would silently
  // reroute an active plan to the portal copy / a trial to no end-date —
  // misleading during malformed or partially migrated billing data. This
  // preserves the retired helper's "Renews soon"-class behavior.
  const date = plan.renewsAt ? format.date(plan.renewsAt) || t("soon") : null;
  if (plan.cancelAtPeriodEnd && date) {
    return t("Downgrades {date}", { date });
  }
  if (plan.status === "trialing" && date) {
    return t("Trial ends {date}", { date });
  }
  if (plan.status === "canceled") {
    return date ? t("Access ends {date}", { date }) : t("Canceled");
  }
  return date
    ? t("Renews {date}", { date })
    : t("Billing cycle managed in the portal");
}

export function formatPaymentMethodLabel(
  paymentMethod: SubscriptionPaymentMethod,
  t: Translate,
): string {
  return t("{brand} ending in {last4}", {
    brand: titleCase(paymentMethod.brand, t),
    last4: paymentMethod.last4,
  });
}

export function formatPaymentMethodExpiry(
  paymentMethod: SubscriptionPaymentMethod,
  t: Translate,
): string {
  return t("Expires {mm}/{yyyy}", {
    mm: String(paymentMethod.expMonth).padStart(2, "0"),
    yyyy: paymentMethod.expYear,
  });
}

export function formatInvoiceDate(date: string, format: Formatters): string {
  // `format.date()` renders "" for an unparseable timestamp, which would
  // leave the billing-history row with a blank heading. Degrade to the
  // repo's standard missing-value dash so partially migrated billing data
  // stays intelligible ("soon" — the retired helper's fallback — reads
  // wrong for a past invoice).
  return format.date(date) || "—";
}

export function invoiceStatusLabel(
  status: InvoiceStatus,
  t: Translate,
): string {
  if (status === "open") return t("Open");
  if (status === "refunded") return t("Refunded");
  return t("Paid");
}

function normalizePlans(
  rawPlans: unknown,
  fallbackPlans: SubscriptionPlanSummary[],
  t: Translate,
  locale: string,
): SubscriptionPlanSummary[] {
  if (!Array.isArray(rawPlans) || rawPlans.length === 0) {
    return fallbackPlans;
  }

  const seen = new Set<SubscriptionTier>();
  const normalized = rawPlans.flatMap((entry) => {
    const tier = normalizeTier(asRecord(entry).tier);
    if (!tier || seen.has(tier)) return [];
    seen.add(tier);
    return [buildPlan(tier, t, locale)];
  });

  return normalized.length > 0 ? sortPlans(normalized) : fallbackPlans;
}

function normalizePaymentMethod(
  raw: unknown,
): SubscriptionPaymentMethod | null {
  const payment = asRecord(raw);
  const last4 = optionalString(payment.last4);
  const brand = optionalString(payment.brand);
  const expMonth = numberOr(payment.exp_month, 0);
  const expYear = numberOr(payment.exp_year, 0);

  if (!last4 || !brand || expMonth <= 0 || expYear <= 0) return null;

  return {
    brand,
    last4,
    expMonth,
    expYear,
  };
}

function normalizeInvoices(
  raw: unknown,
  t: Translate,
  locale: string,
): SubscriptionInvoice[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      const invoice = asRecord(entry);
      const id = stringOr(invoice.id, `invoice-${index + 1}`);
      const date = optionalString(invoice.date);
      const amountMinor = numberOr(invoice.amount_minor, Number.NaN);
      // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search -- ISO 4217 currency codes are invariant machine tokens required by Intl.NumberFormat.
      const currency = optionalString(invoice.currency)?.toUpperCase();
      const amountLabel =
        Number.isFinite(amountMinor) && currency
          ? formatCurrencyMinorAmount(amountMinor, currency, locale)
          : stringOr(invoice.amount_label, t("Unavailable"));
      const status = normalizeInvoiceStatus(invoice.status) ?? "paid";
      if (!date) return null;
      return {
        id,
        date,
        amountLabel,
        status,
        invoiceUrl: normalizeUrl(invoice.invoice_url),
      } satisfies SubscriptionInvoice;
    })
    .filter((invoice): invoice is SubscriptionInvoice => invoice !== null);
}

function normalizeTier(value: unknown): SubscriptionTier | null {
  return value === "free" || value === "premium" || value === "pro"
    ? value
    : null;
}

function normalizeStatus(value: unknown): SubscriptionStatus | null {
  return value === "active" ||
    value === "trialing" ||
    value === "past_due" ||
    value === "canceled"
    ? value
    : null;
}

function normalizeProvider(value: unknown): SubscriptionProvider | null {
  return SUBSCRIPTION_PROVIDERS.includes(value as SubscriptionProvider)
    ? (value as SubscriptionProvider)
    : null;
}

function normalizeManagedBy(value: unknown): SubscriptionManagedBy | null {
  return SUBSCRIPTION_MANAGED_BY.includes(value as SubscriptionManagedBy)
    ? (value as SubscriptionManagedBy)
    : null;
}

function normalizeInvoiceStatus(value: unknown): InvoiceStatus | null {
  return value === "paid" || value === "open" || value === "refunded"
    ? value
    : null;
}

function buildPlanFromCurrent(
  currentPlan: CurrentSubscriptionPlan,
  t: Translate,
  locale: string,
): SubscriptionPlanSummary {
  return buildPlan(currentPlan.tier, t, locale);
}

function buildPlan(
  tier: SubscriptionTier,
  t: Translate,
  locale: string,
): SubscriptionPlanSummary {
  const extra = PLAN_EXTRA_COPY[tier];
  return {
    tier,
    name: tierLabel(tier, t),
    priceLabel: subscriptionPriceLabel(tier, locale, t),
    features: [
      // "Everything in Pro" first, so the premium card reads as an addition
      // rather than a replacement.
      ...(extra.lead ? [t(extra.lead)] : []),
      ...planFeatureLabels(tier, t),
    ],
    ...(extra.description ? { description: t(extra.description) } : {}),
    ...(extra.highlighted ? { highlighted: true } : {}),
  };
}

function sortPlans(
  plans: SubscriptionPlanSummary[],
): SubscriptionPlanSummary[] {
  return [...plans].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
}

function titleCase(value: string, t: Translate): string {
  if (!value) return t("Card");
  // Payment-card brands are provider-owned ASCII identifiers.
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return null;
  }

  const status = error.status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}
