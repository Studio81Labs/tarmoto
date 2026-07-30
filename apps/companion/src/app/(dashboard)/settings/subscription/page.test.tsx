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
const invalidateQueriesMock = vi.fn();
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
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
    mockReplace.mockReset();
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
    },
  };

  it("shows a success notice and strips the param on ?checkout=success", async () => {
    mockSearchParams.value = new URLSearchParams("checkout=success");
    getSubscriptionMock.mockResolvedValueOnce(freeSnapshot);

    render(<SubscriptionPage />);

    expect(await screen.findByText(/Payment successful/i)).toBeInTheDocument();
    // Param stripped so a refresh / Back doesn't re-show the banner.
    expect(mockReplace).toHaveBeenCalledWith("/settings/subscription", {
      scroll: false,
    });
    // Success re-pulls the entitlement cache (webhook may still be in flight).
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["users-me"],
    });
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
});
