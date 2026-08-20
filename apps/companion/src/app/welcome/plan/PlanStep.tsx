"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Check,
  ExternalLink,
  Gift,
  ShieldAlert,
} from "lucide-react";
import { Button, Card, Heading, SkeletonForm, Stamp } from "@tarmoto/ui";
import { INTRO_TRIAL_DAYS } from "@tarmoto/shared";
import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage } from "@/i18n";
import { useFormat } from "@/format/FormatProvider";
import { useAuthStore } from "@/stores/auth";
import { useSystemSwitch } from "@/hooks/useEntitlements";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { accountApi } from "@/lib/api";
import { DASHBOARD_PATH, SUBSCRIPTION_SETTINGS_PATH } from "@/lib/onboarding";
import {
  holdsGrantedPaidPlan,
  normalizeSubscriptionSnapshot,
  upgradeNeedsCheckout,
  type SubscriptionPlanSummary,
  type SubscriptionSnapshot,
} from "@/lib/subscription";

/**
 * What a plan card's button DOES, decided once so the label, the enabled state
 * and the click cannot disagree — the same discipline the billing settings page
 * uses. Signup has no portal cases: the rider either starts a Checkout, walks on
 * with the default tier, or the card is inert.
 */
type PlanStepAction =
  | { kind: "checkout"; tier: "pro" | "premium" }
  | { kind: "skip" }
  | { kind: "none" };

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; snapshot: SubscriptionSnapshot }
  | { kind: "unavailable"; message: string };

/**
 * The post-registration plan selection step (#1173).
 *
 * SKIPPABLE by construction: the account already exists on its tier before this
 * renders, so every exit — "Skip for now", the Free card, an unreachable
 * billing backend — is a plain navigation to the dashboard with nothing to
 * undo. `/settings/subscription` stays the permanent home for the decision.
 */
export function PlanStep() {
  const t = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [checkoutTier, setCheckoutTier] = useState<"pro" | "premium" | null>(
    null,
  );
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  // Gate the fetch on the auth store holding a token: this page is the FIRST
  // thing a just-registered rider sees, so it races `AuthSync` copying the
  // session into the store harder than any other surface. Without the gate the
  // request goes out unauthed and the step reports itself unavailable.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  // An operator has killed new Stripe checkouts, so every control here that
  // would start one is a dead end (`createCheckoutSession` answers 503 before
  // it reaches Stripe). Registration-time CTAs are checkout CTAs. Fails SAFE:
  // unresolved reads as enabled, so a slow `/config/flags` never blanks the
  // step. Portal flows are untouched — this step has none.
  const { enabled: checkoutEnabled } = useSystemSwitch("sys_billing_checkout");

  // Stripe's `success_url`/`cancel_url` are BACKEND-owned and both point at
  // `/settings/subscription`, which already verifies the returned session id
  // against Stripe and polls until the webhook-written tier settles. So a
  // `?checkout=` on THIS route is a rider who navigated back into the step —
  // and re-selling a plan they may have just bought, on a snapshot the webhook
  // has not reached yet, is exactly the wrong answer. Hand the return to the
  // page that owns it, session id intact, rather than growing a second copy of
  // that machinery here.
  const checkoutParam = searchParams.get("checkout");
  const returningFromCheckout =
    checkoutParam === "success" || checkoutParam === "canceled";
  const checkoutSessionId = searchParams.get("session_id");
  useEffect(() => {
    if (!returningFromCheckout || checkoutParam === null) return;
    const forwarded = new URLSearchParams({ checkout: checkoutParam });
    if (checkoutSessionId) forwarded.set("session_id", checkoutSessionId);
    router.replace(`${SUBSCRIPTION_SETTINGS_PATH}?${forwarded.toString()}`);
  }, [returningFromCheckout, checkoutParam, checkoutSessionId, router]);

  useEffect(() => {
    if (!authReady || returningFromCheckout) return;
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
        // A plan step must never trap a rider who has just created an account.
        // Every failure — billing not wired (404), an outage, a lost token —
        // degrades to a step that SAYS so and walks on, rather than to a
        // synthesized preview grid whose Checkout buttons cannot deliver.
        setState({
          kind: "unavailable",
          message: getUserFacingErrorMessage(
            error,
            t("We could not load the plans just now."),
          ),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, returningFromCheckout, t, format.locale]);

  async function openCheckout(tier: "pro" | "premium") {
    setCheckoutTier(tier);
    setCheckoutError(null);
    try {
      const { data } = await accountApi.createCheckoutSession({ tier });
      window.location.assign(data.url);
    } catch (error) {
      setCheckoutTier(null);
      setCheckoutError(
        getUserFacingErrorMessage(error, t("Could not start Stripe Checkout.")),
      );
    }
  }

  function handlePlanAction(action: PlanStepAction) {
    if (action.kind === "checkout") void openCheckout(action.tier);
    if (action.kind === "skip") router.push(DASHBOARD_PATH);
  }

  if (returningFromCheckout) {
    return (
      <StepShell>
        <p className="text-[14px] text-fg-dim" role="status">
          {t("Taking you to your subscription…")}
        </p>
      </StepShell>
    );
  }

  function renderBody() {
    if (state.kind === "loading") return <LoadingState />;
    if (state.kind === "unavailable") {
      return <UnavailableState message={state.message} />;
    }
    const { snapshot } = state;

    // ORDER MATTERS. A launch-gift rider holds a paid tier with no live
    // subscription behind it, which ALSO satisfies `upgradeNeedsCheckout` — on
    // the billing page that grant is deliberately convertible to a paid plan.
    // Here it must not be: the rider was handed this tier seconds ago and
    // selling it straight back to them is incoherent, so the gift is answered
    // before any selling question is asked (#1104, operator decision
    // 2026-08-20). When the operator later turns the gift off, a new rider
    // registers on `free`, reads false here, and gets the selling step — no
    // second switch to flip.
    if (holdsGrantedPaidPlan(snapshot)) {
      const giftedPlan = snapshot.plans.find(
        (plan) => plan.tier === snapshot.currentPlan.tier,
      );
      // `normalizeSubscriptionSnapshot` guarantees the current tier is among
      // `plans`, so the second branch is unreachable today. It still fails
      // TOWARDS the inert panel rather than falling through, because falling
      // through would sell a plan to the rider who was just gifted it — the one
      // outcome this whole branch exists to prevent.
      return giftedPlan ? (
        <GiftState plan={giftedPlan} />
      ) : (
        <UnavailableState message={t("Your plan is already set up.")} />
      );
    }

    // Nothing on this step can start a Checkout for this rider — a live paid
    // subscription (changed through the portal), a store-managed plan, a
    // `past_due` recovery, or a preview snapshot. All of those belong on the
    // billing page, so the step says so and walks on. Derived from the SHARED
    // helper, never a `tier === "free"` read (#1198).
    if (!upgradeNeedsCheckout(snapshot)) {
      return <UnavailableState message={t("Your plan is already set up.")} />;
    }

    return (
      <PlanGrid
        snapshot={snapshot}
        checkoutEnabled={checkoutEnabled}
        checkoutTier={checkoutTier}
        checkoutError={checkoutError}
        onSelect={handlePlanAction}
      />
    );
  }

  return <StepShell>{renderBody()}</StepShell>;
}

/** Standalone signup chrome — this step renders before the rider has ever seen
 *  the dashboard, so it deliberately carries no app shell or sidebar. */
function StepShell({ children }: { children: React.ReactNode }) {
  const t = useTranslation();
  return (
    <main className="mx-auto w-full max-w-page animate-fade-in px-4 py-10 md:px-7 md:py-14">
      <div className="mb-8 text-center">
        <Stamp tone="accent" className="block">
          {t("Welcome aboard")}
        </Stamp>
      </div>
      {children}
    </main>
  );
}

function LoadingState() {
  const t = useTranslation();
  // Mounted only while loading, so the flag is constant `true` — the hook still
  // debounces the spinner so a fast load never flashes it.
  const showLoader = useDelayedLoading(true);
  if (!showLoader) return null;
  return <SkeletonForm sections={2} label={t("Loading plans…")} />;
}

/** Every state in which this step has nothing to sell: the billing backend is
 *  unreachable, or the rider's plan is already managed somewhere else. */
function UnavailableState({ message }: { message: string }) {
  const t = useTranslation();
  return (
    <Card padded={false} className="mx-auto max-w-xl p-6 text-center">
      <Heading size="md" as="h1">
        {t("Your account is ready")}
      </Heading>
      <p className="mt-2 text-[14px] text-fg-dim">{message}</p>
      <p className="mt-2 text-[14px] text-fg-dim">
        {t("You can choose or change your plan any time in settings.")}
      </p>
      <div className="mt-6 flex flex-col items-center gap-3">
        <StartRidingButton />
        <SubscriptionSettingsLink />
      </div>
    </Card>
  );
}

/**
 * The launch gift, acknowledged rather than sold (#1104).
 *
 * The gift is a persisted per-rider grant written at registration, and nothing
 * but registration writes it — so it survives the operator later turning the
 * gift off for new signups. That permanence is the whole promise, and it is why
 * this panel can say the plan "stays yours" without hedging.
 */
function GiftState({ plan }: { plan: SubscriptionPlanSummary }) {
  const t = useTranslation();
  return (
    <Card variant="ink" padded={false} className="mx-auto max-w-xl p-6">
      <div className="mb-4 inline-flex items-center gap-2">
        <Gift size={18} className="text-accent" />
        <Stamp tone="accent">{t("Early rider gift")}</Stamp>
      </div>
      <Heading size="lg" as="h1" className="text-cream">
        {t("{plan} is on us", { plan: plan.name })}
      </Heading>
      <p className="mt-3 text-[14px] text-fg-on-dark-dim">
        {t(
          "You joined early, so your account starts on {plan} — a founding-rider gift, not a trial. It stays yours even after we stop handing it out, and there is nothing to pay and nothing to cancel.",
          { plan: plan.name },
        )}
      </p>

      <div className="mt-5 rounded-xl border border-line-on-dark bg-tarmac/60 p-4">
        <div className="mb-2 text-[14px] font-semibold text-cream">
          {t("What you get")}
        </div>
        <ul className="space-y-2 text-[14px] text-fg-on-dark-dim">
          {plan.features.map((feature) => (
            <li key={feature} className="flex items-start gap-2">
              <Check size={14} className="mt-0.5 shrink-0 text-accent" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-6 flex flex-col items-start gap-3">
        <StartRidingButton />
        <SubscriptionSettingsLink onDark />
      </div>
    </Card>
  );
}

function PlanGrid({
  snapshot,
  checkoutEnabled,
  checkoutTier,
  checkoutError,
  onSelect,
}: {
  snapshot: SubscriptionSnapshot;
  checkoutEnabled: boolean;
  checkoutTier: "pro" | "premium" | null;
  checkoutError: string | null;
  onSelect: (action: PlanStepAction) => void;
}) {
  const t = useTranslation();
  const busy = checkoutTier !== null;
  return (
    <>
      <div className="mb-7 text-center">
        <Heading size="lg" as="h1">
          {t("Choose how you ride")}
        </Heading>
        <p className="mx-auto mt-2 max-w-xl text-[14px] text-fg-dim">
          {t(
            "Start on Free and upgrade whenever you want, or pick a paid plan now. You can change this any time in settings.",
          )}
        </p>
      </div>

      {checkoutError ? (
        <div className="mx-auto mb-5 max-w-xl rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-700">
          {checkoutError}
        </div>
      ) : null}

      {!checkoutEnabled ? (
        <div
          className="mx-auto mb-5 flex max-w-xl items-start gap-2 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-ink"
          role="status"
        >
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <span>
            {t(
              "New subscriptions are temporarily unavailable. Please try again later.",
            )}
          </span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {snapshot.plans.map((plan) => {
          const action = planActionFor(plan, snapshot);
          return (
            <PlanCard
              key={plan.tier}
              plan={plan}
              action={action}
              busy={busy}
              actionBusy={
                action.kind === "checkout" && checkoutTier === action.tier
              }
              // A checkout an operator has killed. Only those: the Free card's
              // "continue" is a navigation, not a subscription.
              checkoutBlocked={!checkoutEnabled && action.kind === "checkout"}
              // Eligibility ALONE is not the condition — the badge reads the
              // same routing the button uses, so a trial is never advertised on
              // a click that cannot start one (the settings page's rule, #1198).
              offersTrial={snapshot.trialEligible && action.kind === "checkout"}
              onSelect={() => onSelect(action)}
            />
          );
        })}
      </div>

      <div className="mt-8 text-center">
        <button
          type="button"
          className="text-[14px] font-semibold text-fg-dim underline underline-offset-4 transition hover:text-ink"
          onClick={() => onSelect({ kind: "skip" })}
        >
          {t("Skip for now")}
        </button>
      </div>
    </>
  );
}

/**
 * What clicking a card does. The Free card is the skip path wearing a plan
 * card; the paid cards defer to the SHARED `upgradeNeedsCheckout`.
 *
 * The `none` arm is unreachable while the grid's only caller renders it behind
 * that same helper — it is kept so the card's label, enabled state and click all
 * read ONE answer, rather than inheriting a precondition from a caller two
 * components up.
 */
function planActionFor(
  plan: SubscriptionPlanSummary,
  snapshot: SubscriptionSnapshot,
): PlanStepAction {
  if (plan.tier === "free") return { kind: "skip" };
  return upgradeNeedsCheckout(snapshot)
    ? { kind: "checkout", tier: plan.tier }
    : { kind: "none" };
}

function PlanCard({
  plan,
  action,
  busy,
  actionBusy,
  checkoutBlocked,
  offersTrial,
  onSelect,
}: {
  plan: SubscriptionPlanSummary;
  action: PlanStepAction;
  busy: boolean;
  actionBusy: boolean;
  checkoutBlocked: boolean;
  offersTrial: boolean;
  onSelect: () => void;
}) {
  const t = useTranslation();
  // Signup framing: a trial CTA promises the trial, and the paid CTA names the
  // plan rather than saying "upgrade" — there is nothing to upgrade FROM in a
  // flow that started ninety seconds ago.
  const label =
    action.kind === "skip"
      ? t("Continue on Free")
      : offersTrial
        ? t("Start free trial")
        : t("Choose {plan}", { plan: plan.name });
  const disabled = busy || checkoutBlocked || action.kind === "none";
  return (
    <article
      className={
        plan.highlighted
          ? "rounded-[14px] border border-accent/40 bg-accent/10 p-6"
          : "rounded-[14px] border border-line bg-cream p-6"
      }
    >
      <div className="mb-4">
        <Heading size="md" as="h2">
          {plan.name}
        </Heading>
        <p className="mt-1 text-2xl font-extrabold text-accent">
          {plan.priceLabel}
        </p>
        {offersTrial ? (
          <Stamp className="mt-2 inline-block rounded-full bg-accent/15 px-2.5 py-1 text-accent">
            {t("{days} days free", { days: INTRO_TRIAL_DAYS })}
          </Stamp>
        ) : null}
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
        variant={action.kind === "checkout" ? "accent" : "secondary"}
        size="sm"
        block
        uppercase
        className="mt-6"
        disabled={disabled}
        loading={actionBusy}
        rightIcon={
          action.kind === "checkout" ? <ExternalLink size={14} /> : undefined
        }
        onClick={onSelect}
      >
        {actionBusy ? t("Opening…") : label}
      </Button>
    </article>
  );
}

function StartRidingButton() {
  const t = useTranslation();
  const router = useRouter();
  return (
    <Button
      variant="accent"
      size="sm"
      uppercase
      rightIcon={<ArrowRight size={14} />}
      onClick={() => router.push(DASHBOARD_PATH)}
    >
      {t("Start riding")}
    </Button>
  );
}

function SubscriptionSettingsLink({ onDark = false }: { onDark?: boolean }) {
  const t = useTranslation();
  return (
    <Link
      href={SUBSCRIPTION_SETTINGS_PATH}
      className={`text-[14px] font-semibold underline underline-offset-4 transition hover:brightness-95 ${
        onDark ? "text-accent" : "text-fg-dim hover:text-ink"
      }`}
    >
      {t("Review subscription settings")}
    </Link>
  );
}
