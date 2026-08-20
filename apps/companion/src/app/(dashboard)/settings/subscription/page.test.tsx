import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, act } from "react";
import SubscriptionPage from "./page";
import { ApiError, accountApi } from "@/lib/api";
import { INTRO_TRIAL_DAYS } from "@tarmoto/shared";
import { useAuthStore } from "@/stores/auth";

// Entitlement refresh wiring (Task 7): the page calls useQueryClient()
// directly to invalidate the cached `users-me` entitlement snapshot on
// mount, so it needs a QueryClient in scope even though this suite never
// renders through a real QueryClientProvider.
const invalidateQueriesMock = vi.fn().mockResolvedValue(undefined);
const refetchQueriesMock = vi.fn().mockResolvedValue([]);
// The success-return poll reads THIS rider's `/users/me` entry via the exact
// getQueryData key to decide whether the webhook synced the tier. Default:
// already the live tier → poll stops after the first refetch.
const getQueryDataMock = vi.fn(
  (): { subscription_tier?: string } | undefined => ({
    subscription_tier: "pro",
  }),
);
// ONE client for the whole render tree, like the real `useQueryClient`. A
// fresh object per call changes identity every render, and the success-return
// poll lists the client in its deps — so any state update would tear the poll
// down and start a new one, inflating its refetch count for reasons the app
// never has.
const queryClientMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => {
    queryClientMock.invalidateQueries = invalidateQueriesMock;
    queryClientMock.refetchQueries = refetchQueriesMock;
    queryClientMock.getQueryData = getQueryDataMock;
    return queryClientMock;
  },
}));

// `sys_billing_checkout`. Defaults to ENABLED, which is both the production
// steady state and the fail-safe direction the real hook reports while the
// flag map is unresolved.
const checkoutSwitch = vi.hoisted(() => ({
  enabled: true,
  isResolved: true,
}));

// The page mounts useEntitlements only to make `/users/me` an active query; the
// real hook needs a QueryClientProvider this suite doesn't render, so stub it.
vi.mock("@/hooks/useEntitlements", () => ({
  useSystemSwitch: () => ({
    enabled: checkoutSwitch.enabled,
    isResolved: checkoutSwitch.isResolved,
  }),
  useEntitlements: () => ({
    tier: null,
    features: null,
    limits: null,
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
    dataUpdatedAt: 0,
  }),
  USERS_ME_QUERY_KEY: (userId: string | null) => ["users-me", userId] as const,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    accountApi: {
      getSubscription: vi.fn(),
      createCheckoutSession: vi.fn(),
      createPortalSession: vi.fn(),
      verifyCheckoutSession: vi.fn(),
    },
  };
});

// The page reads Stripe's `?checkout=success|canceled` return param and strips
// it via router.replace. Mutable holder so each case seeds its own param.
const mockReplace = vi.fn();
const mockSearchParams = vi.hoisted(() => ({
  value: new URLSearchParams(),
}));
// ONE router object, like Next's own `useRouter`. A fresh object per call
// changes identity every render, and the checkout-return effect lists the
// router in its deps — so it would re-run on every render and keep re-arming
// `awaitingPaidSync`, silently restarting a poll that had decided to stop.
const routerMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/subscription",
  useRouter: () => {
    routerMock.replace = mockReplace;
    return routerMock;
  },
  useSearchParams: () => mockSearchParams.value,
}));

describe("SubscriptionPage", () => {
  const getSubscriptionMock = vi.mocked(accountApi.getSubscription);
  const createCheckoutSessionMock = vi.mocked(accountApi.createCheckoutSession);
  const createPortalSessionMock = vi.mocked(accountApi.createPortalSession);
  const verifyCheckoutSessionMock = vi.mocked(accountApi.verifyCheckoutSession);
  const assignMock = vi.fn();

  beforeEach(() => {
    getSubscriptionMock.mockReset();
    createCheckoutSessionMock.mockReset();
    createPortalSessionMock.mockReset();
    assignMock.mockReset();
    invalidateQueriesMock.mockReset();
    invalidateQueriesMock.mockResolvedValue(undefined);
    refetchQueriesMock.mockReset();
    refetchQueriesMock.mockResolvedValue([]);
    getQueryDataMock.mockReset();
    getQueryDataMock.mockReturnValue({ subscription_tier: "pro" });
    mockReplace.mockReset();
    // Counts in these tests are absolute — an earlier case's verification would
    // otherwise read as this one's.
    verifyCheckoutSessionMock.mockReset();
    checkoutSwitch.enabled = true;
    checkoutSwitch.isResolved = true;
    mockSearchParams.value = new URLSearchParams();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        assign: assignMock,
      },
    });
    // Page gates its data fetch on a non-null access token to avoid an
    // AuthSync race on hard navigations; seed the auth store so the
    // tests' `useEffect` actually fires.
    useAuthStore.setState({
      user: {
        id: "test-user",
        email: "rider@example.com",
        displayName: "Rider",
      },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
  });

  afterEach(() => {
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      accessToken: null,
    });
  });

  // Task 7: a tier change from a Stripe checkout/portal round-trip is
  // reflected as soon as the rider lands back on /settings/subscription.
  it("invalidates the users-me entitlement cache on mount", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "free",
          status: "canceled",
          renews_at: null,
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "premium" }, { tier: "pro" }],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });

    render(<SubscriptionPage />);

    await waitFor(() =>
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: ["users-me"],
      }),
    );
  });

  const freeSnapshot = {
    data: {
      current_plan: {
        tier: "free" as const,
        status: "canceled" as const,
        renews_at: null,
        cancel_at_period_end: false,
      },
      plans: [
        { tier: "free" as const },
        { tier: "premium" as const },
        { tier: "pro" as const },
      ],
      payment_method: null,
      billing_history: [],
      portal_available: false,
      trial_eligible: true,
      provider: null,
      managed_by: null,
    },
  };

  it("offers the trial on a card that OPENS Checkout, with its length from the shared constant", async () => {
    mockSearchParams.value = new URLSearchParams();
    getSubscriptionMock.mockResolvedValue(freeSnapshotTrialEligible);

    render(<SubscriptionPage />);

    const premiumCard = (await screen.findByText("Premium")).closest("article");
    expect(
      within(premiumCard!).getByText(`${INTRO_TRIAL_DAYS} days free`),
    ).toBeInTheDocument();
    expect(
      within(premiumCard!).getByRole("button", { name: "Start free trial" }),
    ).toBeInTheDocument();
  });

  it("does NOT offer a trial on a card that opens the billing PORTAL", async () => {
    // `trial_eligible` stays true for an active paid rider who subscribed
    // without a trial — the backend leaves `billing_trial_used_at` unset in
    // that case. Their plan buttons open the portal, which starts nothing, so
    // keying the badge off the flag alone would advertise an offer the click
    // cannot fulfil.
    mockSearchParams.value = new URLSearchParams();
    getSubscriptionMock.mockResolvedValue({
      data: {
        current_plan: {
          tier: "pro" as const,
          status: "active" as const,
          renews_at: "2027-01-01T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [
          { tier: "free" as const },
          { tier: "premium" as const },
          { tier: "pro" as const },
        ],
        payment_method: null,
        billing_history: [],
        portal_available: true,
        // Eligible, but every card here routes to the portal.
        trial_eligible: true,
        provider: "stripe" as const,
        managed_by: "stripe_portal" as const,
      },
    });

    render(<SubscriptionPage />);

    await screen.findByText("Premium");
    expect(
      screen.queryByText(`${INTRO_TRIAL_DAYS} days free`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start free trial" }),
    ).not.toBeInTheDocument();
  });

  it("REFRESHES the snapshot while polling, so the grid can't stay pre-Checkout", async () => {
    // The poll only ever invalidated `/users/me`; `getSubscription` ran once on
    // mount. The plan grid, renewal line and trial badges would sit in their
    // stale pre-Checkout state — including a trial badge on a trial the rider
    // has just used — until a full reload.
    mockSearchParams.value = new URLSearchParams("checkout=success");
    getSubscriptionMock.mockResolvedValue(paidSnapshot("pro"));
    getQueryDataMock.mockReturnValue({ subscription_tier: "free" });

    render(<SubscriptionPage />);

    await waitFor(() =>
      expect(getSubscriptionMock.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("WAITS for the token before verifying, so a cold return isn't discarded", async () => {
    // A hard navigation back from Stripe races AuthSync. Verifying without a
    // token 401s, and that rejection is terminal — a genuine trial would be
    // written off as unverified and never retried.
    useAuthStore.setState({ accessToken: null, isAuthenticated: false });
    mockSearchParams.value = new URLSearchParams(
      "checkout=success&session_id=cs_test_123",
    );
    getSubscriptionMock.mockResolvedValue(paidSnapshot("pro"));
    verifyCheckoutSessionMock.mockResolvedValue({
      data: { completed: true, trial_started: true },
    });

    render(<SubscriptionPage />);

    // Still a status, not a claim, while the token is missing.
    expect(await screen.findByText(/Checking your plan/i)).toBeInTheDocument();
    expect(verifyCheckoutSessionMock).not.toHaveBeenCalled();

    await act(async () => {
      useAuthStore.setState({
        accessToken: "test-access-token",
        isAuthenticated: true,
      });
    });

    expect(
      await screen.findByText(/Your free trial has started/i),
    ).toBeInTheDocument();
  });

  it("survives a STRICT MODE remount — the snapshot refresh still applies", async () => {
    // `next.config.ts` enables Strict Mode, so development runs
    // setup → cleanup → setup on the same refs. A cleanup-only mounted ref
    // stays false after that, and every post-checkout snapshot refresh is
    // dropped on the floor.
    mockSearchParams.value = new URLSearchParams("checkout=success");
    // The refreshed snapshot must be VISIBLY different from the first, or the
    // assertion cannot tell a dropped `setState` from a delivered one: the
    // first load is a trial-eligible Free rider (cards open Checkout, so the
    // badge shows), the refresh is an active Pro rider whose cards open the
    // portal (no badge).
    // Keyed to the POLL, not to call order: Strict Mode double-invokes the
    // initial load effect, so a `mockResolvedValueOnce` would be consumed by
    // the duplicate mount and the "before" state would never render.
    // Driven by the TEST, not by call order or attempt counts: Strict Mode
    // double-invokes both the load effect and the poll effect, so anything
    // keyed to "the nth call" flips before the first state has rendered.
    //
    // Both snapshots are Pro, because the poll exits immediately on a Free
    // live tier. The transition is the one the webhook actually makes: a
    // granted tier with no live subscription (`canceled`, converts through
    // Checkout, so the trial badge shows) becoming an active subscription with
    // a portal (every card opens the portal, badge gone).
    const granted = (subscribed: boolean) => ({
      data: {
        current_plan: {
          tier: "pro" as const,
          status: (subscribed ? "active" : "canceled") as "active" | "canceled",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [
          { tier: "free" as const },
          { tier: "premium" as const },
          { tier: "pro" as const },
        ],
        payment_method: null,
        billing_history: [],
        portal_available: subscribed,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });
    let webhookLanded = false;
    getSubscriptionMock.mockImplementation(async () => granted(webhookLanded));
    getQueryDataMock.mockReturnValue({ subscription_tier: "free" });

    render(
      <StrictMode>
        <SubscriptionPage />
      </StrictMode>,
    );

    // One per paid card while the grant still converts through Checkout.
    expect(
      await screen.findAllByText(`${INTRO_TRIAL_DAYS} days free`),
    ).not.toHaveLength(0);

    webhookLanded = true;

    // The refresh REACHED state rather than being discarded by a stale
    // mounted ref: the grid follows the webhook from Free to Pro, and the
    // trial badge goes with it. The second attempt is 1.5 s into the backoff.
    await waitFor(
      () =>
        expect(
          screen.queryAllByText(`${INTRO_TRIAL_DAYS} days free`),
        ).toHaveLength(0),
      { timeout: 5000 },
    );
  });

  it("does NOT offer a trial to a PAST_DUE rider the backend would refuse", async () => {
    // `past_due` reads as `tier: "free"` with a live Stripe subscription
    // behind it. Their cards route to the portal's payment recovery (#1198),
    // which starts no trial — and `createCheckoutSession` would reject them
    // anyway ("Existing subscriptions must be changed in the billing
    // portal"), so a trial badge would promise something no click delivers.
    mockSearchParams.value = new URLSearchParams();
    getSubscriptionMock.mockResolvedValue({
      data: {
        current_plan: {
          tier: "free" as const,
          status: "past_due" as const,
          renews_at: null,
          cancel_at_period_end: false,
        },
        plans: [
          { tier: "free" as const },
          { tier: "premium" as const },
          { tier: "pro" as const },
        ],
        payment_method: null,
        billing_history: [],
        portal_available: true,
        trial_eligible: true,
        provider: "stripe" as const,
        managed_by: "stripe_portal" as const,
      },
    });

    render(<SubscriptionPage />);

    await screen.findByText("Premium");
    expect(screen.queryAllByText(`${INTRO_TRIAL_DAYS} days free`)).toHaveLength(
      0,
    );
    expect(
      screen.queryByRole("button", { name: "Start free trial" }),
    ).not.toBeInTheDocument();
  });

  // #1198: `past_due` is the rider in the middle of a payment failure. The
  // Stripe subscription still EXISTS whatever tier the snapshot reports, so
  // Checkout is exactly the route `createCheckoutSession` refuses — every plan
  // action must reach the portal's payment recovery instead.
  describe("past_due plan routing", () => {
    const pastDueSnapshot = (tier: "free" | "pro") => ({
      data: {
        current_plan: {
          tier,
          status: "past_due" as const,
          renews_at: null,
          cancel_at_period_end: false,
        },
        plans: [
          { tier: "free" as const },
          { tier: "premium" as const },
          { tier: "pro" as const },
        ],
        payment_method: null,
        billing_history: [],
        portal_available: true,
        trial_eligible: true,
        provider: "stripe" as const,
        managed_by: "stripe_portal" as const,
      },
    });

    it("routes an unpaid rider (reported free) to the portal, never Checkout", async () => {
      // `unpaid` stops entitling, so the served snapshot reads `free` while
      // the status keeps the live value — and `createCheckoutSession` rejects
      // that rider outright ("Existing subscriptions must be changed in the
      // billing portal"). A local `tier === "free"` read sent every plan
      // click into that rejection; the shared `upgradeNeedsCheckout` does not.
      getSubscriptionMock.mockResolvedValue(pastDueSnapshot("free"));
      createPortalSessionMock.mockResolvedValue({
        data: { url: "https://billing.stripe.com/p/session/recover" },
      });

      render(<SubscriptionPage />);

      const premiumCard = (await screen.findByText("Premium")).closest(
        "article",
      );
      const recover = within(premiumCard!).getByRole("button", {
        name: "Update payment method",
      });
      expect(recover).toBeEnabled();
      fireEvent.click(recover);

      await waitFor(() =>
        expect(createPortalSessionMock).toHaveBeenCalledWith({
          flow: "payment_method_update",
        }),
      );
      expect(createCheckoutSessionMock).not.toHaveBeenCalled();
      expect(assignMock).toHaveBeenCalledWith(
        "https://billing.stripe.com/p/session/recover",
      );
    });

    it("offers NO Checkout affordance anywhere on a past_due grid", async () => {
      getSubscriptionMock.mockResolvedValue(pastDueSnapshot("free"));
      createPortalSessionMock.mockResolvedValue({
        data: { url: "https://billing.stripe.com/p/session/recover" },
      });

      render(<SubscriptionPage />);

      await screen.findByText("Premium");
      // No card promises an upgrade or a trial the backend would refuse.
      expect(
        screen.queryByRole("button", { name: "Upgrade" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Start free trial" }),
      ).not.toBeInTheDocument();
      // The current (free) card states the plan and reaches the portal too.
      // (Scoped by the card's h3 — the CurrentPlanCard hero also says "Free".)
      const freeHeading = await screen.findByRole("heading", {
        name: "Free",
        level: 3,
      });
      const freeCard = freeHeading.closest("article");
      fireEvent.click(
        within(freeCard!).getByRole("button", { name: "Current plan" }),
      );
      await waitFor(() =>
        expect(createPortalSessionMock).toHaveBeenCalledWith({
          flow: "payment_method_update",
        }),
      );
      expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    });

    it("routes a PAID past_due rider's plan change to payment recovery too", async () => {
      // "Regardless of the reported tier": a still-entitling Pro rider in
      // past_due cannot change plans until the payment lands, so the premium
      // card opens payment recovery rather than `subscription_update`.
      getSubscriptionMock.mockResolvedValue(pastDueSnapshot("pro"));
      createPortalSessionMock.mockResolvedValue({
        data: { url: "https://billing.stripe.com/p/session/recover" },
      });

      render(<SubscriptionPage />);

      const premiumCard = (await screen.findByText("Premium")).closest(
        "article",
      );
      fireEvent.click(
        within(premiumCard!).getByRole("button", {
          name: "Update payment method",
        }),
      );

      await waitFor(() =>
        expect(createPortalSessionMock).toHaveBeenCalledWith({
          flow: "payment_method_update",
        }),
      );
      expect(createPortalSessionMock).not.toHaveBeenCalledWith({
        flow: "subscription_update",
      });
    });

    it("keeps past_due recovery reachable when sys_billing_checkout is killed", async () => {
      // The routing is a portal flow, so the Checkout kill switch must not
      // touch it — and the "new subscriptions unavailable" banner would be
      // noise about an outage this rider is not in.
      checkoutSwitch.enabled = false;
      getSubscriptionMock.mockResolvedValue(pastDueSnapshot("free"));

      render(<SubscriptionPage />);

      const premiumCard = (await screen.findByText("Premium")).closest(
        "article",
      );
      expect(
        within(premiumCard!).getByRole("button", {
          name: "Update payment method",
        }),
      ).toBeEnabled();
      expect(
        screen.queryByText(/New subscriptions are temporarily unavailable/),
      ).not.toBeInTheDocument();
    });
  });

  it("KEEPS refreshing while a verified checkout's webhook is still in flight", async () => {
    // The normal first-time return: the snapshot request beats the webhook, so
    // the live tier still reads Free. Stopping there is only correct when
    // nothing was bought — with a verified session it strands the plan grid
    // and the trial badges in their pre-Checkout state until a reload.
    mockSearchParams.value = new URLSearchParams(
      "checkout=success&session_id=cs_test_123",
    );
    verifyCheckoutSessionMock.mockResolvedValue({
      data: { completed: true, trial_started: true },
    });
    let webhookLanded = false;
    getSubscriptionMock.mockImplementation(async () =>
      webhookLanded ? paidSnapshot("pro") : freeSnapshotTrialEligible,
    );
    getQueryDataMock.mockReturnValue({ subscription_tier: "free" });

    render(<SubscriptionPage />);

    // Free + trial-eligible ⇒ the paid cards advertise the trial.
    expect(
      await screen.findAllByText(`${INTRO_TRIAL_DAYS} days free`),
    ).not.toHaveLength(0);

    webhookLanded = true;

    // The grid follows without a reload: Pro is active with a portal, so the
    // cards route there and the badges go.
    await waitFor(
      () =>
        expect(
          screen.queryAllByText(`${INTRO_TRIAL_DAYS} days free`),
        ).toHaveLength(0),
      { timeout: 5000 },
    );
  });

  it("STOPS on a free tier when the checkout could not be verified", async () => {
    // The other half: nothing to wait for, so the poll must not keep hitting
    // Stripe and /users/me for a rider who bought nothing.
    mockSearchParams.value = new URLSearchParams("checkout=success");
    getSubscriptionMock.mockResolvedValue(freeSnapshotTrialEligible);
    getQueryDataMock.mockReturnValue({ subscription_tier: "free" });

    render(<SubscriptionPage />);

    await waitFor(() => expect(refetchQueriesMock).toHaveBeenCalled());
    const settled = refetchQueriesMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(refetchQueriesMock.mock.calls.length).toBe(settled);
  });

  it("KEEPS polling when verification never got an answer", async () => {
    // A transport failure is not evidence that nothing was bought. Treating it
    // like a definitive `completed: false` stops the poll on a Free tier the
    // webhook is about to change, stranding the grid until a reload.
    mockSearchParams.value = new URLSearchParams(
      "checkout=success&session_id=cs_test_123",
    );
    verifyCheckoutSessionMock.mockRejectedValue(new Error("network"));
    let webhookLanded = false;
    getSubscriptionMock.mockImplementation(async () =>
      webhookLanded ? paidSnapshot("pro") : freeSnapshotTrialEligible,
    );
    getQueryDataMock.mockReturnValue({ subscription_tier: "free" });

    render(<SubscriptionPage />);

    // The banner still claims nothing — that part is unchanged.
    expect(
      await screen.findByText(/Your current plan is shown below/i),
    ).toBeInTheDocument();
    expect(
      await screen.findAllByText(`${INTRO_TRIAL_DAYS} days free`),
    ).not.toHaveLength(0);

    webhookLanded = true;

    await waitFor(
      () =>
        expect(
          screen.queryAllByText(`${INTRO_TRIAL_DAYS} days free`),
        ).toHaveLength(0),
      { timeout: 5000 },
    );
  });

  it("DISCARDS a snapshot response older than one already applied", async () => {
    // The refreshes run concurrently and can resolve out of order. A slow early
    // response landing after a post-webhook one would put the stale Free grid
    // — and its trial badges — back, with the poll already stopped and nothing
    // left to correct it.
    mockSearchParams.value = new URLSearchParams("checkout=success");
    getQueryDataMock.mockReturnValue({ subscription_tier: "free" });

    type SnapshotResolve = (
      value: Awaited<ReturnType<typeof accountApi.getSubscription>>,
    ) => void;
    const resolvers: SnapshotResolve[] = [];
    getSubscriptionMock.mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<typeof accountApi.getSubscription>>>(
          (resolve) => {
            resolvers.push(resolve);
          },
        ),
    );

    render(<SubscriptionPage />);

    // Everything hangs, so the poll keeps issuing refreshes (a null live tier
    // has no target to stop on) and several are in flight at once: index 0 is
    // the mount load, 1 and 2 are poll refreshes.
    await waitFor(() => expect(resolvers.length).toBeGreaterThanOrEqual(3), {
      timeout: 8000,
    });

    // The NEWER refresh lands first, carrying the post-webhook Pro snapshot.
    await act(async () => {
      resolvers[2]?.(paidSnapshot("pro"));
    });
    await waitFor(() =>
      expect(
        screen.queryAllByText(`${INTRO_TRIAL_DAYS} days free`),
      ).toHaveLength(0),
    );

    // The OLDER refresh lands after, still pre-webhook. Applying it would put
    // the Free grid and its trial badges back, with the poll already stopped
    // and nothing left to correct it.
    await act(async () => {
      resolvers[1]?.(freeSnapshotTrialEligible);
    });

    expect(screen.queryAllByText(`${INTRO_TRIAL_DAYS} days free`)).toHaveLength(
      0,
    );
  });

  it("DISCARDS a slow MOUNT load that lands after a refresh", async () => {
    // The same race from the other side: the initial request can be the stale
    // one, so it shares the issue counter rather than writing unconditionally.
    mockSearchParams.value = new URLSearchParams("checkout=success");
    getQueryDataMock.mockReturnValue({ subscription_tier: "free" });

    type SnapshotResolve = (
      value: Awaited<ReturnType<typeof accountApi.getSubscription>>,
    ) => void;
    const resolvers: SnapshotResolve[] = [];
    getSubscriptionMock.mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<typeof accountApi.getSubscription>>>(
          (resolve) => {
            resolvers.push(resolve);
          },
        ),
    );

    render(<SubscriptionPage />);

    await waitFor(() => expect(resolvers.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      resolvers[resolvers.length - 1]?.(paidSnapshot("pro"));
    });
    await waitFor(() =>
      expect(
        screen.queryAllByText(`${INTRO_TRIAL_DAYS} days free`),
      ).toHaveLength(0),
    );

    await act(async () => {
      resolvers[0]?.(freeSnapshotTrialEligible);
    });

    expect(screen.queryAllByText(`${INTRO_TRIAL_DAYS} days free`)).toHaveLength(
      0,
    );
  });

  it("KEEPS polling when a canceled GRANT's tier already matches the cache", async () => {
    // A Pro grant upgrading to Premium: the live snapshot still reads Pro
    // (`canceled` — the webhook has not landed) and `/users/me` legitimately
    // holds that same granted Pro tier. Treating that equality as
    // synchronization stops the poll on the exact pre-checkout state the
    // upgrade was meant to change.
    mockSearchParams.value = new URLSearchParams(
      "checkout=success&session_id=cs_test_123",
    );
    verifyCheckoutSessionMock.mockResolvedValue({
      data: { completed: true, trial_started: false },
    });
    // The cache agrees with the GRANTED tier, as it does in production.
    getQueryDataMock.mockReturnValue({ subscription_tier: "pro" });

    const grantedPro = {
      data: {
        current_plan: {
          tier: "pro" as const,
          status: "canceled" as const,
          renews_at: null,
          cancel_at_period_end: false,
        },
        plans: [
          { tier: "free" as const },
          { tier: "premium" as const },
          { tier: "pro" as const },
        ],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    };
    let webhookLanded = false;
    getSubscriptionMock.mockImplementation(async () =>
      webhookLanded ? paidSnapshot("premium") : grantedPro,
    );

    render(<SubscriptionPage />);

    // The grant converts through Checkout, so the trial badge is up.
    expect(
      await screen.findAllByText(`${INTRO_TRIAL_DAYS} days free`),
    ).not.toHaveLength(0);

    // Land the webhook LATE — past the second attempt (1.5 s), which is where
    // a tier-only match would have declared the poll synchronized and stopped.
    // Flipping earlier lets the same attempt that decides to stop also fire the
    // refresh that picks the change up, which masks the defect entirely.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    webhookLanded = true;

    // Premium is now active with a portal: the cards route there and the
    // badges go — without a reload.
    await waitFor(
      () =>
        expect(
          screen.queryAllByText(`${INTRO_TRIAL_DAYS} days free`),
        ).toHaveLength(0),
      { timeout: 10000 },
    );
  }, 20000);

  const scheduledToEndSnapshot = {
    data: {
      current_plan: {
        tier: "pro" as const,
        status: "active" as const,
        renews_at: "2026-11-15T00:00:00.000Z",
        cancel_at_period_end: true,
      },
      plans: [
        { tier: "free" as const },
        { tier: "premium" as const },
        { tier: "pro" as const },
      ],
      payment_method: null,
      billing_history: [],
      portal_available: true,
      trial_eligible: false,
      provider: "stripe" as const,
      managed_by: "stripe_portal" as const,
    },
  };

  it("offers RESUME instead of cancel once the plan is scheduled to end", async () => {
    // A danger-styled "Cancel subscription" beside a plan that is already
    // winding down reads as though the cancellation had not registered. What
    // the rider needs is the end date and a way back.
    mockSearchParams.value = new URLSearchParams();
    getSubscriptionMock.mockResolvedValue(scheduledToEndSnapshot);

    render(<SubscriptionPage />);

    expect(
      await screen.findByRole("button", { name: "Resume subscription" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Cancel subscription" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["a null renews_at", null],
    ["an unparseable renews_at", "not-a-date"],
  ])(
    "KEEPS the cancelled state with %s, since the date is not the state",
    async (_label, renewsAt) => {
      // `renews_at` is nullable in the DTO and `format.date` renders "" for an
      // unparseable timestamp. Deriving "is this ending?" from the formatted
      // label would drop the rider back to the danger-styled Cancel card and
      // take the Resume path with it — over a missing date.
      mockSearchParams.value = new URLSearchParams();
      getSubscriptionMock.mockResolvedValue({
        data: {
          ...scheduledToEndSnapshot.data,
          current_plan: {
            ...scheduledToEndSnapshot.data.current_plan,
            renews_at: renewsAt,
          },
        },
      });

      render(<SubscriptionPage />);

      expect(
        await screen.findByRole("button", { name: "Resume subscription" }),
      ).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: "Cancel subscription" }),
      ).not.toBeInTheDocument();
      // Generic wording rather than a half-formed date.
      expect(screen.getByText("Scheduled to end")).toBeInTheDocument();
      // ...and the grid still marks the plan as ending.
      const proCard = (await screen.findAllByText("Pro"))
        .map((el) => el.closest("article"))
        .find((el) => el !== null);
      expect(within(proCard!).getByText("Ending")).toBeInTheDocument();
    },
  );

  it("routes Resume through the portal's subscription_update flow", async () => {
    mockSearchParams.value = new URLSearchParams();
    getSubscriptionMock.mockResolvedValue(scheduledToEndSnapshot);
    createPortalSessionMock.mockResolvedValue({
      data: { url: "https://billing.stripe.com/p/session_resume" },
    });

    render(<SubscriptionPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Resume subscription" }),
    );

    await waitFor(() =>
      expect(createPortalSessionMock).toHaveBeenCalledWith({
        flow: "subscription_update",
      }),
    );
  });

  it("KEEPS Resume reachable when sys_billing_checkout is killed", async () => {
    // Resume is a PORTAL flow, not a checkout. The switch stops new
    // subscriptions; leaving a rider unable to undo a cancellation would be a
    // worse failure than the one it contains — the exact trap this epic is
    // meant to avoid.
    checkoutSwitch.enabled = false;
    mockSearchParams.value = new URLSearchParams();
    getSubscriptionMock.mockResolvedValue(scheduledToEndSnapshot);

    render(<SubscriptionPage />);

    expect(
      await screen.findByRole("button", { name: "Resume subscription" }),
    ).toBeEnabled();
  });

  it("shows the scheduled end in the PLAN GRID, not only the renewal line", async () => {
    // The grid is where riders read their plan at a glance.
    mockSearchParams.value = new URLSearchParams();
    getSubscriptionMock.mockResolvedValue(scheduledToEndSnapshot);

    render(<SubscriptionPage />);

    const proCard = (await screen.findAllByText("Pro"))
      .map((el) => el.closest("article"))
      .find((el) => el !== null);
    expect(proCard).not.toBeNull();
    expect(within(proCard!).getByText(/^Ends /)).toBeInTheDocument();
    // Only the plan that is actually ending.
    const premiumCard = (await screen.findByText("Premium")).closest("article");
    expect(within(premiumCard!).queryByText(/^Ends /)).not.toBeInTheDocument();
  });

  it("disables Resume when the account has no billing portal", async () => {
    // A grant has no subscription for the portal to act on, so the button
    // would open a flow the backend cannot serve.
    mockSearchParams.value = new URLSearchParams();
    getSubscriptionMock.mockResolvedValue({
      data: {
        ...scheduledToEndSnapshot.data,
        portal_available: false,
      },
    });

    render(<SubscriptionPage />);

    expect(
      await screen.findByRole("button", { name: "Resume subscription" }),
    ).toBeDisabled();
  });

  it("LINKS a store-managed plan to the store that owns it", async () => {
    // The copy said "open it" and gave the rider nothing to open. Stripe's
    // portal cannot act on a store subscription, so the store's own account
    // page is the only route.
    mockSearchParams.value = new URLSearchParams();
    getSubscriptionMock.mockResolvedValue({
      data: {
        ...scheduledToEndSnapshot.data,
        current_plan: {
          ...scheduledToEndSnapshot.data.current_plan,
          cancel_at_period_end: false,
        },
        provider: "apple" as const,
        managed_by: "app_store" as const,
      },
    });

    render(<SubscriptionPage />);

    const link = await screen.findByRole("link", { name: /Open App Store/ });
    expect(link).toHaveAttribute(
      "href",
      "https://apps.apple.com/account/subscriptions",
    );
    expect(
      screen.queryByRole("link", { name: /Open Google Play/ }),
    ).not.toBeInTheDocument();
  });

  it("links a Play-managed plan to Google Play instead", async () => {
    mockSearchParams.value = new URLSearchParams();
    getSubscriptionMock.mockResolvedValue({
      data: {
        ...scheduledToEndSnapshot.data,
        current_plan: {
          ...scheduledToEndSnapshot.data.current_plan,
          cancel_at_period_end: false,
        },
        provider: "google" as const,
        managed_by: "play_store" as const,
      },
    });

    render(<SubscriptionPage />);

    const link = await screen.findByRole("link", { name: /Open Google Play/ });
    expect(link).toHaveAttribute(
      "href",
      "https://play.google.com/store/account/subscriptions",
    );
  });

  it("makes NO claim on ?checkout=success alone — the rider controls that URL", async () => {
    // Bookmarked, shared or hand-edited, `?checkout=success` is rider input.
    // With no session id there is nothing to verify, so the banner may only
    // point at the plan grid, which is the source of truth.
    mockSearchParams.value = new URLSearchParams("checkout=success");
    getSubscriptionMock.mockResolvedValueOnce(paidSnapshot("pro"));

    render(<SubscriptionPage />);

    expect(
      await screen.findByText(/Your current plan is shown below/i),
    ).toBeInTheDocument();
    expect(verifyCheckoutSessionMock).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/free trial has started/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Subscription confirmed/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Payment successful/i)).not.toBeInTheDocument();
    // Param stripped so a refresh / Back doesn't re-show the banner.
    expect(mockReplace).toHaveBeenCalledWith("/settings/subscription", {
      scroll: false,
    });
    // Success re-pulls the entitlement cache (webhook may still be in flight).
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["users-me"],
    });
  });

  it("says a trial started only once the BACKEND verifies the session", async () => {
    // A first-time Checkout collects no payment, so the claim has to come from
    // the verified session rather than from the URL or a not-yet-synced tier.
    mockSearchParams.value = new URLSearchParams(
      "checkout=success&session_id=cs_test_123",
    );
    getSubscriptionMock.mockResolvedValue(paidSnapshot("pro"));
    verifyCheckoutSessionMock.mockResolvedValue({
      data: { completed: true, trial_started: true },
    });

    render(<SubscriptionPage />);

    expect(
      await screen.findByText(/Your free trial has started/i),
    ).toBeInTheDocument();
    expect(verifyCheckoutSessionMock).toHaveBeenCalledWith({
      session_id: "cs_test_123",
    });
    expect(screen.queryByText(/Payment successful/i)).not.toBeInTheDocument();
  });

  it("confirms a verified NON-trial checkout without claiming a trial", async () => {
    mockSearchParams.value = new URLSearchParams(
      "checkout=success&session_id=cs_test_123",
    );
    getSubscriptionMock.mockResolvedValue(paidSnapshot("pro"));
    verifyCheckoutSessionMock.mockResolvedValue({
      data: { completed: true, trial_started: false },
    });

    render(<SubscriptionPage />);

    expect(
      await screen.findByText(/Subscription confirmed/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/free trial has started/i),
    ).not.toBeInTheDocument();
  });

  it("stays NEUTRAL for a session the backend rejects", async () => {
    // Covers an invalid id AND another rider's id: a success URL is shareable,
    // and the backend answers `completed: false` to both. Neither may produce a
    // confirmation for someone who bought nothing.
    mockSearchParams.value = new URLSearchParams(
      "checkout=success&session_id=cs_someone_else",
    );
    getSubscriptionMock.mockResolvedValue(paidSnapshot("pro"));
    verifyCheckoutSessionMock.mockResolvedValue({
      data: { completed: false, trial_started: false },
    });

    render(<SubscriptionPage />);

    expect(
      await screen.findByText(/Your current plan is shown below/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Subscription confirmed/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/free trial has started/i),
    ).not.toBeInTheDocument();
  });

  it("does not spin forever when verification itself fails", async () => {
    // Stripe or the endpoint unavailable. "Checking your plan…" is the only
    // pre-verification wording allowed, so it must reach a terminal state
    // rather than sit there indefinitely.
    mockSearchParams.value = new URLSearchParams(
      "checkout=success&session_id=cs_test_123",
    );
    getSubscriptionMock.mockResolvedValue(paidSnapshot("pro"));
    verifyCheckoutSessionMock.mockRejectedValue(new Error("stripe down"));

    render(<SubscriptionPage />);

    expect(
      await screen.findByText(/Your current plan is shown below/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Checking your plan/i)).not.toBeInTheDocument();
  });

  const freeSnapshotTrialEligible = {
    data: {
      current_plan: {
        tier: "free" as const,
        status: "canceled" as const,
        renews_at: null,
        cancel_at_period_end: false,
      },
      plans: [
        { tier: "free" as const },
        { tier: "premium" as const },
        { tier: "pro" as const },
      ],
      payment_method: null,
      billing_history: [],
      portal_available: false,
      trial_eligible: true,
      provider: null,
      managed_by: null,
    },
  };

  const paidSnapshot = (tier: "pro" | "premium") => ({
    data: {
      current_plan: {
        tier,
        status: "active" as const,
        renews_at: "2026-11-15T00:00:00.000Z",
        cancel_at_period_end: false,
      },
      plans: [
        { tier: "free" as const },
        { tier: "premium" as const },
        { tier: "pro" as const },
      ],
      payment_method: null,
      billing_history: [],
      portal_available: true,
      trial_eligible: true,
      provider: null,
      managed_by: null,
    },
  });

  it("polls until the entitlement cache reaches the live subscription tier", async () => {
    // Codex: a single refetch can read /users/me before the webhook writes the
    // tier. Poll (via refetchQueries — the query is active) until the cached
    // tier matches the live Stripe tier, then stop.
    vi.useFakeTimers();
    try {
      mockSearchParams.value = new URLSearchParams("checkout=success");
      getSubscriptionMock.mockResolvedValue(paidSnapshot("pro")); // live = Pro
      // Cache stays Free for the first two reads, flips to Pro on the third.
      let reads = 0;
      getQueryDataMock.mockImplementation(() => {
        reads += 1;
        return { subscription_tier: reads >= 3 ? "pro" : "free" };
      });

      render(<SubscriptionPage />);

      // The real backoff (0, 1500, 3000, 6000…), one advance per step. Each
      // attempt awaits its refetch before reading the cache, so an attempt's
      // read lands in the following advance — walking the schedule rather than
      // assuming a read per tick is what keeps this honest.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(6000);
      // Refetches EXACTLY this rider's key, not a prefix.
      expect(refetchQueriesMock).toHaveBeenCalledWith({
        queryKey: ["users-me", "test-user"],
      });
      expect(reads).toBeGreaterThanOrEqual(3);

      // Reached the live tier → the poll STOPS (no further refetches).
      const settled = refetchQueriesMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60000);
      expect(refetchQueriesMock.mock.calls.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling on a Premium→Pro change (does not stop at any non-Free tier)", async () => {
    // Codex: stopping at the first non-Free snapshot would end early for a
    // Premium→Pro conversion (cache is already Premium). Must wait for Pro.
    vi.useFakeTimers();
    try {
      mockSearchParams.value = new URLSearchParams("checkout=success");
      getSubscriptionMock.mockResolvedValue(paidSnapshot("pro")); // live = Pro
      // Cache is Premium (non-Free) but NOT the target Pro → keep polling.
      getQueryDataMock.mockReturnValue({ subscription_tier: "premium" });

      render(<SubscriptionPage />);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(3000);

      // A naive "any paid tier" check would have stopped after one refetch;
      // waiting for the exact target keeps polling.
      expect(refetchQueriesMock.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps refetching entitlements even when the billing snapshot errors", async () => {
    // Codex: if getSubscription fails, the target tier is unknown — the poll
    // must STILL refetch /users/me (bounded) so a webhook-synced tier lands,
    // rather than skipping every refetch and stranding the rider.
    vi.useFakeTimers();
    try {
      mockSearchParams.value = new URLSearchParams("checkout=success");
      // Non-404 failure → error state → no live target tier.
      getSubscriptionMock.mockRejectedValue(new Error("Failed to fetch"));

      render(<SubscriptionPage />);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(3000);

      // Refetched despite no target; keyed to this rider.
      expect(refetchQueriesMock).toHaveBeenCalledWith({
        queryKey: ["users-me", "test-user"],
      });
      expect(refetchQueriesMock.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a canceled notice on ?checkout=canceled", async () => {
    mockSearchParams.value = new URLSearchParams("checkout=canceled");
    getSubscriptionMock.mockResolvedValueOnce(freeSnapshot);

    render(<SubscriptionPage />);

    expect(await screen.findByText(/Checkout canceled/i)).toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith("/settings/subscription", {
      scroll: false,
    });
  });

  it("shows no checkout notice when the param is absent", async () => {
    getSubscriptionMock.mockResolvedValueOnce(freeSnapshot);

    render(<SubscriptionPage />);

    await waitFor(() => expect(getSubscriptionMock).toHaveBeenCalled());
    expect(screen.queryByText(/Payment successful/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Checkout canceled/i)).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("loads the current plan, billing history, and payment method from the API", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "premium",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [
          {
            tier: "free",
          },
          {
            tier: "premium",
          },
          {
            tier: "pro",
          },
        ],
        payment_method: {
          brand: "Visa",
          last4: "4242",
          exp_month: 8,
          exp_year: 2028,
        },
        billing_history: [
          {
            id: "inv_1",
            date: "2026-03-15T00:00:00.000Z",
            amount_label: "€29.99",
            amount_minor: 2999,
            currency: "EUR",
            status: "paid",
            invoice_url: "https://billing.example.com/invoices/inv_1.pdf",
          },
        ],
        portal_available: true,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });

    render(<SubscriptionPage />);

    expect(await screen.findByText("Renews Nov 15, 2026")).toBeInTheDocument();
    expect(screen.getByText("Visa ending in 4242")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Download invoice" }),
    ).toHaveAttribute("href", "https://billing.example.com/invoices/inv_1.pdf");
    expect(
      screen.getByRole("button", { name: "Open billing portal" }),
    ).toBeInTheDocument();
  });

  it("still renders the Stripe portal controls for a stripe-managed subscription", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "pro",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "premium" }, { tier: "pro" }],
        payment_method: null,
        billing_history: [],
        portal_available: true,
        trial_eligible: true,
        provider: "stripe",
        managed_by: "stripe_portal",
      },
    });

    render(<SubscriptionPage />);

    expect(
      await screen.findByRole("button", { name: "Open billing portal" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Plan comparison")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel subscription" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Manage in the App Store"),
    ).not.toBeInTheDocument();
    // Stripe-managed rider with a payment method on file gets the real
    // Stripe-portal-routing action button.
    expect(
      screen.getByRole("button", { name: "Update payment method" }),
    ).toBeInTheDocument();
  });

  // #1191 item 7 — the rule the earlier gating test pinned is REVERSED, on
  // purpose. `portal_available` now means "a real Stripe side exists" (the
  // backend gates it on evidence, not the lingering customer id the old test's
  // premise relied on), and a rider whose displayed plan is store-managed can
  // still hold a live Stripe subscription. Hiding every portal route behind
  // `!isStoreManaged` stranded exactly that rider from the one place that can
  // cancel the thing charging them. `managed_by` says where the DISPLAYED plan
  // is managed — never that it is the rider's only management target.
  it("keeps the Stripe portal reachable under a store-managed plan whenever portal_available is true", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "pro",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "premium" }, { tier: "pro" }],
        payment_method: {
          brand: "Visa",
          last4: "4242",
          exp_month: 8,
          exp_year: 2028,
        },
        billing_history: [
          {
            id: "in_1",
            date: "2026-07-15T00:00:00.000Z",
            amount_label: "€29.99",
            amount_minor: 2999,
            currency: "EUR",
            status: "paid",
            invoice_url: null,
          },
        ],
        // A REAL Stripe side exists beside the store representative — the
        // both-sides rider this rule exists for.
        portal_available: true,
        trial_eligible: true,
        provider: "apple",
        managed_by: "app_store",
      },
    });

    render(<SubscriptionPage />);

    // The store-managed panel still renders (the displayed plan IS the store's)...
    expect(
      await screen.findByText("Manage in the App Store"),
    ).toBeInTheDocument();
    // ...the portal stays reachable, labelled as STRIPE's so it cannot read
    // as managing the store plan on screen...
    expect(
      screen.getByRole("button", { name: "Open Stripe billing portal" }),
    ).toBeInTheDocument();
    // ...and so does the payment-method update, which acts on the Stripe side.
    expect(
      screen.getByRole("button", { name: "Update payment method" }),
    ).toBeInTheDocument();
  });

  it("attributes the payment method and invoices to Stripe under a store representative", async () => {
    // Both surfaces are ALWAYS Stripe's. Rendered beside an App Store plan
    // with no label, a real card and real invoices read as though they
    // describe that plan — a misattribution, not merely a gap. They are
    // labelled, never suppressed: hiding a card the rider is genuinely being
    // charged on would be worse.
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "pro",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "premium" }, { tier: "pro" }],
        payment_method: {
          brand: "Visa",
          last4: "4242",
          exp_month: 8,
          exp_year: 2028,
        },
        billing_history: [
          {
            id: "in_1",
            date: "2026-07-15T00:00:00.000Z",
            amount_label: "€29.99",
            amount_minor: 2999,
            currency: "EUR",
            status: "paid",
            invoice_url: null,
          },
        ],
        portal_available: true,
        trial_eligible: true,
        provider: "apple",
        managed_by: "app_store",
      },
    });

    render(<SubscriptionPage />);

    expect(
      await screen.findByText(
        "This payment method belongs to your Stripe subscription — your store-managed plan is billed by the store.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "These invoices are from your Stripe subscription — your store-managed plan is billed by the store.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Stripe")).toHaveLength(2);
    expect(screen.getByText("Visa ending in 4242")).toBeInTheDocument();
  });

  it("shows NO Stripe attribution when the plan is Stripe-managed", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "pro",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "premium" }, { tier: "pro" }],
        payment_method: {
          brand: "Visa",
          last4: "4242",
          exp_month: 8,
          exp_year: 2028,
        },
        billing_history: [],
        portal_available: true,
        trial_eligible: false,
        provider: "stripe",
        managed_by: "stripe_portal",
      },
    });

    render(<SubscriptionPage />);

    expect(
      await screen.findByRole("button", { name: "Open billing portal" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "This payment method belongs to your Stripe subscription — your store-managed plan is billed by the store.",
      ),
    ).not.toBeInTheDocument();
  });

  it("renders a read-only store panel instead of Stripe controls for an App Store subscription", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "pro",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "premium" }, { tier: "pro" }],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: "apple",
        managed_by: "app_store",
      },
    });

    render(<SubscriptionPage />);

    expect(
      await screen.findByText("Manage in the App Store"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your subscription is managed in the App Store. Open it to change or cancel your plan.",
      ),
    ).toBeInTheDocument();
    // Current plan display stays visible.
    expect(screen.getByText("Renews Nov 15, 2026")).toBeInTheDocument();
    // Stripe-only plan-action controls are gone.
    expect(
      screen.queryByRole("button", { name: "Open billing portal" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Plan comparison")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel subscription" }),
    ).not.toBeInTheDocument();
  });

  it("renders the Google Play variant of the store panel", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "premium",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "premium" }, { tier: "pro" }],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: "google",
        managed_by: "play_store",
      },
    });

    render(<SubscriptionPage />);

    expect(
      await screen.findByText("Manage in Google Play"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your subscription is managed in Google Play. Open it to change or cancel your plan.",
      ),
    ).toBeInTheDocument();
  });

  it("falls back to a preview snapshot when the subscription endpoint is unavailable", async () => {
    getSubscriptionMock.mockRejectedValueOnce(
      new ApiError("Not Found", 404, {}),
    );

    render(<SubscriptionPage />);

    expect(
      await screen.findByText(
        "Preview data shown while live billing management is still being wired up.",
      ),
    ).toBeInTheDocument();
    // Fallback preview's current plan is Pro (the €29.99 mid tier) —
    // shown once in the current-plan card and once in the plan grid.
    expect(screen.getAllByText("Pro")).toHaveLength(2);
    expect(screen.getByText("Visa ending in 4242")).toBeInTheDocument();
  });

  it("shows an error state instead of preview data for non-404 failures", async () => {
    getSubscriptionMock.mockRejectedValueOnce(new Error("Failed to fetch"));

    render(<SubscriptionPage />);

    expect(
      await screen.findByText("Could not load subscription settings."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Preview data shown while live billing management is still being wired up.",
      ),
    ).not.toBeInTheDocument();
  });

  it("opens a retention dialog with the active plan name", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "pro",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [
          {
            tier: "free",
          },
          {
            tier: "premium",
          },
          {
            tier: "pro",
          },
        ],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });

    render(<SubscriptionPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel subscription" }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Cancel subscription" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        "Downgrade to Free at the end of your current billing period.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/while Pro-only perks switch off/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keep Pro" }),
    ).toBeInTheDocument();
  });

  it("starts Stripe Checkout when a free user selects a paid plan", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "free",
          status: "canceled",
          renews_at: null,
          cancel_at_period_end: false,
        },
        plans: [
          {
            tier: "free",
          },
          {
            tier: "premium",
          },
          {
            tier: "pro",
          },
        ],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });
    createCheckoutSessionMock.mockResolvedValueOnce({
      data: { url: "https://checkout.stripe.com/session/test" },
    });

    render(<SubscriptionPage />);

    const premiumCard = (await screen.findByText("Premium")).closest("article");
    expect(premiumCard).not.toBeNull();
    fireEvent.click(
      // Trial-eligible + this card opens Checkout ⇒ the button offers it.
      within(premiumCard!).getByRole("button", { name: "Start free trial" }),
    );

    await waitFor(() =>
      expect(createCheckoutSessionMock).toHaveBeenCalledWith({
        tier: "premium",
      }),
    );
    expect(assignMock).toHaveBeenCalledWith(
      "https://checkout.stripe.com/session/test",
    );
  });

  it("lets a launch-granted paid user convert or switch plans through Checkout", async () => {
    // Founder grant: paid tier, no Stripe customer (portal_available
    // false), status canceled. The portal has nothing to manage, but
    // Checkout must stay open so the grant can convert to a paid plan.
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "pro",
          status: "canceled",
          renews_at: null,
          cancel_at_period_end: false,
        },
        plans: [
          {
            tier: "free",
          },
          {
            tier: "pro",
          },
          {
            tier: "premium",
          },
        ],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });
    createCheckoutSessionMock.mockResolvedValueOnce({
      data: { url: "https://checkout.stripe.com/session/test" },
    });

    render(<SubscriptionPage />);

    // The granted (current) plan converts via Checkout, labelled Subscribe.
    const proCard = (await screen.findAllByText("Pro"))
      .map((el) => el.closest("article"))
      .find((el) => el !== null);
    expect(proCard).not.toBeNull();
    const subscribeButton = within(proCard!).getByRole("button", {
      name: "Start free trial",
    });
    expect(subscribeButton).toBeEnabled();

    // The other paid tier is also reachable via Checkout.
    const premiumCard = (await screen.findByText("Premium")).closest("article");
    const upgradeButton = within(premiumCard!).getByRole("button", {
      name: "Start free trial",
    });
    expect(upgradeButton).toBeEnabled();

    // The free card stays inert — a grant is not a subscription to cancel.
    const freeCard = (await screen.findByText("Free")).closest("article");
    expect(
      within(freeCard!).getByRole("button", { name: "Downgrade" }),
    ).toBeDisabled();

    fireEvent.click(upgradeButton);
    await waitFor(() =>
      expect(createCheckoutSessionMock).toHaveBeenCalledWith({
        tier: "premium",
      }),
    );
    expect(assignMock).toHaveBeenCalledWith(
      "https://checkout.stripe.com/session/test",
    );
  });

  it("keeps routing a granted user through Checkout after an abandoned Checkout created a Stripe customer", async () => {
    // Starting Checkout persists a Stripe customer, so portal_available
    // flips true — but there is still no subscription (status stays
    // canceled). Plan changes must keep going through Checkout; the
    // portal's subscription flows would be rejected without a
    // subscription id.
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "pro",
          status: "canceled",
          renews_at: null,
          cancel_at_period_end: false,
        },
        plans: [
          {
            tier: "free",
          },
          {
            tier: "pro",
          },
          {
            tier: "premium",
          },
        ],
        payment_method: null,
        billing_history: [],
        portal_available: true,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });
    createCheckoutSessionMock.mockResolvedValueOnce({
      data: { url: "https://checkout.stripe.com/session/test" },
    });

    render(<SubscriptionPage />);

    const premiumCard = (await screen.findByText("Premium")).closest("article");
    fireEvent.click(
      // Trial-eligible + this card opens Checkout ⇒ the button offers it.
      within(premiumCard!).getByRole("button", { name: "Start free trial" }),
    );

    await waitFor(() =>
      expect(createCheckoutSessionMock).toHaveBeenCalledWith({
        tier: "premium",
      }),
    );
    expect(createPortalSessionMock).not.toHaveBeenCalled();
  });

  it("opens the payment-method update portal flow", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "premium",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [
          {
            tier: "free",
          },
          {
            tier: "premium",
          },
          {
            tier: "pro",
          },
        ],
        payment_method: {
          brand: "Visa",
          last4: "4242",
          exp_month: 8,
          exp_year: 2028,
        },
        billing_history: [],
        portal_available: true,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });
    createPortalSessionMock.mockResolvedValueOnce({
      data: { url: "https://billing.stripe.com/p/session/payment-method" },
    });

    render(<SubscriptionPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Update payment method" }),
    );

    await waitFor(() =>
      expect(createPortalSessionMock).toHaveBeenCalledWith({
        flow: "payment_method_update",
      }),
    );
    expect(assignMock).toHaveBeenCalledWith(
      "https://billing.stripe.com/p/session/payment-method",
    );
  });

  it("routes paid-to-free plan changes through the cancellation portal flow", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "premium",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [
          {
            tier: "free",
          },
          {
            tier: "premium",
          },
          {
            tier: "pro",
          },
        ],
        payment_method: {
          brand: "Visa",
          last4: "4242",
          exp_month: 8,
          exp_year: 2028,
        },
        billing_history: [],
        portal_available: true,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });
    createPortalSessionMock.mockResolvedValueOnce({
      data: { url: "https://billing.stripe.com/p/session/cancel-from-free" },
    });

    render(<SubscriptionPage />);

    const freeCard = (await screen.findByText("Free")).closest("article");
    expect(freeCard).not.toBeNull();
    fireEvent.click(
      within(freeCard!).getByRole("button", { name: "Downgrade" }),
    );

    await waitFor(() =>
      expect(createPortalSessionMock).toHaveBeenCalledWith({
        flow: "subscription_cancel",
      }),
    );
    expect(assignMock).toHaveBeenCalledWith(
      "https://billing.stripe.com/p/session/cancel-from-free",
    );
  });

  it("opens the cancellation portal flow from the retention dialog", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "premium",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [
          {
            tier: "free",
          },
          {
            tier: "premium",
          },
          {
            tier: "pro",
          },
        ],
        payment_method: {
          brand: "Visa",
          last4: "4242",
          exp_month: 8,
          exp_year: 2028,
        },
        billing_history: [],
        portal_available: true,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });
    createPortalSessionMock.mockResolvedValueOnce({
      data: { url: "https://billing.stripe.com/p/session/cancel" },
    });

    render(<SubscriptionPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel subscription" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Cancel subscription",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open billing portal" }),
    );

    await waitFor(() =>
      expect(createPortalSessionMock).toHaveBeenCalledWith({
        flow: "subscription_cancel",
      }),
    );
    expect(assignMock).toHaveBeenCalledWith(
      "https://billing.stripe.com/p/session/cancel",
    );
  });

  // `sys_billing_checkout` kills NEW subscriptions only. `createCheckoutSession`
  // answers 503 before it reaches Stripe, so a control that would start one is a
  // dead end — but every portal flow stays open on purpose, because trapping a
  // paying rider in a subscription they cannot cancel is the worse failure.
  describe("sys_billing_checkout", () => {
    function snapshot(current: { tier: string; status: string }) {
      return {
        data: {
          current_plan: {
            tier: current.tier,
            status: current.status,
            renews_at: null,
            cancel_at_period_end: false,
          },
          plans: [{ tier: "free" }, { tier: "pro" }, { tier: "premium" }],
          payment_method: null,
          billing_history: [],
          portal_available: true,
          trial_eligible: true,
          provider: "stripe",
          managed_by: "stripe_portal",
        },
      };
    }

    // Every plan card's button reads the same "Upgrade"/"Downgrade", so scope
    // by the card itself — its h3 is the plan name (the CurrentPlanCard
    // heading above is an h2, so the level keeps them apart).
    async function planCardButton(planName: string) {
      const heading = await screen.findByRole("heading", {
        name: planName,
        level: 3,
      });
      const card = heading.closest("article");
      if (!card) throw new Error(`no card for ${planName}`);
      return within(card).getByRole("button");
    }

    const BANNER_PORTAL_OPEN =
      "New subscriptions are temporarily unavailable. You can still manage or cancel your current plan.";
    const BANNER_NOTHING_LEFT =
      "New subscriptions are temporarily unavailable. Please try again later.";

    it("disables the paid plan cards for a free rider and explains why", async () => {
      checkoutSwitch.enabled = false;
      getSubscriptionMock.mockResolvedValueOnce(
        snapshot({ tier: "free", status: "canceled" }) as never,
      );

      render(<SubscriptionPage />);

      expect(await screen.findByText(BANNER_PORTAL_OPEN)).toBeInTheDocument();
      // Both paid cards route through Checkout for a free rider.
      const pro = await planCardButton("Pro");
      expect(pro).toBeDisabled();
      expect(await planCardButton("Premium")).toBeDisabled();
      fireEvent.click(pro);
      expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    });

    it("says nothing to an active paid rider — the switch does not touch them", async () => {
      checkoutSwitch.enabled = false;
      getSubscriptionMock.mockResolvedValueOnce(
        snapshot({ tier: "pro", status: "active" }) as never,
      );

      render(<SubscriptionPage />);

      // Every action they have is a portal flow, so an incident notice here
      // would be noise about an outage they are not in.
      await screen.findByRole("heading", { name: "Premium", level: 3 });
      expect(
        screen.queryByText(/New subscriptions are temporarily unavailable/),
      ).not.toBeInTheDocument();
    });

    it("leaves the header billing portal reachable while checkout is killed", async () => {
      checkoutSwitch.enabled = false;
      getSubscriptionMock.mockResolvedValueOnce(
        snapshot({ tier: "pro", status: "active" }) as never,
      );
      createPortalSessionMock.mockResolvedValueOnce({
        data: { url: "https://billing.stripe.com/p/session/manage" },
      });

      render(<SubscriptionPage />);

      fireEvent.click(
        await screen.findByRole("button", { name: "Open billing portal" }),
      );
      await waitFor(() =>
        expect(createPortalSessionMock).toHaveBeenCalledWith({
          flow: "manage",
        }),
      );
    });

    it("leaves a paid rider's plan CHANGE reachable — it routes to the portal", async () => {
      checkoutSwitch.enabled = false;
      getSubscriptionMock.mockResolvedValueOnce(
        snapshot({ tier: "pro", status: "active" }) as never,
      );
      createPortalSessionMock.mockResolvedValueOnce({
        data: { url: "https://billing.stripe.com/p/session/update" },
      });

      render(<SubscriptionPage />);

      // Pro → Premium is `subscription_update`, not a Checkout, so the switch
      // must not touch it. Blanking it would strand a paying rider.
      const upgrade = await planCardButton("Premium");
      expect(upgrade).not.toBeDisabled();
      fireEvent.click(upgrade);
      await waitFor(() =>
        expect(createPortalSessionMock).toHaveBeenCalledWith({
          flow: "subscription_update",
        }),
      );
    });

    it("leaves the payment-method repair reachable while checkout is killed", async () => {
      checkoutSwitch.enabled = false;
      // The flow a rider uses to fix a FAILED payment. Of the four portal
      // paths this is the one whose loss would hurt most — the rider is
      // already in a billing failure — so it gets its own case rather than
      // riding on the header portal's.
      getSubscriptionMock.mockResolvedValueOnce(
        snapshot({ tier: "pro", status: "past_due" }) as never,
      );
      createPortalSessionMock.mockResolvedValueOnce({
        data: { url: "https://billing.stripe.com/p/session/payment-method" },
      });

      render(<SubscriptionPage />);

      // Since #1198 a past-due rider's PLAN CARDS offer the same payment
      // recovery as the payment-method card, so several of these buttons
      // exist; any of them is the repair path the switch must not touch.
      const repairButtons = await screen.findAllByRole("button", {
        name: "Update payment method",
      });
      fireEvent.click(repairButtons[0]!);
      await waitFor(() =>
        expect(createPortalSessionMock).toHaveBeenCalledWith({
          flow: "payment_method_update",
        }),
      );
    });

    it("leaves the cancel flow reachable while checkout is killed", async () => {
      checkoutSwitch.enabled = false;
      getSubscriptionMock.mockResolvedValueOnce(
        snapshot({ tier: "pro", status: "active" }) as never,
      );
      createPortalSessionMock.mockResolvedValueOnce({
        data: { url: "https://billing.stripe.com/p/session/cancel" },
      });

      render(<SubscriptionPage />);

      fireEvent.click(
        await screen.findByRole("button", { name: "Cancel subscription" }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "Cancel subscription",
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Open billing portal" }),
      );
      await waitFor(() =>
        expect(createPortalSessionMock).toHaveBeenCalledWith({
          flow: "subscription_cancel",
        }),
      );
    });

    it("explains itself to a granted rider whose every action is a Checkout", async () => {
      checkoutSwitch.enabled = false;
      // A paid tier with a canceled status: an operator grant with no live
      // Stripe subscription, so the page routes every plan action through
      // Checkout. With the switch off that rider has no action at all — the
      // cards must not sit inert without a reason, and the portal wording
      // would be a lie since the portal has nothing to act on.
      getSubscriptionMock.mockResolvedValueOnce(
        snapshot({ tier: "pro", status: "canceled" }) as never,
      );

      render(<SubscriptionPage />);

      expect(await screen.findByText(BANNER_NOTHING_LEFT)).toBeInTheDocument();
      expect(screen.queryByText(BANNER_PORTAL_OPEN)).not.toBeInTheDocument();
      expect(await planCardButton("Pro")).toBeDisabled();
      expect(await planCardButton("Premium")).toBeDisabled();
    });

    it("keeps checkout working while the switch is UNRESOLVED (fails safe)", async () => {
      // The genuine unresolved state: `/config/flags` has not answered, so the
      // real hook reports `enabled: true, isResolved: false`. A kill switch
      // must never disable billing on a slow or failed flag fetch.
      checkoutSwitch.enabled = true;
      checkoutSwitch.isResolved = false;
      getSubscriptionMock.mockResolvedValueOnce(
        snapshot({ tier: "free", status: "canceled" }) as never,
      );
      createCheckoutSessionMock.mockResolvedValueOnce({
        data: { url: "https://checkout.stripe.com/c/session" },
      });

      render(<SubscriptionPage />);

      const pro = await planCardButton("Pro");
      expect(pro).not.toBeDisabled();
      expect(
        screen.queryByText(/New subscriptions are temporarily unavailable/),
      ).not.toBeInTheDocument();
      fireEvent.click(pro);
      await waitFor(() =>
        expect(createCheckoutSessionMock).toHaveBeenCalledWith({ tier: "pro" }),
      );
    });

    it("disables checkout on a live flip, without a reload", async () => {
      getSubscriptionMock.mockResolvedValueOnce(
        snapshot({ tier: "free", status: "canceled" }) as never,
      );

      const { rerender } = render(<SubscriptionPage />);

      expect(await planCardButton("Pro")).not.toBeDisabled();
      expect(
        screen.queryByText(/New subscriptions are temporarily unavailable/),
      ).not.toBeInTheDocument();

      // The operator flips the switch mid-session. `useSystemSwitch` polls, so
      // the kill lands on the next render — a rider sitting on this page must
      // not keep a live Checkout button until they happen to reload.
      checkoutSwitch.enabled = false;
      rerender(<SubscriptionPage />);

      expect(await planCardButton("Pro")).toBeDisabled();
      expect(screen.getByText(BANNER_PORTAL_OPEN)).toBeInTheDocument();
    });
  });
});
