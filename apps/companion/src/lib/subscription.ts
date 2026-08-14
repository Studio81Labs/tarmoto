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
}

// Pro is the €29.99 mid tier, Premium the €49.99 top tier (naming
// decided 2026-07 — earlier copy had the two names swapped).
const PLAN_COPY: Record<
  SubscriptionTier,
  {
    features: readonly EnglishMessageKey[];
    description?: EnglishMessageKey;
    highlighted?: boolean;
  }
> = {
  free: {
    features: [
      "Basic navigation",
      "Road quality overlay (limited)",
      "Hazard alerts",
      "{count, plural, one {# active trip} other {# active trips}}",
    ],
  },
  pro: {
    features: [
      "Unlimited trip planning",
      "Full road quality zoom",
      "Offline maps",
      "GPX export",
    ],
    highlighted: true,
  },
  premium: {
    features: [
      "Everything in Pro",
      "Unlimited group rides",
      "Priority hazard alerts",
      "Advanced analytics",
    ],
    description: "For group organisers and power users.",
  },
};

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
  const copy = PLAN_COPY[tier];
  return {
    tier,
    name: tierLabel(tier, t),
    priceLabel: subscriptionPriceLabel(tier, locale, t),
    features: copy.features.map((feature) =>
      feature === "{count, plural, one {# active trip} other {# active trips}}"
        ? t(feature, { count: 1 })
        : t(feature),
    ),
    ...(copy.description ? { description: t(copy.description) } : {}),
    ...(copy.highlighted ? { highlighted: true } : {}),
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
