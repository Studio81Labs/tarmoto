"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useEntitlements } from "@/hooks/useEntitlements";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  BadgeCheck,
  CalendarClock,
  Check,
  CreditCard,
  ExternalLink,
  Receipt,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { Button, Card, Heading, SkeletonForm, Stamp } from "@tarmoto/ui";
import type { Formatters } from "@tarmoto/shared";
import { useFormat } from "@/format/FormatProvider";
import { SUBSCRIPTION_STATUS_LABELS } from "@/i18n/domainLabels";
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
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
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
export default function SubscriptionPage() {
  const t = useTranslation();
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
  const format = useFormat();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Stripe Checkout redirects back with `?checkout=success|canceled` (see the
  // backend `success_url`/`cancel_url`). Surface a confirmation/notice, then
  // strip the param so a refresh or Back doesn't re-show the banner.
  const [checkoutReturn, setCheckoutReturn] = useState<
    "success" | "canceled" | null
  >(null);
  // True while we're waiting for the Stripe webhook to sync the DB tier after a
  // successful checkout. Its own state so the poll below can't be torn down by
  // the search-param cleanup (which reruns the param effect).
  const [awaitingPaidSync, setAwaitingPaidSync] = useState(false);
  // Mount the entitlements query so `/users/me` is an ACTIVE query — otherwise
  // `refetchQueries` below is a no-op (react-query only refetches active
  // queries) and the poll couldn't observe the webhook-synced tier at all.
  useEntitlements();
  useEffect(() => {
    // Entitlements (tier/features/limits) may have changed via checkout/portal.
    void queryClient.invalidateQueries({ queryKey: ["users-me"] });
  }, [queryClient]);
  useEffect(() => {
    const checkout = searchParams.get("checkout");
    if (checkout !== "success" && checkout !== "canceled") return;
    setCheckoutReturn(checkout);
    if (checkout === "success") setAwaitingPaidSync(true);
    router.replace(pathname, { scroll: false });
  }, [searchParams, router, pathname]);
  // Live subscription snapshot (Stripe) — the authoritative NEW tier after
  // checkout; the poll waits for the entitlement cache to reach THIS tier.
  const liveTier =
    state.kind === "loaded" ? state.snapshot.currentPlan.tier : null;
  const liveTierRef = useRef(liveTier);
  liveTierRef.current = liveTier;
  useEffect(() => {
    if (!awaitingPaidSync) return;
    // The Stripe webhook that writes the paid tier to the DB may still be in
    // flight, so a single refetch can read `/users/me` BEFORE the tier flips.
    // POLL `refetchQueries` on a backoff until the cached entitlement tier
    // reaches the LIVE subscription tier (not merely "any paid tier" — a
    // Premium→Pro change starts non-Free), or we exhaust the attempts (bounded
    // so an abandoned/void checkout can't loop).
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const backoffMs = [0, 1500, 3000, 6000, 12000, 20000];
    let attempt = 0;
    const poll = async () => {
      if (cancelled) return;
      const target = liveTierRef.current;
      // No paid tier to wait for yet (snapshot still loading) — retry; if it
      // resolved to Free there's nothing to sync.
      if (target === "free") {
        setAwaitingPaidSync(false);
        return;
      }
      if (target !== null) {
        await queryClient.refetchQueries({ queryKey: ["users-me"] });
        if (cancelled) return;
        const synced = queryClient
          .getQueriesData<{ subscription_tier?: string }>({
            queryKey: ["users-me"],
          })
          .some(([, data]) => data?.subscription_tier === target);
        if (synced) {
          setAwaitingPaidSync(false);
          return;
        }
      }
      attempt += 1;
      if (attempt >= backoffMs.length) {
        setAwaitingPaidSync(false);
        return;
      }
      timer = setTimeout(() => void poll(), backoffMs[attempt]);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [awaitingPaidSync, queryClient]);
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    accountApi
      .getSubscription()
      .then(({ data }) => {
        if (cancelled) return;
        setState({
          kind: "loaded",
          snapshot: normalizeSubscriptionSnapshot(data, t, format.locale),
        });
      })
      .catch((error) => {
        if (cancelled) return;
        if (shouldUseSubscriptionPreview(error)) {
          setState({
            kind: "loaded",
            snapshot: buildFallbackSubscriptionSnapshot(t, format.locale),
          });
          return;
        }
        setState({
          kind: "error",
          message: getUserFacingErrorMessage(
            error,
            t("Could not load subscription settings."),
          ),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [t, authReady, format.locale]);
  const snapshot = state.kind === "loaded" ? state.snapshot : null;
  const renewalLabel = useMemo(
    () => (snapshot ? describeRenewal(snapshot.currentPlan, format, t) : ""),
    [t, snapshot, format],
  );
  async function openCheckout(tier: "premium" | "pro") {
    setActionState({ kind: `checkout-${tier}`, error: null });
    try {
      const { data } = await accountApi.createCheckoutSession({ tier });
      window.location.assign(data.url);
    } catch (error) {
      setActionState({
        kind: null,
        error: getUserFacingErrorMessage(
          error,
          t("Could not start Stripe Checkout."),
        ),
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
        error: getUserFacingErrorMessage(
          error,
          t("Could not open the billing portal."),
        ),
      });
    }
  }
  // A paid tier with a canceled status means there is no live Stripe
  // subscription behind the plan — an operator grant (launch-mode
  // `founder`, promo, or admin), or a grant whose Checkout was started
  // and abandoned (which already persisted a Stripe customer, so
  // `portalAvailable` alone cannot identify grants). The portal's
  // subscription flows would be rejected without a subscription id, but
  // Checkout is open: the backend only blocks it for ACTIVE paid
  // subscriptions. Route these users through Checkout so they can
  // convert the grant to a paid plan (same tier) or pick the other paid
  // tier. Preview snapshots stay inert — their synthesized plan isn't a
  // real grant.
  const paidPlanNeedsCheckout =
    snapshot !== null &&
    !snapshot.preview &&
    snapshot.currentPlan.tier !== "free" &&
    snapshot.currentPlan.status === "canceled";
  function handlePlanAction(planTier: SubscriptionTier) {
    if (!snapshot) return;
    if (paidPlanNeedsCheckout) {
      // No subscription to manage/cancel via the portal; every plan
      // action is a Checkout.
      if (planTier === "free") return;
      void openCheckout(planTier as "premium" | "pro");
      return;
    }
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
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      <SettingsSubpageHeader
        stamp={t("Settings · Subscription")}
        icon={<CreditCard size={18} strokeWidth={2} />}
        title={t("Subscription")}
        sub={t(
          "Manage your plan, payment method, billing history, and renewal choices from one place.",
        )}
        right={
          snapshot?.portalAvailable ? (
            <Button
              variant="secondary"
              size="sm"
              uppercase
              disabled={billingBusy}
              loading={actionState.kind === "portal-manage"}
              rightIcon={<ExternalLink size={14} />}
              onClick={() => void openPortal("manage")}
            >
              {actionState.kind === "portal-manage"
                ? t("Opening billing portal…")
                : t("Open billing portal")}
            </Button>
          ) : null
        }
      />

      {checkoutReturn ? (
        <div
          className={`mb-6 flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
            checkoutReturn === "success"
              ? "border-quality-q5/30 bg-quality-q5/10 text-green-700"
              : "border-accent/30 bg-accent/10 text-ink"
          }`}
          role="status"
        >
          <span>
            {checkoutReturn === "success"
              ? t(
                  "Payment successful — your subscription is being activated. Your plan below updates within a moment.",
                )
              : t("Checkout canceled — no changes were made to your plan.")}
          </span>
          <button
            type="button"
            aria-label={t("Dismiss")}
            className="shrink-0 opacity-70 transition hover:opacity-100"
            onClick={() => setCheckoutReturn(null)}
          >
            <X size={16} />
          </button>
        </div>
      ) : null}

      {actionState.error ? (
        <div className="mb-6 rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-700">
          {actionState.error}
        </div>
      ) : null}

      {state.kind === "loading" ? (
        <LoadingState />
      ) : state.kind === "error" ? (
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-700">
          {state.message}
        </div>
      ) : snapshot ? (
        <>
          {snapshot.preview ? (
            <div className="mb-6 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-ink">
              {t(
                "Preview data shown while live billing management is still being wired up.",
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
              {t("Plan comparison")}
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
                  paidPlanNeedsCheckout={paidPlanNeedsCheckout}
                  onSelect={() => handlePlanAction(plan.tier)}
                />
              ))}
            </div>
          </section>

          <section className="mb-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <BillingHistoryCard snapshot={snapshot} format={format} />
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
              // A grant has no subscription for the portal's cancel flow
              // to act on — even when an abandoned Checkout has already
              // created the Stripe customer (portalAvailable true).
              canManage={snapshot.portalAvailable && !paidPlanNeedsCheckout}
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
  const t = useTranslation();
  const { currentPlan } = snapshot;
  // Ink hero card per spec — paired with the canonical Card variant so
  // padding / radius track the design system instead of inline values.
  return (
    <Card variant="ink" padded={false} className="p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Stamp tone="accent" className="block">
            {t("Current plan")}
          </Stamp>
          <div className="mt-2 flex items-center gap-3">
            <Heading size="lg" as="h2" className="text-cream">
              {currentPlan.name}
            </Heading>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-[5px] text-[11px] font-bold tracking-[0.2px] ${STATUS_STYLES[currentPlan.status]}`}
            >
              {t(SUBSCRIPTION_STATUS_LABELS[currentPlan.status])}
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-accent/30 bg-accent/15 px-4 py-3 text-right">
          <Stamp tone="accent" className="block">
            {t("Billing")}
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
            {t("Renewal")}
          </div>
          <p className="text-[14px] text-fg-on-dark-dim">{renewalLabel}</p>
        </div>

        <div className="rounded-xl border border-line-on-dark bg-tarmac/60 p-4">
          <div className="mb-2 inline-flex items-center gap-2 text-[14px] font-semibold text-cream">
            <BadgeCheck size={15} className="text-fg-on-dark-dim" />
            {t("Included right now")}
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
  const t = useTranslation();
  const paymentMethod = snapshot.paymentMethod;
  return (
    <Card padded={false} className="p-6">
      <div className="mb-4 inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
        <CreditCard size={16} className="text-fg-mute" />
        {t("Payment method")}
      </div>

      {paymentMethod ? (
        <div className="rounded-xl border border-line bg-paper p-4">
          <p className="text-[18px] font-semibold text-ink">
            {formatPaymentMethodLabel(paymentMethod, t)}
          </p>
          <p className="mt-1 text-[14px] text-fg-dim">
            {formatPaymentMethodExpiry(paymentMethod, t)}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-line-strong bg-paper p-4 text-[14px] text-fg-dim">
          {t(
            "No payment method on file yet. Upgrades and invoices will appear here once billing is connected.",
          )}
        </div>
      )}

      <div className="mt-4 space-y-2 text-[14px] text-fg-dim">
        <p>
          {t(
            "Billing changes flow through the same portal used for upgrades, downgrades, and invoices so web and mobile stay in sync.",
          )}
        </p>
        {snapshot.portalAvailable ? (
          <Button
            variant="secondary"
            size="sm"
            uppercase
            disabled={busy}
            loading={updateBusy}
            rightIcon={<ExternalLink size={14} />}
            onClick={onUpdatePaymentMethod}
          >
            {updateBusy
              ? t("Opening payment settings…")
              : t("Update payment method")}
          </Button>
        ) : (
          <p className="rounded-xl border border-line bg-paper px-3 py-2 text-fg-dim">
            {t(
              "Payment method editing will light up automatically as soon as the billing backend is available.",
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
  paidPlanNeedsCheckout,
}: {
  plan: SubscriptionPlanSummary;
  currentTier: SubscriptionTier;
  onSelect: () => void;
  busy: boolean;
  actionBusy: boolean;
  portalAvailable: boolean;
  paidPlanNeedsCheckout: boolean;
}) {
  const t = useTranslation();
  const isCurrent = plan.tier === currentTier;
  // Granted paid tier (no live subscription behind it): every paid card
  // routes to Checkout — the current one reads "Subscribe" (convert the
  // grant to a paid subscription); only the free card is inert (there is
  // no subscription for the portal's cancel flow to act on).
  const actionLabel =
    paidPlanNeedsCheckout && isCurrent
      ? t("Subscribe")
      : planActionLabel(plan.tier, currentTier, t);
  const disabled =
    busy ||
    (paidPlanNeedsCheckout
      ? plan.tier === "free"
      : (!isCurrent && currentTier !== "free" && !portalAvailable) ||
        (isCurrent && !portalAvailable));
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

      <Button
        variant={isCurrent ? "secondary" : "accent"}
        size="sm"
        block
        uppercase
        className="mt-6"
        disabled={disabled}
        loading={actionBusy}
        rightIcon={!isCurrent ? <ExternalLink size={14} /> : undefined}
        onClick={onSelect}
      >
        {actionBusy ? t("Opening…") : actionLabel}
      </Button>
    </article>
  );
}
function BillingHistoryCard({
  snapshot,
  format,
}: {
  snapshot: SubscriptionSnapshot;
  format: Formatters;
}) {
  const t = useTranslation();
  return (
    <Card padded={false} className="p-6">
      <div className="mb-4 inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
        <Receipt size={16} className="text-fg-mute" />
        {t("Billing history")}
      </div>

      {snapshot.billingHistory.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-paper p-4 text-[14px] text-fg-dim">
          {t(
            "Your invoices will appear here once the first subscription charge is created.",
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
                  {formatInvoiceDate(invoice.date, format)}
                </p>
                <p className="mt-1 text-[14px] text-fg-dim">
                  {invoice.amountLabel} ·{" "}
                  {invoiceStatusLabel(invoice.status, t)}
                </p>
              </div>

              {invoice.invoiceUrl ? (
                <Link
                  href={invoice.invoiceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-[14px] font-semibold text-accent transition hover:brightness-95"
                >
                  {t("Download invoice")}
                  <ExternalLink size={14} />
                </Link>
              ) : (
                <span className="text-[14px] text-fg-mute">
                  {t("Invoice unavailable")}
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
  const t = useTranslation();
  return (
    <Card padded={false} className="border-quality-q2/40 bg-quality-q2/15 p-6">
      <div className="mb-3 inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
        <ShieldAlert size={16} className="text-amber-700" />
        {t("Cancellation options")}
      </div>
      <p className="text-[14px] text-ink">
        {currentTier === "free"
          ? t("You’re currently on Free, so there is nothing to cancel.")
          : t(
              "{renewal}. If you need to scale back, we will show a lower-friction option before you leave.",
              { renewal: renewalLabel },
            )}
      </p>
      <Button
        variant="danger"
        size="sm"
        uppercase
        className="mt-5"
        disabled={currentTier === "free"}
        onClick={onCancel}
      >
        {t("Cancel subscription")}
      </Button>
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
  const t = useTranslation();
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
            "If timing is the issue, downgrading keeps your ride history and billing continuity intact.",
          )}
        </p>

        <div className="mt-5 rounded-xl border border-line bg-paper p-4">
          <p className="text-[14px] font-semibold text-ink">
            {t("Downgrade to Free at the end of your current billing period.")}
          </p>
          <p className="mt-1 text-[14px] text-fg-dim">
            {t(
              "{renewalLabel}. Your shared rides and account settings stay intact, while {planName}-only perks switch off after the current cycle ends.",
              { renewalLabel, planName },
            )}
          </p>
        </div>

        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" size="sm" uppercase onClick={onClose}>
            {t("Keep {plan}", { plan: planName })}
          </Button>

          {canManage ? (
            <Button
              variant="accent"
              size="sm"
              uppercase
              disabled={busy}
              loading={busy}
              rightIcon={<ExternalLink size={14} />}
              onClick={onOpenPortal}
            >
              {busy ? t("Opening billing portal…") : t("Open billing portal")}
            </Button>
          ) : (
            <Button variant="accent" size="sm" uppercase disabled>
              {t("Billing portal unavailable")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
function LoadingState() {
  const t = useTranslation();
  // Mounted only while loading, so the flag is constant `true` — the hook
  // still debounces the spinner so fast loads never flash it.
  const showLoader = useDelayedLoading(true);
  if (!showLoader) return null;
  return (
    <SkeletonForm sections={2} label={t("Loading subscription settings…")} />
  );
}
