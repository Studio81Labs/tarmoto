import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SubscriptionPage from "./page";
import { accountApi } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    accountApi: {
      getSubscription: vi.fn(),
    },
  };
});

describe("SubscriptionPage", () => {
  const getSubscriptionMock = vi.mocked(accountApi.getSubscription);

  beforeEach(() => {
    getSubscriptionMock.mockReset();
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
      },
    });

    render(<SubscriptionPage />);

    expect(await screen.findByText("Renews Nov 15, 2026")).toBeInTheDocument();
    expect(screen.getByText("Visa ending in 4242")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Download invoice" }),
    ).toHaveAttribute("href", "https://billing.example.com/invoices/inv_1.pdf");
    expect(
      screen.getByRole("link", { name: "Open billing portal" }),
    ).toHaveAttribute("href", "https://billing.example.com/portal");
  });

  it("falls back to a preview snapshot when the subscription endpoint is unavailable", async () => {
    getSubscriptionMock.mockRejectedValueOnce(new Error("Not Found"));

    render(<SubscriptionPage />);

    expect(
      await screen.findByText(
        "Preview data shown while live billing management is still being wired up.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Premium")).toHaveLength(2);
    expect(screen.getByText("Visa ending in 4242")).toBeInTheDocument();
  });

  it("opens a retention dialog from the cancel section", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "premium",
          status: "active",
          price_label: "$29.99/yr",
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
      screen.getByRole("button", { name: "Keep Premium" }),
    ).toBeInTheDocument();
  });
});
