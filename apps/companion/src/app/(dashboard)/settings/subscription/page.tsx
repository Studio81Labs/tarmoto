"use client";
import { t } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BadgeCheck,
  CalendarClock,
  Check,
  CreditCard,
  ExternalLink,
  Loader2,
  Receipt,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import {
  buildFallbackSubscriptionSnapshot,
  describeRenewal,
  formatInvoiceDate,
  formatPaymentMethodExpiry,
  formatPaymentMethodLabel,
  invoiceStatusLabel,
  normalizeSubscriptionSnapshot,
  planActionLabel,
  shouldUseSubscriptionPreview,
  type SubscriptionPlanSummary,
  type SubscriptionSnapshot,
  type SubscriptionStatus,
  type SubscriptionTier,
} from "@/lib/subscription";
type LoadState =
  | {
      kind: "loading";
    }
  | {
      kind: "loaded";
      snapshot: SubscriptionSnapshot;
    }
  | {
      kind: "error";
      message: string;
    };
type BillingAction =
  | "portal-manage"
  | "portal-payment-method"
  | "portal-cancel"
  | "portal-update"
  | "checkout-premium"
  | "checkout-pro";
const STATUS_STYLES: Record<SubscriptionStatus, string> = {
  active: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  trialing: "bg-sky-500/10 text-sky-300 border-sky-500/20",
  past_due: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  canceled: "bg-rose-500/10 text-rose-300 border-rose-500/20",
};
const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: "Active",
  trialing: "Trialing",
  past_due: "Payment issue",
  canceled: "Canceled",
};
export default function SubscriptionPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [actionState, setActionState] = useState<{
    kind: BillingAction | null;
    error: string | null;
  }>({ kind: null, error: null });
  // Gate the fetch on the auth store having a token. Without this,
  // a hard reload of `/settings/subscription` races AuthSync — the
  // fetch fires before `accessToken` lands in the store and the API
  // call goes out unauthed, surfacing as a misleading "Unauthorized"
  // banner.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    accountApi
      .getSubscription()
      .then(({ data }) => {
        if (cancelled) return;
        setState({
          kind: "loaded",
          snapshot: normalizeSubscriptionSnapshot(data),
        });
      })
      .catch((error) => {
        if (cancelled) return;
        if (shouldUseSubscriptionPreview(error)) {
          setState({
            kind: "loaded",
            snapshot: buildFallbackSubscriptionSnapshot(),
          });
          return;
        }
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load subscription settings.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [authReady]);
  const snapshot = state.kind === "loaded" ? state.snapshot : null;
  const renewalLabel = useMemo(
    () => (snapshot ? describeRenewal(snapshot.currentPlan) : ""),
    [snapshot],
  );
  async function openCheckout(tier: "premium" | "pro") {
    setActionState({ kind: `checkout-${tier}`, error: null });
    try {
      const { data } = await accountApi.createCheckoutSession({ tier });
      window.location.assign(data.url);
    } catch (error) {
      setActionState({
        kind: null,
        error:
          error instanceof Error
            ? error.message
            : "Could not start Stripe Checkout.",
      });
    }
  }
  async function openPortal(
    flow:
      | "manage"
      | "payment_method_update"
      | "subscription_cancel"
      | "subscription_update",
  ) {
    const kind: BillingAction =
      flow === "manage"
        ? "portal-manage"
        : flow === "payment_method_update"
          ? "portal-payment-method"
          : flow === "subscription_cancel"
            ? "portal-cancel"
            : "portal-update";
    setActionState({ kind, error: null });
    try {
      const { data } = await accountApi.createPortalSession({ flow });
      window.location.assign(data.url);
    } catch (error) {
      setActionState({
        kind: null,
        error:
          error instanceof Error
            ? error.message
            : "Could not open the billing portal.",
      });
    }
  }
  function handlePlanAction(planTier: SubscriptionTier) {
    if (!snapshot) return;
    if (planTier === snapshot.currentPlan.tier) {
      if (!snapshot.portalAvailable) return;
      void openPortal("manage");
      return;
    }
    if (snapshot.currentPlan.tier === "free") {
      void openCheckout(planTier as "premium" | "pro");
      return;
    }
    if (planTier === "free") {
      if (!snapshot.portalAvailable) return;
      void openPortal("subscription_cancel");
      return;
    }
    if (!snapshot.portalAvailable) return;
    void openPortal("subscription_update");
  }
  const billingBusy = actionState.kind !== null;
  return (
    <div className="mx-auto max-w-6xl animate-fade-in p-6">
      <Link
        href="/settings"
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white"
      >
        <ArrowLeft size={16} />
        {t("Settings ")}
      </Link>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("Subscription")}</h1>
          <p className="mt-1 text-sm text-slate-400">
            {t(
              "Manage your plan, payment method, billing history, and renewal choices from one place. ",
            )}
          </p>
        </div>
        {snapshot?.portalAvailable ? (
          <button
            type="button"
            onClick={() => void openPortal("manage")}
            disabled={billingBusy}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-800"
          >
            {actionState.kind === "portal-manage" ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {t("Opening billing portal\u2026 ")}
              </>
            ) : (
              <>
                {t("Open billing portal ")}
                <ExternalLink size={14} />
              </>
            )}
          </button>
        ) : null}
      </div>

      {actionState.error ? (
        <div className="mb-6 rounded-2xl border border-rose-500/20 bg-rose-500/5 px-4 py-3 text-sm text-rose-200">
          {actionState.error}
        </div>
      ) : null}

      {state.kind === "loading" ? (
        <LoadingState />
      ) : state.kind === "error" ? (
        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-5 text-sm text-rose-200">
          {state.message}
        </div>
      ) : snapshot ? (
        <>
          {snapshot.preview ? (
            <div className="mb-6 rounded-2xl border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-sm text-sky-100">
              {t(
                "Preview data shown while live billing management is still being wired up. ",
              )}
            </div>
          ) : null}

          <section className="mb-6 grid gap-4 lg:grid-cols-[1.25fr_0.95fr]">
            <CurrentPlanCard snapshot={snapshot} renewalLabel={renewalLabel} />
            <PaymentMethodCard
              snapshot={snapshot}
              busy={billingBusy}
              onUpdatePaymentMethod={() => {
                if (!snapshot.portalAvailable) return;
                void openPortal("payment_method_update");
              }}
              updateBusy={actionState.kind === "portal-payment-method"}
            />
          </section>

          <section className="mb-6">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Sparkles size={16} className="text-tarmoto-cyan" />
              {t("Plan comparison ")}
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              {snapshot.plans.map((plan) => (
                <PlanCard
                  key={plan.tier}
                  plan={plan}
                  currentTier={snapshot.currentPlan.tier}
                  busy={billingBusy}
                  actionBusy={
                    actionState.kind === `checkout-${plan.tier}` ||
                    actionState.kind === "portal-manage" ||
                    actionState.kind === "portal-cancel" ||
                    actionState.kind === "portal-update"
                  }
                  portalAvailable={snapshot.portalAvailable}
                  onSelect={() => handlePlanAction(plan.tier)}
                />
              ))}
            </div>
          </section>

          <section className="mb-6 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <BillingHistoryCard snapshot={snapshot} />
            <CancelPlanCard
              currentTier={snapshot.currentPlan.tier}
              renewalLabel={renewalLabel}
              onCancel={() => setCancelDialogOpen(true)}
            />
          </section>

          {cancelDialogOpen ? (
            <RetentionDialog
              planName={snapshot.currentPlan.name}
              renewalLabel={renewalLabel}
              canManage={snapshot.portalAvailable}
              busy={actionState.kind === "portal-cancel"}
              onOpenPortal={() => void openPortal("subscription_cancel")}
              onClose={() => setCancelDialogOpen(false)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
function CurrentPlanCard({
  snapshot,
  renewalLabel,
}: {
  snapshot: SubscriptionSnapshot;
  renewalLabel: string;
}) {
  const { currentPlan } = snapshot;
  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
            {t("Current plan ")}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <h2 className="text-3xl font-bold text-white">
              {currentPlan.name}
            </h2>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[currentPlan.status]}`}
            >
              {STATUS_LABELS[currentPlan.status]}
            </span>
          </div>
        </div>
        <div className="rounded-2xl border border-tarmoto-cyan/20 bg-tarmoto-cyan/10 px-4 py-3 text-right">
          <p className="text-xs uppercase tracking-[0.2em] text-tarmoto-cyan/80">
            {t("Billing ")}
          </p>
          <p className="mt-1 text-2xl font-bold text-tarmoto-cyan">
            {currentPlan.priceLabel}
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="mb-2 inline-flex items-center gap-2 text-sm font-medium text-slate-200">
            <CalendarClock size={15} className="text-slate-500" />
            {t("Renewal ")}
          </div>
          <p className="text-sm text-slate-300">{renewalLabel}</p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="mb-2 inline-flex items-center gap-2 text-sm font-medium text-slate-200">
            <BadgeCheck size={15} className="text-slate-500" />
            {t("Included right now ")}
          </div>
          <ul className="space-y-2 text-sm text-slate-300">
            {snapshot.plans
              .find((plan) => plan.tier === currentPlan.tier)
              ?.features.slice(0, 3)
              .map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <Check
                    size={14}
                    className="mt-0.5 shrink-0 text-tarmoto-cyan"
                  />
                  <span>{feature}</span>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
function PaymentMethodCard({
  snapshot,
  onUpdatePaymentMethod,
  busy,
  updateBusy,
}: {
  snapshot: SubscriptionSnapshot;
  onUpdatePaymentMethod: () => void;
  busy: boolean;
  updateBusy: boolean;
}) {
  const paymentMethod = snapshot.paymentMethod;
  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
      <div className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-slate-200">
        <CreditCard size={16} className="text-slate-500" />
        {t("Payment method ")}
      </div>

      {paymentMethod ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-lg font-semibold text-white">
            {formatPaymentMethodLabel(paymentMethod)}
          </p>
          <p className="mt-1 text-sm text-slate-400">
            {formatPaymentMethodExpiry(paymentMethod)}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/40 p-4 text-sm text-slate-400">
          {t(
            "No payment method on file yet. Upgrades and invoices will appear here once billing is connected. ",
          )}
        </div>
      )}

      <div className="mt-4 space-y-2 text-sm text-slate-400">
        <p>
          {t(
            "Billing changes flow through the same portal used for upgrades, downgrades, and invoices so web and mobile stay in sync. ",
          )}
        </p>
        {snapshot.portalAvailable ? (
          <button
            type="button"
            onClick={onUpdatePaymentMethod}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-100 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {updateBusy ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {t("Opening payment settings\u2026 ")}
              </>
            ) : (
              <>
                {t("Update payment method ")}
                <ExternalLink size={14} />
              </>
            )}
          </button>
        ) : (
          <p className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-slate-300">
            {t(
              "Payment method editing will light up automatically as soon as the billing backend is available. ",
            )}
          </p>
        )}
      </div>
    </section>
  );
}
function PlanCard({
  plan,
  currentTier,
  onSelect,
  busy,
  actionBusy,
  portalAvailable,
}: {
  plan: SubscriptionPlanSummary;
  currentTier: SubscriptionTier;
  onSelect: () => void;
  busy: boolean;
  actionBusy: boolean;
  portalAvailable: boolean;
}) {
  const actionLabel = planActionLabel(plan.tier, currentTier);
  const isCurrent = plan.tier === currentTier;
  const disabled =
    busy ||
    (!isCurrent && currentTier !== "free" && !portalAvailable) ||
    (isCurrent && !portalAvailable);
  return (
    <article
      className={`rounded-3xl border p-6 ${
        isCurrent || plan.highlighted
          ? "border-tarmoto-cyan/30 bg-tarmoto-cyan/5"
          : "border-slate-800 bg-slate-900/90"
      }`}
    >
      <div className="mb-4">
        <h3 className="text-lg font-bold text-white">{plan.name}</h3>
        <p className="mt-1 text-2xl font-extrabold text-tarmoto-cyan">
          {plan.priceLabel}
        </p>
        {plan.description ? (
          <p className="mt-2 text-sm text-slate-400">{plan.description}</p>
        ) : null}
      </div>

      <ul className="space-y-2 text-sm text-slate-300">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2">
            <Check size={14} className="mt-0.5 shrink-0 text-tarmoto-cyan" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-busy={actionBusy}
        className={`mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
          isCurrent
            ? "border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
            : "bg-tarmoto-cyan text-slate-950 hover:bg-tarmoto-cyan-light"
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {actionBusy ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            {t("Opening\u2026 ")}
          </>
        ) : (
          <>
            {actionLabel}
            {!isCurrent ? <ExternalLink size={14} /> : null}
          </>
        )}
      </button>
    </article>
  );
}
function BillingHistoryCard({ snapshot }: { snapshot: SubscriptionSnapshot }) {
  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
      <div className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-slate-200">
        <Receipt size={16} className="text-slate-500" />
        {t("Billing history ")}
      </div>

      {snapshot.billingHistory.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/40 p-4 text-sm text-slate-400">
          {t(
            "Your invoices will appear here once the first subscription charge is created. ",
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {snapshot.billingHistory.map((invoice) => (
            <li
              key={invoice.id}
              className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950/50 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-medium text-white">
                  {formatInvoiceDate(invoice.date)}
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  {invoice.amountLabel} · {invoiceStatusLabel(invoice.status)}
                </p>
              </div>

              {invoice.invoiceUrl ? (
                <Link
                  href={invoice.invoiceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-sm font-medium text-tarmoto-cyan transition hover:text-tarmoto-cyan-light"
                >
                  {t("Download invoice ")}
                  <ExternalLink size={14} />
                </Link>
              ) : (
                <span className="text-sm text-slate-500">
                  {t("Invoice unavailable ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
function CancelPlanCard({
  currentTier,
  renewalLabel,
  onCancel,
}: {
  currentTier: SubscriptionTier;
  renewalLabel: string;
  onCancel: () => void;
}) {
  return (
    <section className="rounded-3xl border border-amber-500/20 bg-amber-500/5 p-6">
      <div className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-amber-100">
        <ShieldAlert size={16} className="text-amber-300" />
        {t("Cancellation options ")}
      </div>
      <p className="text-sm text-amber-50">
        {currentTier === "free"
          ? "You're currently on Free, so there is nothing to cancel."
          : `${renewalLabel}. If you need to scale back, we will show a lower-friction option before you leave.`}
      </p>
      <button
        type="button"
        onClick={onCancel}
        disabled={currentTier === "free"}
        className="mt-5 w-full rounded-xl border border-amber-400/30 bg-slate-950/30 px-4 py-2.5 text-sm font-semibold text-amber-50 transition hover:bg-slate-950/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t("Cancel subscription ")}
      </button>
    </section>
  );
}
function RetentionDialog({
  planName,
  renewalLabel,
  canManage,
  busy,
  onOpenPortal,
  onClose,
}: {
  planName: string;
  renewalLabel: string;
  canManage: boolean;
  busy: boolean;
  onOpenPortal: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Cancel subscription")}
        className="w-full max-w-lg rounded-3xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
      >
        <h2 className="text-xl font-bold text-white">
          {t("Cancel subscription")}
        </h2>
        <p className="mt-2 text-sm text-slate-300">
          {t(
            "If timing is the issue, downgrading keeps your ride history and billing continuity intact. ",
          )}
        </p>

        <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
          <p className="text-sm font-medium text-white">
            {t("Downgrade to Free at the end of your current billing period. ")}
          </p>
          <p className="mt-1 text-sm text-slate-400">
            {renewalLabel}
            {t(". Your shared rides and account settings stay intact, while ")}
            {planName}
            {t("-only perks switch off after the current cycle ends. ")}
          </p>
        </div>

        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            {`Keep ${planName}`}
          </button>

          {canManage ? (
            <button
              type="button"
              onClick={onOpenPortal}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-200"
            >
              {busy ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {t("Opening billing portal\u2026 ")}
                </>
              ) : (
                <>
                  {t("Open billing portal ")}
                  <ExternalLink size={14} />
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              disabled
              className="rounded-xl bg-amber-300/40 px-4 py-2.5 text-sm font-semibold text-slate-950"
            >
              {t("Billing portal unavailable ")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
function LoadingState() {
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-8">
      <div className="inline-flex items-center gap-2 text-sm text-slate-300">
        <Loader2 size={16} className="animate-spin" />
        {t("Loading subscription settings\u2026 ")}
      </div>
    </div>
  );
}
