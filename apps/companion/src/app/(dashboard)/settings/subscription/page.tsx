"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage } from "@/i18n";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useEntitlements,
  useSystemSwitch,
  USERS_ME_QUERY_KEY,
} from "@/hooks/useEntitlements";
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
  Smartphone,
  Sparkles,
  X,
} from "lucide-react";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { Button, Card, Heading, SkeletonForm, Stamp } from "@tarmoto/ui";
import { INTRO_TRIAL_DAYS, type Formatters } from "@tarmoto/shared";
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
  upgradeNeedsCheckout,
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
type PortalFlow =
  | "manage"
  | "payment_method_update"
  | "subscription_cancel"
  | "subscription_update";
// ONE mapping from a portal flow to the in-flight action it reports, shared by
// `openPortal` and the per-card busy state — so a card's spinner can never
// disagree with the request its click actually started.
const PORTAL_ACTION_KINDS: Record<PortalFlow, BillingAction> = {
  manage: "portal-manage",
  payment_method_update: "portal-payment-method",
  subscription_cancel: "portal-cancel",
  subscription_update: "portal-update",
};
// What a plan card's button WOULD do, decided separately from doing it. The
// card needs the answer too — its label, enabled state and busy spinner all
// derive from it — and deriving everything from one value is what stops the
// button's presentation from disagreeing with the action behind it.
type PlanAction =
  | { kind: "checkout"; tier: "premium" | "pro" }
  | { kind: "portal"; flow: PortalFlow }
  | { kind: "none" };
/** The in-flight `actionState.kind` this plan action reports while running. */
function planActionBusyKind(action: PlanAction): BillingAction | null {
  if (action.kind === "checkout") return `checkout-${action.tier}`;
  if (action.kind === "portal") return PORTAL_ACTION_KINDS[action.flow];
  return null;
}
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
  // `useSearchParams()` (read inside the inner component) needs a Suspense
  // boundary or the statically-prerendered build bails out with the missing-
  // Suspense CSR error — same pattern as the rides pages.
  return (
    <Suspense fallback={null}>
      <SubscriptionPageInner />
    </Suspense>
  );
}

function SubscriptionPageInner() {
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
  // The CURRENT rider's id — the poll must check exactly THIS rider's
  // `/users/me` entry, not any cached user's (a prior signed-out rider's stale
  // entry could already hold the target tier and stop the poll early).
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const format = useFormat();
  // An operator has killed new Stripe checkouts: `createCheckoutSession`
  // answers 503 before it reaches Stripe, so any control that would start one
  // is a dead end. Only those — every portal flow stays open on purpose,
  // because trapping a paying rider in a subscription they cannot cancel is a
  // worse failure than the one this switch contains. Fails SAFE: unresolved
  // reads as enabled, so a slow `/config/flags` never disables billing.
  const { enabled: checkoutEnabled } = useSystemSwitch("sys_billing_checkout");
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
  /**
   * What we can HONESTLY say about the checkout the rider just came back from.
   *
   * `?checkout=success` is rider-controlled — bookmark it, edit it, share it —
   * so it is never evidence of anything. Only the backend's verification of
   * the Stripe session id promotes this past `checking`, and `unverified` is
   * the terminal state for all three failure modes (unknown id, another
   * rider's id, Stripe or the endpoint unavailable). None of the states below
   * except `trial` and `paid` make a claim about money or entitlement.
   */
  const [checkoutVerification, setCheckoutVerification] = useState<
    | { status: "idle" }
    | { status: "checking"; sessionId: string }
    | {
        status: "done";
        claim: "trial" | "paid" | "unverified";
        /**
         * Whether this answer is EVIDENCE about the checkout, or merely the
         * absence of one. The backend saying `completed: false` (and a return
         * with no session id at all) settles the question; a request that
         * never got an answer does not. The banner treats both the same — it
         * may claim nothing either way — but the poll below must not take a
         * network failure as proof there is nothing to wait for.
         */
        conclusive: boolean;
      }
  >({ status: "idle" });
  const checkoutClaim =
    checkoutVerification.status === "done"
      ? checkoutVerification.claim
      : "checking";
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
    // Read the id BEFORE `router.replace` strips it — this effect reruns on the
    // cleaned params, and by then it is gone.
    const sessionId = searchParams.get("session_id");
    setCheckoutReturn(checkout);
    if (checkout === "success") {
      setAwaitingPaidSync(true);
      // ONE-WAY, via the functional form. This effect reruns while the param
      // is still on the URL, and a plain assignment would knock a settled
      // verification back to "checking" — with the same session id, so nothing
      // would re-request and the banner would spin there for good.
      //
      // No id to check (a hand-typed or bookmarked success URL) is already the
      // terminal answer: nothing to verify, so nothing may be claimed.
      setCheckoutVerification((prev) =>
        prev.status === "idle"
          ? sessionId
            ? { status: "checking", sessionId }
            : { status: "done", claim: "unverified", conclusive: true }
          : prev,
      );
    }
    router.replace(pathname, { scroll: false });
  }, [searchParams, router, pathname]);
  useEffect(() => {
    if (checkoutVerification.status !== "checking") return;
    // A cold Stripe return races AuthSync: this runs as soon as the URL is
    // read, and without the token the request 401s. That rejection is
    // terminal, so a GENUINE trial would be discarded as unverified and never
    // retried. Waiting keeps the banner on "Checking your plan…" — a status,
    // not a claim — until there is a token to verify with.
    if (!authReady) return;
    let cancelled = false;
    accountApi
      .verifyCheckoutSession({ session_id: checkoutVerification.sessionId })
      .then(({ data }) => {
        if (cancelled) return;
        // `completed: false` covers an unknown id AND another rider's session.
        // Both land on the neutral state — the banner never says a checkout
        // happened on the strength of a URL.
        setCheckoutVerification({
          status: "done",
          claim: !data.completed
            ? "unverified"
            : data.trial_started
              ? "trial"
              : "paid",
          // An ANSWER, whatever it says.
          conclusive: true,
        });
      })
      .catch(() => {
        // Stripe or the endpoint unavailable. The rider's plan grid below is
        // the source of truth; the banner stops making claims rather than
        // spinning forever.
        if (!cancelled)
          setCheckoutVerification({
            status: "done",
            claim: "unverified",
            // We never got an answer. A genuine checkout may still be
            // settling, so the poll keeps its bounded attempts rather than
            // treating a transport failure as "nothing happened".
            conclusive: false,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [checkoutVerification, authReady]);
  // Live subscription snapshot (Stripe) — the authoritative NEW tier after
  // checkout; the poll waits for the entitlement cache to reach THIS tier.
  const liveTier =
    state.kind === "loaded" ? state.snapshot.currentPlan.tier : null;
  const liveTierRef = useRef(liveTier);
  liveTierRef.current = liveTier;
  // The live STATUS as well as the tier. A completed Checkout always leaves an
  // active or trialing subscription, so any other status means the snapshot is
  // still the pre-webhook one — including a `canceled` paid GRANT, whose tier
  // can equal the cached entitlement tier and look synchronized while the
  // upgrade the rider just bought has not landed.
  const liveStatus =
    state.kind === "loaded" ? state.snapshot.currentPlan.status : null;
  const liveStatusRef = useRef(liveStatus);
  liveStatusRef.current = liveStatus;
  // Held in a ref so the poll effect does not list it as a dependency: a new
  // callback identity on every render would tear the poll down and restart it.
  // Settled as "nothing to confirm": an unknown or foreign session id, no
  // session id at all, or a verification that could not be completed. Read
  // inside the poll, so a ref rather than a dependency.
  const checkoutUnverifiedRef = useRef(false);
  checkoutUnverifiedRef.current =
    checkoutVerification.status === "done" &&
    checkoutVerification.claim === "unverified" &&
    checkoutVerification.conclusive;
  /**
   * Issue number of the newest snapshot request, shared by the mount load and
   * every poll refresh. They run concurrently and out of order — a slow early
   * response can land after a post-webhook one and put the stale Free grid
   * (and its trial badges) back, with the poll already stopped and nothing
   * left to correct it. Only the newest request may write.
   */
  const snapshotRequestRef = useRef(0);
  const refreshSnapshotRef = useRef<() => Promise<void>>(async () => {});
  // Fire-and-forget refreshes can outlive the page, and a resolved request has
  // no other cancellation signal.
  const mountedRef = useRef(true);
  useEffect(() => {
    // Set on SETUP, not just cleared on teardown. Strict Mode runs
    // setup → cleanup → setup against the same ref, so a cleanup-only effect
    // leaves it false for the rest of the page's life and every snapshot
    // refresh below is silently dropped.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  refreshSnapshotRef.current = async () => {
    const request = ++snapshotRequestRef.current;
    try {
      const { data } = await accountApi.getSubscription();
      if (!mountedRef.current) return;
      if (request !== snapshotRequestRef.current) return;
      setState({
        kind: "loaded",
        snapshot: normalizeSubscriptionSnapshot(data, t, format.locale),
      });
    } catch {
      // A refresh failure leaves the last good snapshot on screen. The poll
      // owns the retry, and replacing a working plan grid with an error
      // because one background refetch failed is the worse outcome.
    }
  };
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
      // A Free target is AMBIGUOUS on a success return: either nothing was
      // bought, or the webhook that writes the paid tier simply has not landed
      // yet — which is the normal first-time case, since the initial snapshot
      // request usually wins that race. Stopping here left the plan grid and
      // the trial badges pre-Checkout until a full reload.
      //
      // The verified session tells the two apart. Only a settled `unverified`
      // is evidence there is nothing to wait for; while verification is still
      // in flight, or it confirmed a completed checkout, keep refreshing until
      // the bounded attempts run out.
      if (target === "free" && checkoutUnverifiedRef.current) {
        setAwaitingPaidSync(false);
        return;
      }
      // Refetch on EVERY attempt, even when the target tier isn't known yet
      // (the snapshot is still loading OR its request errored). Otherwise a
      // getSubscription failure would leave `target` null forever, skip every
      // refetch, and strand a paying rider on the stale cached tier until the
      // 5-min interval. We just can't EARLY-STOP without a target to match.
      // The SNAPSHOT too, not just the entitlement cache. `getSubscription`
      // otherwise runs once on mount, so the plan grid, the renewal line and
      // the trial badges would sit in their stale pre-Checkout state until a
      // full reload — including a "Start free trial" badge on a trial the
      // rider has just consumed.
      //
      // Started AFTER the entitlement refetch and never awaited: the stop
      // condition reads the entitlement cache, so ordering this request ahead
      // of it — or blocking on it — only delays the check that decides whether
      // to poll again. It handles its own errors.
      await queryClient.refetchQueries({
        queryKey: USERS_ME_QUERY_KEY(userId),
      });
      void refreshSnapshotRef.current();
      if (cancelled) return;
      // `free` is excluded: on a success return it is the STALE pre-webhook
      // value, and matching it against an equally stale cache would stop the
      // poll on the very state it exists to move off. The status check is the
      // same rule for the paid case — a grant sitting at `canceled` carries a
      // paid tier that the entitlement cache legitimately agrees with, so the
      // match would "synchronize" on a state the checkout was meant to change.
      const liveIsPostCheckout =
        liveStatusRef.current === "active" ||
        liveStatusRef.current === "trialing";
      if (target !== null && target !== "free" && liveIsPostCheckout) {
        // Read EXACTLY this rider's entry — a prefix match could pick up a
        // former rider's stale snapshot and stop the poll prematurely.
        const cached = queryClient.getQueryData<{ subscription_tier?: string }>(
          USERS_ME_QUERY_KEY(userId),
        );
        if (cached?.subscription_tier === target) {
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
  }, [awaitingPaidSync, queryClient, userId]);
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    // Same counter as the poll refreshes: this request and they race, and the
    // loser must not write.
    const request = ++snapshotRequestRef.current;
    accountApi
      .getSubscription()
      .then(({ data }) => {
        if (cancelled) return;
        if (request !== snapshotRequestRef.current) return;
        setState({
          kind: "loaded",
          snapshot: normalizeSubscriptionSnapshot(data, t, format.locale),
        });
      })
      .catch((error) => {
        if (cancelled) return;
        if (request !== snapshotRequestRef.current) return;
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
  // WHETHER the plan is winding down — kept separate from the date, because
  // `renews_at` is nullable in the DTO and `format.date` renders "" for an
  // unparseable timestamp. Deriving the state from the label would drop a
  // cancelled rider back to the danger-styled Cancel card, losing the Resume
  // path this card exists to give them, on nothing more than a missing date.
  const scheduledToEnd = snapshot?.currentPlan.cancelAtPeriodEnd === true;
  // ...and the date itself, when there is one to show.
  const scheduledEndLabel = useMemo(() => {
    if (!snapshot?.currentPlan.cancelAtPeriodEnd) return null;
    const { renewsAt } = snapshot.currentPlan;
    return renewsAt ? format.date(renewsAt) || null : null;
  }, [snapshot, format]);
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
  async function openPortal(flow: PortalFlow) {
    setActionState({ kind: PORTAL_ACTION_KINDS[flow], error: null });
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
  // A store-managed subscription (Apple/Google in-app purchase) has no
  // Stripe customer or subscription behind it — the portal and Checkout
  // flows below only ever act on Stripe state, so they would either 404
  // or silently do nothing. Swap them for a read-only panel that sends
  // the rider to the store that actually owns the subscription.
  const isStoreManaged =
    snapshot?.managedBy === "app_store" || snapshot?.managedBy === "play_store";
  function planActionFor(planTier: SubscriptionTier): PlanAction {
    if (!snapshot) return { kind: "none" };
    // A `past_due` plan has a Stripe subscription that still EXISTS and needs
    // recovering, whatever tier the snapshot reports: `unpaid` stops
    // entitling, so the snapshot can read `free` while the subscription lives
    // on (#1198). `createCheckoutSession` rejects that rider outright
    // ("Existing subscriptions must be changed in the billing portal"), and
    // Stripe will not change the plan until the payment lands — so on every
    // card the one action that helps is the portal's payment recovery.
    if (snapshot.currentPlan.status === "past_due") {
      return snapshot.portalAvailable
        ? { kind: "portal", flow: "payment_method_update" }
        : { kind: "none" };
    }
    if (paidPlanNeedsCheckout) {
      // No subscription to manage/cancel via the portal; every plan
      // action is a Checkout.
      return planTier === "free"
        ? { kind: "none" }
        : { kind: "checkout", tier: planTier as "premium" | "pro" };
    }
    if (planTier === snapshot.currentPlan.tier) {
      return snapshot.portalAvailable
        ? { kind: "portal", flow: "manage" }
        : { kind: "none" };
    }
    // Whether an upgrade goes through Checkout is the SHARED definition in
    // `lib/subscription.ts`, not a local `tier === "free"` read — a free tier
    // never means "no subscription", only "not currently entitled", and the
    // helper's docstring walks the states that reach `free` with billing still
    // live somewhere. (For a preview snapshot it answers false, so a
    // synthesized demo plan claims no Checkout either.)
    if (upgradeNeedsCheckout(snapshot)) {
      return { kind: "checkout", tier: planTier as "premium" | "pro" };
    }
    if (planTier === "free") {
      return snapshot.portalAvailable
        ? { kind: "portal", flow: "subscription_cancel" }
        : { kind: "none" };
    }
    return snapshot.portalAvailable
      ? { kind: "portal", flow: "subscription_update" }
      : { kind: "none" };
  }
  function handlePlanAction(planTier: SubscriptionTier) {
    const action = planActionFor(planTier);
    if (action.kind === "checkout") void openCheckout(action.tier);
    if (action.kind === "portal") void openPortal(action.flow);
  }
  const checkoutBlocked = snapshot !== null && !checkoutEnabled;
  const planActionKinds = snapshot
    ? snapshot.plans.map((plan) => planActionFor(plan.tier).kind)
    : [];
  // Say nothing to a rider the switch does not touch. An ACTIVE paid rider
  // changes or cancels their plan entirely through the portal, so "new
  // subscriptions are unavailable" would be noise on an incident they are not
  // in — announce it only where a card actually lost its action.
  const anyPlanActionBlocked =
    checkoutBlocked && planActionKinds.includes("checkout");
  // And a rider whose every action was a Checkout — the granted-but-
  // unsubscribed case — has nothing left at all, so they must not be told the
  // portal is still theirs to use.
  const allPlanActionsBlocked =
    anyPlanActionBlocked && !planActionKinds.includes("portal");
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
          // Reachable whenever a STRIPE SIDE EXISTS (`portalAvailable`),
          // INDEPENDENTLY of `managedBy`. A rider whose displayed plan is
          // store-managed can still hold a live Stripe subscription — hiding
          // the portal behind `!isStoreManaged` stranded them from the one
          // place that can cancel the thing charging them. `managed_by` says
          // where the DISPLAYED plan is managed, never that it is the rider's
          // only management target (#1191 item 7).
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
                : isStoreManaged
                  ? t("Open Stripe billing portal")
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
              ? // Every word here is keyed to what the BACKEND verified about
                // this session, never to `?checkout=success` — which the rider
                // controls. A first-time Checkout also collects no payment, so
                // "Payment successful" would be a false billing confirmation
                // even for a genuine return.
                checkoutClaim === "checking"
                ? // A status, not a claim: says what the app is doing while
                  // the session is verified.
                  t("Checking your plan…")
                : checkoutClaim === "trial"
                  ? t(
                      "Your free trial has started — your plan below updates within a moment.",
                    )
                  : checkoutClaim === "paid"
                    ? t(
                        "Subscription confirmed — your plan is being activated. Your plan below updates within a moment.",
                      )
                    : // Terminal and NEUTRAL. Verification can fail on an
                      // invalid id, another rider's id, or Stripe being
                      // unavailable, and none of those licence a checkout,
                      // payment or trial claim. The plan grid below is the
                      // source of truth and it is right there.
                      t("Your current plan is shown below.")
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
              // A portal flow acting on the STRIPE side, so it follows
              // `portalAvailable` alone — a store representative does not make
              // the rider's Stripe card unmanageable (#1191 item 7).
              canUpdatePaymentMethod={snapshot.portalAvailable}
              onUpdatePaymentMethod={() => {
                if (!snapshot.portalAvailable) return;
                void openPortal("payment_method_update");
              }}
              updateBusy={actionState.kind === "portal-payment-method"}
              // The card is ALWAYS Stripe's. Under a store representative it
              // renders beside an App Store / Google Play plan it does not pay
              // for — real data, misattributed — so it is labelled as Stripe
              // rather than suppressed (hiding a card the rider is genuinely
              // charged on would be worse).
              attributeToStripe={isStoreManaged}
            />
          </section>

          {isStoreManaged ? (
            <section className="mb-4">
              <StoreManagedPanel
                managedBy={snapshot.managedBy as "app_store" | "play_store"}
              />
            </section>
          ) : (
            <section className="mb-4">
              <div className="mb-3 inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
                <Sparkles size={16} className="text-accent" />
                {t("Plan comparison")}
              </div>
              {anyPlanActionBlocked ? (
                <div
                  className="mb-3 flex items-start gap-2 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-ink"
                  role="status"
                >
                  <ShieldAlert size={16} className="mt-0.5 shrink-0" />
                  <span>
                    {allPlanActionsBlocked
                      ? t(
                          "New subscriptions are temporarily unavailable. Please try again later.",
                        )
                      : t(
                          "New subscriptions are temporarily unavailable. You can still manage or cancel your current plan.",
                        )}
                  </span>
                </div>
              ) : null}
              <div className="grid gap-4 lg:grid-cols-3">
                {snapshot.plans.map((plan) => {
                  // ONE action per card — label, enabled state, spinner and
                  // the click itself all read it, so a card can never be left
                  // enabled (or advertised) over a dead action.
                  const action = planActionFor(plan.tier);
                  return (
                    <PlanCard
                      key={plan.tier}
                      plan={plan}
                      currentTier={snapshot.currentPlan.tier}
                      busy={billingBusy}
                      // Spinning exactly while THIS card's own action is in
                      // flight — several cards may share one action (every
                      // past-due card opens the same payment recovery), and
                      // then they spin together, which is the truth.
                      actionBusy={
                        actionState.kind !== null &&
                        actionState.kind === planActionBusyKind(action)
                      }
                      action={action}
                      checkoutBlocked={
                        checkoutBlocked && action.kind === "checkout"
                      }
                      // Eligibility ALONE is not the condition. `trialEligible`
                      // stays true for an active paid rider who subscribed
                      // without a trial, and their cards open the billing
                      // portal — which starts nothing. Advertising a trial on a
                      // button that cannot deliver one is an offer the click
                      // does not fulfil, so the badge reads the same routing
                      // the button uses: `planActionFor` only answers
                      // "checkout" where the shared `upgradeNeedsCheckout`
                      // says the backend will accept one (#1198).
                      offersTrial={
                        snapshot.trialEligible && action.kind === "checkout"
                      }
                      // The grid is where riders read their plan at a glance,
                      // so the scheduled end belongs here too — not only in
                      // the renewal sentence further down the page.
                      ending={
                        scheduledToEnd &&
                        plan.tier === snapshot.currentPlan.tier
                      }
                      endsLabel={
                        plan.tier === snapshot.currentPlan.tier
                          ? scheduledEndLabel
                          : null
                      }
                      onSelect={() => handlePlanAction(plan.tier)}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {isStoreManaged ? (
            <section className="mb-4">
              <BillingHistoryCard
                snapshot={snapshot}
                format={format}
                // Same attribution as the payment method: these are Stripe
                // invoices, not the store plan's.
                attributeToStripe
              />
            </section>
          ) : (
            <section className="mb-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
              <BillingHistoryCard snapshot={snapshot} format={format} />
              <CancelPlanCard
                currentTier={snapshot.currentPlan.tier}
                renewalLabel={renewalLabel}
                scheduledToEnd={scheduledToEnd}
                scheduledEndLabel={scheduledEndLabel}
                // A grant has no subscription for the portal to act on, the
                // same condition the retention dialog uses.
                canManage={snapshot.portalAvailable && !paidPlanNeedsCheckout}
                busy={billingBusy}
                actionBusy={actionState.kind === "portal-update"}
                onCancel={() => setCancelDialogOpen(true)}
                // A portal flow, NOT checkout — so it stays reachable when an
                // operator kills `sys_billing_checkout`. Trapping a rider in a
                // cancellation they cannot undo is exactly the failure that
                // switch is scoped to avoid.
                onResume={() => void openPortal("subscription_update")}
              />
            </section>
          )}

          {!isStoreManaged && cancelDialogOpen ? (
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
  canUpdatePaymentMethod,
  attributeToStripe,
}: {
  snapshot: SubscriptionSnapshot;
  onUpdatePaymentMethod: () => void;
  busy: boolean;
  updateBusy: boolean;
  canUpdatePaymentMethod: boolean;
  /**
   * The displayed plan is store-managed, so this (always-Stripe) card must say
   * whose it is — a real card rendered beside an App Store / Google Play plan
   * otherwise reads as though it pays for that plan.
   */
  attributeToStripe: boolean;
}) {
  const t = useTranslation();
  const paymentMethod = snapshot.paymentMethod;
  return (
    <Card padded={false} className="p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
          <CreditCard size={16} className="text-fg-mute" />
          {t("Payment method")}
        </div>
        {attributeToStripe ? (
          <Stamp className="rounded-full bg-ink/10 px-2.5 py-1 text-fg-dim">
            {t("Stripe")}
          </Stamp>
        ) : null}
      </div>

      {attributeToStripe ? (
        <p className="mb-3 text-[14px] text-fg-dim">
          {t(
            "This payment method belongs to your Stripe subscription — your store-managed plan is billed by the store.",
          )}
        </p>
      ) : null}

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
        {canUpdatePaymentMethod ? (
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
  action,
  checkoutBlocked,
  offersTrial,
  ending,
  endsLabel,
}: {
  plan: SubscriptionPlanSummary;
  currentTier: SubscriptionTier;
  onSelect: () => void;
  busy: boolean;
  actionBusy: boolean;
  /** What clicking this card DOES — label and enabled state derive from it. */
  action: PlanAction;
  /** This card's action is a Stripe Checkout an operator has killed. */
  checkoutBlocked: boolean;
  /**
   * This card's action opens Checkout AND the rider has an unused intro
   * trial — i.e. clicking it actually starts one.
   */
  offersTrial: boolean;
  /** The CURRENT plan is scheduled to end (with or without a known date). */
  ending: boolean;
  /** The end date, when the snapshot carries a usable one. */
  endsLabel: string | null;
}) {
  const t = useTranslation();
  const isCurrent = plan.tier === currentTier;
  // The label says what the click DOES, read from the action itself:
  // - a granted paid tier converts through Checkout, so its current card
  //   reads "Subscribe" rather than "Current plan";
  // - a past-due rider's cards open the portal's payment recovery, so they
  //   say so rather than promising an upgrade the backend refuses until the
  //   payment lands ("Existing subscriptions must be changed in the billing
  //   portal") — the current card keeps its "Current plan" statement.
  const actionLabel = offersTrial
    ? t("Start free trial")
    : isCurrent && action.kind === "checkout"
      ? t("Subscribe")
      : !isCurrent &&
          action.kind === "portal" &&
          action.flow === "payment_method_update"
        ? t("Update payment method")
        : planActionLabel(plan.tier, currentTier, t);
  // Dead exactly when the action is: nothing behind the button ("none" — no
  // portal to open, or a grant's inert free card), or a Checkout an operator
  // has killed. Same source as the click, so they cannot disagree.
  const disabled = busy || checkoutBlocked || action.kind === "none";
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
        {offersTrial ? (
          <Stamp className="mt-2 inline-block rounded-full bg-accent/15 px-2.5 py-1 text-accent">
            {t("{days} days free", { days: INTRO_TRIAL_DAYS })}
          </Stamp>
        ) : null}
        {ending ? (
          <Stamp className="mt-2 inline-block rounded-full bg-ink/10 px-2.5 py-1 text-fg-dim">
            {endsLabel === null
              ? t("Ending")
              : t("Ends {date}", { date: endsLabel })}
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
  attributeToStripe = false,
}: {
  snapshot: SubscriptionSnapshot;
  format: Formatters;
  /** See {@link PaymentMethodCard}: these are Stripe invoices, and under a store-managed plan they must say so. */
  attributeToStripe?: boolean;
}) {
  const t = useTranslation();
  return (
    <Card padded={false} className="p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
          <Receipt size={16} className="text-fg-mute" />
          {t("Billing history")}
        </div>
        {attributeToStripe ? (
          <Stamp className="rounded-full bg-ink/10 px-2.5 py-1 text-fg-dim">
            {t("Stripe")}
          </Stamp>
        ) : null}
      </div>

      {attributeToStripe ? (
        <p className="mb-3 text-[14px] text-fg-dim">
          {t(
            "These invoices are from your Stripe subscription — your store-managed plan is billed by the store.",
          )}
        </p>
      ) : null}

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
  scheduledToEnd,
  scheduledEndLabel,
  canManage,
  busy,
  actionBusy,
  onCancel,
  onResume,
}: {
  currentTier: SubscriptionTier;
  renewalLabel: string;
  /** The rider has cancelled; access is winding down. */
  scheduledToEnd: boolean;
  /** The end date, when the snapshot carries a usable one. */
  scheduledEndLabel: string | null;
  canManage: boolean;
  busy: boolean;
  actionBusy: boolean;
  onCancel: () => void;
  onResume: () => void;
}) {
  const t = useTranslation();
  const isFree = currentTier === "free";

  // Already cancelled: there is nothing left to cancel, and a danger-styled
  // "Cancel subscription" button next to a plan that is already winding down
  // reads as though the cancellation had not registered. What the rider needs
  // here is the end date and a way back.
  if (scheduledToEnd) {
    return (
      <Card padded={false} className="p-6">
        <div className="mb-3 inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
          <CalendarClock size={16} className="text-fg-mute" />
          {scheduledEndLabel === null
            ? t("Scheduled to end")
            : t("Scheduled to end {date}", { date: scheduledEndLabel })}
        </div>
        <p className="text-[14px] text-fg-dim">
          {scheduledEndLabel === null
            ? t(
                "You keep full access until the end of your current billing period. Resume any time before then to stay on your plan.",
              )
            : t(
                "You keep full access until then. Resume any time before that date to stay on your plan.",
              )}
        </p>
        <Button
          variant="secondary"
          size="sm"
          uppercase
          className="mt-5"
          disabled={busy || !canManage}
          loading={actionBusy}
          title={
            canManage
              ? undefined
              : t("Billing portal is unavailable for this account")
          }
          onClick={onResume}
        >
          {t("Resume subscription")}
        </Button>
      </Card>
    );
  }

  return (
    <Card padded={false} className="border-quality-q2/40 bg-quality-q2/15 p-6">
      <div className="mb-3 inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
        <ShieldAlert size={16} className="text-amber-700" />
        {t("Cancellation options")}
      </div>
      <p className="text-[14px] text-ink">
        {isFree
          ? t("You\u2019re currently on Free, so there is nothing to cancel.")
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
        disabled={isFree}
        onClick={onCancel}
      >
        {t("Cancel subscription")}
      </Button>
    </Card>
  );
}
/**
 * Where each store keeps its subscription management. Both are stable,
 * documented entry points that resolve to the signed-in account's own
 * subscription list.
 */
const STORE_SUBSCRIPTION_URLS: Record<"app_store" | "play_store", string> = {
  app_store: "https://apps.apple.com/account/subscriptions",
  play_store: "https://play.google.com/store/account/subscriptions",
};
function StoreManagedPanel({
  managedBy,
}: {
  managedBy: "app_store" | "play_store";
}) {
  const t = useTranslation();
  const isAppStore = managedBy === "app_store";
  return (
    <Card padded={false} className="p-6">
      <div className="mb-3 inline-flex items-center gap-2 text-[14px] font-semibold text-ink">
        <Smartphone size={16} className="text-fg-mute" />
        {isAppStore ? t("Manage in the App Store") : t("Manage in Google Play")}
      </div>
      <p className="text-[14px] text-fg-dim">
        {isAppStore
          ? t(
              "Your subscription is managed in the App Store. Open it to change or cancel your plan.",
            )
          : t(
              "Your subscription is managed in Google Play. Open it to change or cancel your plan.",
            )}
      </p>
      {/* The copy said "open it" and then gave the rider nothing to open. These
          are the stores' own account-subscription pages; deep-linking them is
          the only route we have, since Stripe's portal cannot act on a store
          subscription at all. */}
      <Link
        href={STORE_SUBSCRIPTION_URLS[managedBy]}
        target="_blank"
        rel="noreferrer"
        className="mt-5 inline-flex items-center gap-2 text-[14px] font-semibold text-accent transition hover:brightness-95"
      >
        {isAppStore ? t("Open App Store") : t("Open Google Play")}
        <ExternalLink size={14} />
      </Link>
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
