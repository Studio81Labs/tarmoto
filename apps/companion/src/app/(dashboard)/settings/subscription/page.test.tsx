import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import SubscriptionPage from "./page";
import { ApiError, accountApi } from "@/lib/api";
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
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({
    invalidateQueries: invalidateQueriesMock,
    refetchQueries: refetchQueriesMock,
    getQueryData: getQueryDataMock,
  }),
}));

// `sys_billing_checkout`. Defaults to ENABLED, which is both the production
// steady state and the fail-safe direction the real hook reports while the
// flag map is unresolved.
const checkoutSwitch = vi.hoisted(() => ({ enabled: true }));

// The page mounts useEntitlements only to make `/users/me` an active query; the
// real hook needs a QueryClientProvider this suite doesn't render, so stub it.
vi.mock("@/hooks/useEntitlements", () => ({
  useSystemSwitch: () => ({
    enabled: checkoutSwitch.enabled,
    isResolved: true,
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
    },
  };
});

// The page reads Stripe's `?checkout=success|canceled` return param and strips
// it via router.replace. Mutable holder so each case seeds its own param.
const mockReplace = vi.fn();
const mockSearchParams = vi.hoisted(() => ({
  value: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/subscription",
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams.value,
}));

describe("SubscriptionPage", () => {
  const getSubscriptionMock = vi.mocked(accountApi.getSubscription);
  const createCheckoutSessionMock = vi.mocked(accountApi.createCheckoutSession);
  const createPortalSessionMock = vi.mocked(accountApi.createPortalSession);
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
    checkoutSwitch.enabled = true;
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

  it("shows a neutral success notice (not a payment claim) and strips the param on ?checkout=success", async () => {
    mockSearchParams.value = new URLSearchParams("checkout=success");
    getSubscriptionMock.mockResolvedValueOnce(paidSnapshot("pro")); // real paid charge

    render(<SubscriptionPage />);

    // Neutral wording — never "Payment successful", which would be false for a
    // first-time rider whose Checkout only starts an unpaid trial.
    expect(
      await screen.findByText(/Subscription confirmed/i),
    ).toBeInTheDocument();
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

  it("shows trial wording (not a payment claim) when the returned plan is trialing", async () => {
    // Codex: a first-time rider's Checkout starts a 14-day trial with no
    // payment collected, so the banner must derive its copy from the billing
    // state rather than asserting a charge.
    mockSearchParams.value = new URLSearchParams("checkout=success");
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "pro" as const,
          status: "trialing" as const,
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

    render(<SubscriptionPage />);

    expect(
      await screen.findByText(/Your free trial has started/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Payment successful/i)).not.toBeInTheDocument();
  });

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

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(3000);
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

  // Regression: a rider who once touched Stripe Checkout, then switched to an
  // in-app-purchase subscription, keeps `stripe_customer_id` set server-side
  // (it is never cleared on the switch), so `portal_available` can normalize
  // true even though `managed_by` is now a store. The "Update payment method"
  // button must stay gated on `!isStoreManaged` — not just `portalAvailable`
  // — or clicking it would call `openPortal("payment_method_update")` and
  // route a store-managed rider into the Stripe billing portal, which is
  // exactly the control the store-managed panel is supposed to suppress.
  it("hides the Stripe payment-method button for a store-managed subscription even when portal_available is true", async () => {
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
        // Prior Stripe Checkout touch left portal_available true even though
        // this rider is now store-managed — stripe_customer_id is never
        // cleared on the switch.
        portal_available: true,
        trial_eligible: true,
        provider: "apple",
        managed_by: "app_store",
      },
    });

    render(<SubscriptionPage />);

    // The store-managed read-only panel renders...
    expect(
      await screen.findByText("Manage in the App Store"),
    ).toBeInTheDocument();
    // ...the payment method display still shows...
    expect(screen.getByText("Visa ending in 4242")).toBeInTheDocument();
    // ...but the Stripe-portal-routing action button must NOT render, since
    // it would route a store-managed rider into the Stripe billing portal.
    expect(
      screen.queryByRole("button", { name: "Update payment method" }),
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
      within(premiumCard!).getByRole("button", { name: "Upgrade" }),
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
      name: "Subscribe",
    });
    expect(subscribeButton).toBeEnabled();

    // The other paid tier is also reachable via Checkout.
    const premiumCard = (await screen.findByText("Premium")).closest("article");
    const upgradeButton = within(premiumCard!).getByRole("button", {
      name: "Upgrade",
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
      within(premiumCard!).getByRole("button", { name: "Upgrade" }),
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

    it("keeps checkout working while the switch is unresolved (fails safe)", async () => {
      // The real hook reports enabled until a `force_off` is CONFIRMED — a slow
      // `/config/flags` must never disable billing.
      checkoutSwitch.enabled = true;
      getSubscriptionMock.mockResolvedValueOnce(
        snapshot({ tier: "free", status: "canceled" }) as never,
      );
      createCheckoutSessionMock.mockResolvedValueOnce({
        data: { url: "https://checkout.stripe.com/c/session" },
      });

      render(<SubscriptionPage />);

      const pro = await planCardButton("Pro");
      expect(
        screen.queryByText(/New subscriptions are temporarily unavailable/),
      ).not.toBeInTheDocument();
      fireEvent.click(pro);
      await waitFor(() =>
        expect(createCheckoutSessionMock).toHaveBeenCalledWith({ tier: "pro" }),
      );
    });
  });
});
