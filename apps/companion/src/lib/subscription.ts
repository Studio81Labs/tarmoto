import {
  formatSubscriptionAmountLabel,
  formatSubscriptionPriceLabel,
  type Formatters,
  type LooseTranslate,
  type SubscriptionTier,
} from "@tarmoto/shared";
import { ApiError } from "@/lib/api";

export type { SubscriptionTier };
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
}

// Pro is the €29.99 mid tier, Premium the €49.99 top tier (naming
// decided 2026-07 — earlier copy had the two names swapped).
const DEFAULT_PLAN_FEATURES: Record<SubscriptionTier, string[]> = {
  free: ["Basic navigation", "Hazard alerts", "1 active trip"],
  pro: ["Unlimited trip planning", "Offline maps", "GPX export"],
  premium: ["Unlimited group rides", "Priority hazard alerts", "API access"],
};

const TIER_ORDER: Record<SubscriptionTier, number> = {
  free: 0,
  pro: 1,
  premium: 2,
};

export function buildFallbackSubscriptionSnapshot(
  t: LooseTranslate,
): SubscriptionSnapshot {
  return {
    currentPlan: {
      tier: "pro",
      name: tierLabel("pro", t),
      status: "active",
      priceLabel: formatSubscriptionPriceLabel("pro"),
      renewsAt: "2026-11-15T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      manageUrl: null,
    },
    plans: [
      {
        tier: "free",
        name: tierLabel("free", t),
        priceLabel: formatSubscriptionPriceLabel("free"),
        features: [
          t("Basic navigation"),
          t("Road quality overlay (limited)"),
          t("Hazard alerts"),
          t("1 active trip"),
        ],
      },
      {
        tier: "pro",
        name: tierLabel("pro", t),
        priceLabel: formatSubscriptionPriceLabel("pro"),
        highlighted: true,
        features: [
          t("Unlimited trip planning"),
          t("Full road quality zoom"),
          t("Offline maps"),
          t("GPX export"),
        ],
      },
      {
        tier: "premium",
        name: tierLabel("premium", t),
        priceLabel: formatSubscriptionPriceLabel("premium"),
        features: [
          t("Everything in Pro"),
          t("Unlimited group rides"),
          t("Priority hazard alerts"),
          t("Advanced analytics"),
        ],
      },
    ],
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
        amountLabel: formatSubscriptionAmountLabel("pro"),
        status: "paid",
        invoiceUrl: null,
      },
      {
        id: "preview-invoice-2026-02",
        date: "2026-02-15T00:00:00.000Z",
        amountLabel: formatSubscriptionAmountLabel("pro"),
        status: "paid",
        invoiceUrl: null,
      },
    ],
    portalAvailable: false,
    preview: true,
  };
}

export function normalizeSubscriptionSnapshot(
  raw: unknown,
  t: LooseTranslate,
): SubscriptionSnapshot {
  const fallback = buildFallbackSubscriptionSnapshot(t);
  const root = asRecord(raw);

  const currentPlanRaw = asRecord(root.current_plan);
  const normalizedTier = normalizeTier(currentPlanRaw.tier);
  const normalizedStatus = normalizeStatus(currentPlanRaw.status);
  const normalizedPriceLabel = optionalString(currentPlanRaw.price_label);
  const preview =
    normalizedTier === null ||
    normalizedStatus === null ||
    normalizedPriceLabel === null;
  const currentTier = normalizedTier ?? fallback.currentPlan.tier;
  const currentPlan: CurrentSubscriptionPlan = {
    tier: currentTier,
    name: stringOr(currentPlanRaw.name, tierLabel(currentTier, t)),
    status: normalizedStatus ?? fallback.currentPlan.status,
    priceLabel: normalizedPriceLabel ?? fallback.currentPlan.priceLabel,
    renewsAt: optionalString(currentPlanRaw.renews_at),
    cancelAtPeriodEnd: Boolean(currentPlanRaw.cancel_at_period_end),
    manageUrl: normalizeUrl(currentPlanRaw.manage_url),
  };

  const plans = normalizePlans(root.plans, fallback.plans, t);
  const currentInPlans = plans.some((plan) => plan.tier === currentPlan.tier);

  return {
    currentPlan,
    plans: currentInPlans
      ? plans
      : sortPlans([...plans, buildPlanFromCurrent(currentPlan, t)]),
    paymentMethod: normalizePaymentMethod(root.payment_method),
    billingHistory: normalizeInvoices(root.billing_history, t),
    portalAvailable:
      Boolean(root.portal_available) || currentPlan.manageUrl !== null,
    preview,
  };
}

export function shouldUseSubscriptionPreview(error: unknown): boolean {
  return (
    (error instanceof ApiError ? error.status : getErrorStatus(error)) === 404
  );
}

export function tierLabel(tier: SubscriptionTier, t: LooseTranslate): string {
  if (tier === "pro") return t("Pro");
  if (tier === "premium") return t("Premium");
  return t("Free");
}

export function planActionLabel(
  planTier: SubscriptionTier,
  currentTier: SubscriptionTier,
  t: LooseTranslate,
): string {
  if (planTier === currentTier) return t("Current plan");
  return TIER_ORDER[planTier] > TIER_ORDER[currentTier]
    ? t("Upgrade")
    : t("Downgrade");
}

export function describeRenewal(
  plan: CurrentSubscriptionPlan,
  format: Formatters,
  t: LooseTranslate,
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
  t: LooseTranslate,
): string {
  return t("{brand} ending in {last4}", {
    brand: titleCase(paymentMethod.brand, t),
    last4: paymentMethod.last4,
  });
}

export function formatPaymentMethodExpiry(
  paymentMethod: SubscriptionPaymentMethod,
  t: LooseTranslate,
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
  t: LooseTranslate,
): string {
  if (status === "open") return t("Open");
  if (status === "refunded") return t("Refunded");
  return t("Paid");
}

function normalizePlans(
  rawPlans: unknown,
  fallbackPlans: SubscriptionPlanSummary[],
  t: LooseTranslate,
): SubscriptionPlanSummary[] {
  if (!Array.isArray(rawPlans) || rawPlans.length === 0) {
    return fallbackPlans;
  }

  const normalized = rawPlans
    .map((entry) => {
      const rawPlan = asRecord(entry);
      const tier = normalizeTier(rawPlan.tier);
      if (!tier) return null;
      const features =
        Array.isArray(rawPlan.features) && rawPlan.features.length > 0
          ? rawPlan.features
              .map((feature) =>
                typeof feature === "string" ? feature.trim() : "",
              )
              .filter(Boolean)
          : DEFAULT_PLAN_FEATURES[tier].map((feature) => t(feature));
      return {
        tier,
        name: stringOr(rawPlan.name, tierLabel(tier, t)),
        priceLabel: stringOr(
          rawPlan.price_label,
          formatSubscriptionPriceLabel(tier),
        ),
        features,
        description: optionalString(rawPlan.description) ?? undefined,
        highlighted: Boolean(rawPlan.highlighted),
      } as SubscriptionPlanSummary;
    })
    .filter((plan): plan is SubscriptionPlanSummary => plan !== null);

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
  t: LooseTranslate,
): SubscriptionInvoice[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      const invoice = asRecord(entry);
      const id = stringOr(invoice.id, `invoice-${index + 1}`);
      const date = optionalString(invoice.date);
      const amountLabel = stringOr(invoice.amount_label, t("Unavailable"));
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

function normalizeInvoiceStatus(value: unknown): InvoiceStatus | null {
  return value === "paid" || value === "open" || value === "refunded"
    ? value
    : null;
}

function buildPlanFromCurrent(
  currentPlan: CurrentSubscriptionPlan,
  t: LooseTranslate,
): SubscriptionPlanSummary {
  return {
    tier: currentPlan.tier,
    name: currentPlan.name,
    priceLabel: currentPlan.priceLabel,
    features: DEFAULT_PLAN_FEATURES[currentPlan.tier].map((feature) =>
      t(feature),
    ),
  };
}

function sortPlans(
  plans: SubscriptionPlanSummary[],
): SubscriptionPlanSummary[] {
  return [...plans].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
}

function titleCase(value: string, t: LooseTranslate): string {
  if (!value) return t("Card");
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
