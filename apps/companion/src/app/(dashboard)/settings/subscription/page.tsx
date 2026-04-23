"use client";

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

  useEffect(() => {
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
  }, []);

  const snapshot = state.kind === "loaded" ? state.snapshot : null;
  const renewalLabel = useMemo(
    () => (snapshot ? describeRenewal(snapshot.currentPlan) : ""),
    [snapshot],
  );

  return (
    <div className="mx-auto max-w-6xl animate-fade-in p-6">
      <Link
        href="/settings"
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white"
      >
        <ArrowLeft size={16} /> Settings
      </Link>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Subscription</h1>
          <p className="mt-1 text-sm text-slate-400">
            Manage your plan, payment method, billing history, and renewal
            choices from one place.
          </p>
        </div>
        {snapshot?.currentPlan.manageUrl ? (
          <Link
            href={snapshot.currentPlan.manageUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-800"
          >
            Open billing portal <ExternalLink size={14} />
          </Link>
        ) : null}
      </div>

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
              Preview data shown while live billing management is still being
              wired up.
            </div>
          ) : null}

          <section className="mb-6 grid gap-4 lg:grid-cols-[1.25fr_0.95fr]">
            <CurrentPlanCard snapshot={snapshot} renewalLabel={renewalLabel} />
            <PaymentMethodCard snapshot={snapshot} />
          </section>

          <section className="mb-6">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Sparkles size={16} className="text-tarmoto-cyan" />
              Plan comparison
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              {snapshot.plans.map((plan) => (
                <PlanCard
                  key={plan.tier}
                  plan={plan}
                  currentTier={snapshot.currentPlan.tier}
                  manageUrl={snapshot.currentPlan.manageUrl}
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
              manageUrl={snapshot.currentPlan.manageUrl}
              preview={snapshot.preview}
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
            Current plan
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
            Billing
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
            Renewal
          </div>
          <p className="text-sm text-slate-300">{renewalLabel}</p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="mb-2 inline-flex items-center gap-2 text-sm font-medium text-slate-200">
            <BadgeCheck size={15} className="text-slate-500" />
            Included right now
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

function PaymentMethodCard({ snapshot }: { snapshot: SubscriptionSnapshot }) {
  const paymentMethod = snapshot.paymentMethod;

  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
      <div className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-slate-200">
        <CreditCard size={16} className="text-slate-500" />
        Payment method
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
          No payment method on file yet. Upgrades and invoices will appear here
          once billing is connected.
        </div>
      )}

      <div className="mt-4 space-y-2 text-sm text-slate-400">
        <p>
          Billing changes flow through the same portal used for upgrades,
          downgrades, and invoices so web and mobile stay in sync.
        </p>
        {!snapshot.currentPlan.manageUrl ? (
          <p className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-slate-300">
            Payment method editing will light up automatically as soon as the
            billing backend is available.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function PlanCard({
  plan,
  currentTier,
  manageUrl,
}: {
  plan: SubscriptionPlanSummary;
  currentTier: SubscriptionTier;
  manageUrl: string | null;
}) {
  const actionLabel = planActionLabel(plan.tier, currentTier);
  const isCurrent = plan.tier === currentTier;

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

      {manageUrl ? (
        <Link
          href={manageUrl}
          target="_blank"
          rel="noreferrer"
          className={`mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
            isCurrent
              ? "border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
              : "bg-tarmoto-cyan text-slate-950 hover:bg-tarmoto-cyan-light"
          }`}
        >
          {actionLabel}
          {!isCurrent ? <ExternalLink size={14} /> : null}
        </Link>
      ) : (
        <button
          type="button"
          disabled
          className={`mt-6 w-full rounded-xl px-4 py-2.5 text-sm font-semibold ${
            isCurrent
              ? "border border-slate-700 bg-slate-800 text-slate-300"
              : "bg-slate-800 text-slate-400"
          }`}
        >
          {actionLabel}
        </button>
      )}
    </article>
  );
}

function BillingHistoryCard({ snapshot }: { snapshot: SubscriptionSnapshot }) {
  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
      <div className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-slate-200">
        <Receipt size={16} className="text-slate-500" />
        Billing history
      </div>

      {snapshot.billingHistory.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/40 p-4 text-sm text-slate-400">
          Your invoices will appear here once the first subscription charge is
          created.
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
                  Download invoice <ExternalLink size={14} />
                </Link>
              ) : (
                <span className="text-sm text-slate-500">
                  Invoice unavailable
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
        Cancellation options
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
        Cancel subscription
      </button>
    </section>
  );
}

function RetentionDialog({
  planName,
  renewalLabel,
  manageUrl,
  preview,
  onClose,
}: {
  planName: string;
  renewalLabel: string;
  manageUrl: string | null;
  preview: boolean;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cancel subscription"
        className="w-full max-w-lg rounded-3xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
      >
        <h2 className="text-xl font-bold text-white">Cancel subscription</h2>
        <p className="mt-2 text-sm text-slate-300">
          If timing is the issue, downgrading keeps your ride history and
          billing continuity intact.
        </p>

        <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
          <p className="text-sm font-medium text-white">
            Downgrade to Free at the end of your current billing period.
          </p>
          <p className="mt-1 text-sm text-slate-400">
            {renewalLabel}. Your shared rides and account settings stay intact,
            while {planName}-only perks switch off after the current cycle ends.
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

          {manageUrl ? (
            <Link
              href={manageUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-200"
            >
              Open billing portal <ExternalLink size={14} />
            </Link>
          ) : (
            <button
              type="button"
              disabled
              className="rounded-xl bg-amber-300/40 px-4 py-2.5 text-sm font-semibold text-slate-950"
            >
              {preview ? "Portal coming soon" : "Billing portal unavailable"}
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
        Loading subscription settings…
      </div>
    </div>
  );
}
