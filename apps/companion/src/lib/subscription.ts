import {
  formatSubscriptionAmountLabel,
  formatSubscriptionPriceLabel,
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

const DEFAULT_PLAN_FEATURES: Record<SubscriptionTier, string[]> = {
  free: ["Basic navigation", "Hazard alerts", "1 active trip"],
  premium: ["Unlimited trip planning", "Offline maps", "GPX export"],
  pro: ["Unlimited group rides", "Priority hazard alerts", "API access"],
};

const TIER_ORDER: Record<SubscriptionTier, number> = {
  free: 0,
  premium: 1,
  pro: 2,
};

export function buildFallbackSubscriptionSnapshot(): SubscriptionSnapshot {
  return {
    currentPlan: {
      tier: "premium",
      name: "Premium",
      status: "active",
      priceLabel: formatSubscriptionPriceLabel("premium"),
      renewsAt: "2026-11-15T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      manageUrl: null,
    },
    plans: [
      {
        tier: "free",
        name: "Free",
        priceLabel: formatSubscriptionPriceLabel("free"),
        features: [
          "Basic navigation",
          "Road quality overlay (limited)",
          "Hazard alerts",
          "1 active trip",
        ],
      },
      {
        tier: "premium",
        name: "Premium",
        priceLabel: formatSubscriptionPriceLabel("premium"),
        highlighted: true,
        features: [
          "Unlimited trip planning",
          "Full road quality zoom",
          "Offline maps",
          "GPX export",
        ],
      },
      {
        tier: "pro",
        name: "Pro",
        priceLabel: formatSubscriptionPriceLabel("pro"),
        features: [
          "Everything in Premium",
          "Unlimited group rides",
          "Priority hazard alerts",
          "Advanced analytics",
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
        amountLabel: formatSubscriptionAmountLabel("premium"),
        status: "paid",
        invoiceUrl: null,
      },
      {
        id: "preview-invoice-2026-02",
        date: "2026-02-15T00:00:00.000Z",
        amountLabel: formatSubscriptionAmountLabel("premium"),
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
): SubscriptionSnapshot {
  const fallback = buildFallbackSubscriptionSnapshot();
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
    name: stringOr(currentPlanRaw.name, tierLabel(currentTier)),
    status: normalizedStatus ?? fallback.currentPlan.status,
    priceLabel: normalizedPriceLabel ?? fallback.currentPlan.priceLabel,
    renewsAt: optionalString(currentPlanRaw.renews_at),
    cancelAtPeriodEnd: Boolean(currentPlanRaw.cancel_at_period_end),
    manageUrl: normalizeUrl(currentPlanRaw.manage_url),
  };

  const plans = normalizePlans(root.plans, fallback.plans);
  const currentInPlans = plans.some((plan) => plan.tier === currentPlan.tier);

  return {
    currentPlan,
    plans: currentInPlans
      ? plans
      : sortPlans([...plans, buildPlanFromCurrent(currentPlan)]),
    paymentMethod: normalizePaymentMethod(root.payment_method),
    billingHistory: normalizeInvoices(root.billing_history),
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

export function tierLabel(tier: SubscriptionTier): string {
  if (tier === "pro") return "Pro";
  if (tier === "premium") return "Premium";
  return "Free";
}

export function planActionLabel(
  planTier: SubscriptionTier,
  currentTier: SubscriptionTier,
): string {
  if (planTier === currentTier) return "Current plan";
  return TIER_ORDER[planTier] > TIER_ORDER[currentTier]
    ? "Upgrade"
    : "Downgrade";
}

export function describeRenewal(plan: CurrentSubscriptionPlan): string {
  const date = plan.renewsAt ? formatDate(plan.renewsAt) : null;
  if (plan.cancelAtPeriodEnd && date) {
    return `Downgrades ${date}`;
  }
  if (plan.status === "trialing" && date) {
    return `Trial ends ${date}`;
  }
  if (plan.status === "canceled") {
    return date ? `Access ends ${date}` : "Canceled";
  }
  return date ? `Renews ${date}` : "Billing cycle managed in the portal";
}

export function formatPaymentMethodLabel(
  paymentMethod: SubscriptionPaymentMethod,
): string {
  return `${titleCase(paymentMethod.brand)} ending in ${paymentMethod.last4}`;
}

export function formatPaymentMethodExpiry(
  paymentMethod: SubscriptionPaymentMethod,
): string {
  return `Expires ${String(paymentMethod.expMonth).padStart(2, "0")}/${paymentMethod.expYear}`;
}

export function formatInvoiceDate(date: string): string {
  return formatDate(date);
}

export function invoiceStatusLabel(status: InvoiceStatus): string {
  if (status === "open") return "Open";
  if (status === "refunded") return "Refunded";
  return "Paid";
}

function normalizePlans(
  rawPlans: unknown,
  fallbackPlans: SubscriptionPlanSummary[],
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
          : DEFAULT_PLAN_FEATURES[tier];
      return {
        tier,
        name: stringOr(rawPlan.name, tierLabel(tier)),
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

function normalizeInvoices(raw: unknown): SubscriptionInvoice[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      const invoice = asRecord(entry);
      const id = stringOr(invoice.id, `invoice-${index + 1}`);
      const date = optionalString(invoice.date);
      const amountLabel = stringOr(invoice.amount_label, "Unavailable");
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
): SubscriptionPlanSummary {
  return {
    tier: currentPlan.tier,
    name: currentPlan.name,
    priceLabel: currentPlan.priceLabel,
    features: DEFAULT_PLAN_FEATURES[currentPlan.tier],
  };
}

function sortPlans(
  plans: SubscriptionPlanSummary[],
): SubscriptionPlanSummary[] {
  return [...plans].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "soon";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function titleCase(value: string): string {
  if (!value) return "Card";
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
