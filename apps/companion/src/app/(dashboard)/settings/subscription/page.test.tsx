import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import SubscriptionPage from "./page";
import { ApiError, accountApi } from "@/lib/api";

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
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        assign: assignMock,
      },
    });
  });

  it("loads the current plan, billing history, and payment method from the API", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "premium",
          status: "active",
          price_label: "$29.99/yr",
          renews_at: "2026-11-15T00:00:00.000Z",
          manage_url: "https://billing.example.com/portal",
        },
        plans: [
          {
            tier: "free",
            name: "Free",
            price_label: "$0",
            features: ["Basic navigation", "Hazard alerts", "1 active trip"],
          },
          {
            tier: "premium",
            name: "Premium",
            price_label: "$29.99/yr",
            highlighted: true,
            features: ["Unlimited trip planning", "Offline maps"],
          },
          {
            tier: "pro",
            name: "Pro",
            price_label: "$49.99/yr",
            features: ["Unlimited group rides", "Advanced analytics"],
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
            amount_label: "$29.99",
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
    expect(screen.getAllByText("Premium")).toHaveLength(2);
    expect(screen.getByText("Visa ending in 4242")).toBeInTheDocument();
  });

  it("shows an error state instead of preview data for non-404 failures", async () => {
    getSubscriptionMock.mockRejectedValueOnce(new Error("Failed to fetch"));

    render(<SubscriptionPage />);

    expect(await screen.findByText("Failed to fetch")).toBeInTheDocument();
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
          name: "Pro",
          status: "active",
          price_label: "$49.99/yr",
          renews_at: "2026-11-15T00:00:00.000Z",
        },
        plans: [
          {
            tier: "free",
            name: "Free",
            price_label: "$0",
            features: ["Basic navigation"],
          },
          {
            tier: "premium",
            name: "Premium",
            price_label: "$29.99/yr",
            highlighted: true,
            features: ["Unlimited trip planning"],
          },
          {
            tier: "pro",
            name: "Pro",
            price_label: "$49.99/yr",
            features: ["Advanced analytics"],
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
          name: "Free",
          status: "canceled",
          price_label: "$0",
          renews_at: null,
          cancel_at_period_end: false,
        },
        plans: [
          {
            tier: "free",
            name: "Free",
            price_label: "$0",
            features: ["Basic navigation"],
          },
          {
            tier: "premium",
            name: "Premium",
            price_label: "$29.99/yr",
            highlighted: true,
            features: ["Unlimited trip planning"],
          },
          {
            tier: "pro",
            name: "Pro",
            price_label: "$49.99/yr",
            features: ["Advanced analytics"],
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

  it("opens the payment-method update portal flow", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "premium",
          name: "Premium",
          status: "active",
          price_label: "$29.99/yr",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [
          {
            tier: "free",
            name: "Free",
            price_label: "$0",
            features: ["Basic navigation"],
          },
          {
            tier: "premium",
            name: "Premium",
            price_label: "$29.99/yr",
            highlighted: true,
            features: ["Unlimited trip planning"],
          },
          {
            tier: "pro",
            name: "Pro",
            price_label: "$49.99/yr",
            features: ["Advanced analytics"],
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

  it("opens the cancellation portal flow from the retention dialog", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "premium",
          name: "Premium",
          status: "active",
          price_label: "$29.99/yr",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [
          {
            tier: "free",
            name: "Free",
            price_label: "$0",
            features: ["Basic navigation"],
          },
          {
            tier: "premium",
            name: "Premium",
            price_label: "$29.99/yr",
            highlighted: true,
            features: ["Unlimited trip planning"],
          },
          {
            tier: "pro",
            name: "Pro",
            price_label: "$49.99/yr",
            features: ["Advanced analytics"],
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
