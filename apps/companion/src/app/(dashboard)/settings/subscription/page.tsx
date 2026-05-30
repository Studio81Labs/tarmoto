"use client";
import { t } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
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
import { Card, Heading, Stamp } from "@tarmoto/ui";
import { SettingsSubpageHeader } from "../_SettingsSubpageHeader";
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
  | { kind: "loading" }
  | { kind: "loaded"; snapshot: SubscriptionSnapshot }
  | { kind: "error"; message: string };
type BillingAction =
  | "portal-manage"
  | "portal-payment-method"
  | "portal-cancel"
  | "portal-update"
  | "checkout-premium"
  | "checkout-pro";
// Status pills render inside the `bg-ink` CurrentPlanCard panel, so the
// text needs to read against dark. Use the pure q-scale / accent hues
// for text (bright on ink) over translucent same-hue backgrounds rather
// than the darkened `*-700` text utilities that pair with cream.
const STATUS_STYLES: Record<SubscriptionStatus, string> = {
  active: "bg-quality-q5/25 text-quality-q5 border-quality-q5/50",
  trialing: "bg-accent/20 text-accent border-accent/50",
  past_due: "bg-quality-q2/30 text-quality-q2 border-quality-q2/55",
  canceled: "bg-quality-q1/25 text-quality-q1 border-quality-q1/55",
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
    <div className="mx-auto w-full max-w-page animate-fade-in p-7">
      <SettingsSubpageHeader
        stamp={t("Settings · Subscription")}
        icon={<CreditCard size={18} strokeWidth={2} />}
        title={t("Subscription")}
        sub={t(
          "Manage your plan, payment method, billing history, and renewal choices from one place.",
        )}
        right={
          snapshot?.portalAvailable ? (
            <button
              type="button"
              onClick={() => void openPortal("manage")}
              disabled={billingBusy}
              className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-cream px-4 py-[5px] text-[11px] font-bold uppercase tracking-[0.2px] text-ink transition hover:bg-paper disabled:opacity-50"
            >
              {actionState.kind === "portal-manage" ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {t("Opening billing portal… ")}
                </>
              ) : (
                <>
                  {t("Open billing portal ")}
                  <ExternalLink size={14} />
                </>
              )}
            </button>
          ) : null
        }
      />

      {actionState.error ? (
        <div className="mb-6 rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-400">
          {actionState.error}
        </div>
      ) : null}

      {state.kind === "loading" ? (
        <LoadingState />
      ) : state.kind === "error" ? (
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
          {state.message}
        </div>
      ) : snapshot ? (
        <>
          {snapshot.preview ? (
            <div className="mb-6 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-ink">
              {t(
                "Preview data shown while live billing management is still being wired up. ",
              )}
            </div>
          ) : null}

          <section className="mb-4 grid gap-4 lg:grid-cols-[1.25fr_0.95fr]">
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

          <section className="mb-4">
            <div className="mb-3 inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
              <Sparkles size={16} className="text-accent" />
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

          <section className="mb-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
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
  // Ink hero card per spec — paired with the canonical Card variant so
  // padding / radius track the design system instead of inline values.
  return (
    <Card variant="ink" padded={false} className="p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Stamp tone="accent" className="block">
            {t("Current plan ")}
          </Stamp>
          <div className="mt-2 flex items-center gap-3">
            <Heading size="lg" as="h2" className="text-cream">
              {currentPlan.name}
            </Heading>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-[5px] text-[11px] font-bold tracking-[0.2px] ${STATUS_STYLES[currentPlan.status]}`}
            >
              {STATUS_LABELS[currentPlan.status]}
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-accent/30 bg-accent/15 px-4 py-3 text-right">
          <Stamp tone="accent" className="block">
            {t("Billing ")}
          </Stamp>
          <p className="mt-1 text-2xl font-extrabold text-accent">
            {currentPlan.priceLabel}
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-line-on-dark bg-tarmac/60 p-4">
          <div className="mb-2 inline-flex items-center gap-2 text-[14px] font-semibold text-cream">
            <CalendarClock size={15} className="text-fg-on-dark-dim" />
            {t("Renewal ")}
          </div>
          <p className="text-[14px] text-fg-on-dark-dim">{renewalLabel}</p>
        </div>

        <div className="rounded-xl border border-line-on-dark bg-tarmac/60 p-4">
          <div className="mb-2 inline-flex items-center gap-2 text-[14px] font-semibold text-cream">
            <BadgeCheck size={15} className="text-fg-on-dark-dim" />
            {t("Included right now ")}
          </div>
          <ul className="space-y-2 text-[14px] text-fg-on-dark-dim">
            {snapshot.plans
              .find((plan) => plan.tier === currentPlan.tier)
              ?.features.slice(0, 3)
              .map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <Check size={14} className="mt-0.5 shrink-0 text-accent" />
                  <span>{feature}</span>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </Card>
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
    <Card padded={false} className="p-6">
      <div className="mb-4 inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
        <CreditCard size={16} className="text-fg-mute" />
        {t("Payment method ")}
      </div>

      {paymentMethod ? (
        <div className="rounded-xl border border-line bg-paper p-4">
          <p className="text-[18px] font-semibold text-ink">
            {formatPaymentMethodLabel(paymentMethod)}
          </p>
          <p className="mt-1 text-[14px] text-fg-dim">
            {formatPaymentMethodExpiry(paymentMethod)}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-line-strong bg-paper p-4 text-[14px] text-fg-dim">
          {t(
            "No payment method on file yet. Upgrades and invoices will appear here once billing is connected. ",
          )}
        </div>
      )}

      <div className="mt-4 space-y-2 text-[14px] text-fg-dim">
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
            className="inline-flex items-center gap-2 rounded-full border border-line-strong px-4 py-[5px] text-[11px] font-bold uppercase tracking-[0.2px] text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-60"
          >
            {updateBusy ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {t("Opening payment settings… ")}
              </>
            ) : (
              <>
                {t("Update payment method ")}
                <ExternalLink size={14} />
              </>
            )}
          </button>
        ) : (
          <p className="rounded-xl border border-line bg-paper px-3 py-2 text-fg-dim">
            {t(
              "Payment method editing will light up automatically as soon as the billing backend is available. ",
            )}
          </p>
        )}
      </div>
    </Card>
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
      className={
        isCurrent
          ? "rounded-[14px] border border-accent/40 bg-accent/10 p-6"
          : plan.highlighted
            ? "rounded-[14px] border border-accent/30 bg-cream p-6"
            : "rounded-[14px] border border-line bg-cream p-6"
      }
    >
      <div className="mb-4">
        <Heading size="md" as="h3">
          {plan.name}
        </Heading>
        <p className="mt-1 text-2xl font-extrabold text-accent">
          {plan.priceLabel}
        </p>
        {plan.description ? (
          <p className="mt-2 text-[14px] text-fg-dim">{plan.description}</p>
        ) : null}
      </div>

      <ul className="space-y-2 text-[14px] text-ink">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2">
            <Check size={14} className="mt-0.5 shrink-0 text-accent" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-busy={actionBusy}
        className={`mt-6 inline-flex w-full items-center justify-center gap-2 rounded-full px-4 py-[5px] text-[11px] font-bold uppercase tracking-[0.2px] transition ${
          isCurrent
            ? "border border-line-strong bg-paper text-ink hover:bg-paper-2"
            : "bg-accent text-ink hover:brightness-95"
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {actionBusy ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            {t("Opening… ")}
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
    <Card padded={false} className="p-6">
      <div className="mb-4 inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
        <Receipt size={16} className="text-fg-mute" />
        {t("Billing history ")}
      </div>

      {snapshot.billingHistory.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-paper p-4 text-[14px] text-fg-dim">
          {t(
            "Your invoices will appear here once the first subscription charge is created. ",
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {snapshot.billingHistory.map((invoice) => (
            <li
              key={invoice.id}
              className="flex flex-col gap-3 rounded-xl border border-line bg-paper p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="font-mono text-[14px] font-semibold text-ink tabular-nums">
                  {formatInvoiceDate(invoice.date)}
                </p>
                <p className="mt-1 text-[14px] text-fg-dim">
                  {invoice.amountLabel} · {invoiceStatusLabel(invoice.status)}
                </p>
              </div>

              {invoice.invoiceUrl ? (
                <Link
                  href={invoice.invoiceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-[14px] font-semibold text-accent transition hover:brightness-95"
                >
                  {t("Download invoice ")}
                  <ExternalLink size={14} />
                </Link>
              ) : (
                <span className="text-[14px] text-fg-mute">
                  {t("Invoice unavailable ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
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
    <Card padded={false} className="border-quality-q2/40 bg-quality-q2/15 p-6">
      <div className="mb-3 inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
        <ShieldAlert size={16} className="text-amber-700" />
        {t("Cancellation options ")}
      </div>
      <p className="text-[14px] text-ink">
        {currentTier === "free"
          ? "You're currently on Free, so there is nothing to cancel."
          : `${renewalLabel}. If you need to scale back, we will show a lower-friction option before you leave.`}
      </p>
      <button
        type="button"
        onClick={onCancel}
        disabled={currentTier === "free"}
        className="mt-5 inline-flex items-center gap-2 rounded-full border border-quality-q2 bg-transparent px-4 py-[5px] text-[11px] font-bold uppercase tracking-[0.2px] text-amber-700 transition hover:bg-quality-q2/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t("Cancel subscription ")}
      </button>
    </Card>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Cancel subscription")}
        className="w-full max-w-lg rounded-[14px] border border-line bg-cream p-6 shadow-[0_24px_60px_rgba(14,14,16,0.2)]"
      >
        <Heading size="md" as="h2">
          {t("Cancel subscription")}
        </Heading>
        <p className="mt-2 text-[14px] text-fg-dim">
          {t(
            "If timing is the issue, downgrading keeps your ride history and billing continuity intact. ",
          )}
        </p>

        <div className="mt-5 rounded-xl border border-line bg-paper p-4">
          <p className="text-[14px] font-semibold text-ink">
            {t("Downgrade to Free at the end of your current billing period. ")}
          </p>
          <p className="mt-1 text-[14px] text-fg-dim">
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
            className="rounded-full border border-line-strong px-4 py-[5px] text-[11px] font-bold uppercase tracking-[0.2px] text-ink transition hover:bg-paper"
          >
            {`Keep ${planName}`}
          </button>

          {canManage ? (
            <button
              type="button"
              onClick={onOpenPortal}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-[11px] font-bold uppercase tracking-[0.2px] text-ink transition hover:brightness-95 disabled:opacity-50"
            >
              {busy ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {t("Opening billing portal… ")}
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
              className="inline-flex items-center justify-center rounded-lg bg-accent/40 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.2px] text-ink"
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
    <Card padded={false} className="p-8">
      <div className="inline-flex items-center gap-2 text-[14px] text-fg-dim">
        <Loader2 size={16} className="animate-spin" />
        {t("Loading subscription settings… ")}
      </div>
    </Card>
  );
}
