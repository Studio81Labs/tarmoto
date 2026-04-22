import {
  normalizeSubscriptionSnapshot,
  shouldUseSubscriptionPreview,
} from "../subscription";
import { ApiError } from "../api";

describe("shouldUseSubscriptionPreview", () => {
  it("enables preview mode for explicit 404 errors", () => {
    expect(
      shouldUseSubscriptionPreview(new ApiError("Not Found", 404, {})),
    ).toBe(true);
    expect(shouldUseSubscriptionPreview({ status: 404 })).toBe(true);
  });

  it("keeps transport and server failures in the error state", () => {
    expect(shouldUseSubscriptionPreview(new Error("Failed to fetch"))).toBe(
      false,
    );
    expect(
      shouldUseSubscriptionPreview(
        new ApiError("Service unavailable", 503, {}),
      ),
    ).toBe(false);
  });
});

describe("normalizeSubscriptionSnapshot", () => {
  it("marks synthesized current-plan fallbacks as preview data", () => {
    const snapshot = normalizeSubscriptionSnapshot({
      current_plan: {
        name: "Plan from partial payload",
        manage_url: "https://billing.example.com/portal",
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
    });

    expect(snapshot.preview).toBe(true);
    expect(snapshot.currentPlan.tier).toBe("premium");
    expect(snapshot.currentPlan.status).toBe("active");
    expect(snapshot.currentPlan.priceLabel).toBe("$29.99/yr");
    expect(snapshot.billingHistory[0]?.invoiceUrl).toBe(
      "https://billing.example.com/invoices/inv_1.pdf",
    );
  });

  it("drops billing links that do not use http or https", () => {
    const snapshot = normalizeSubscriptionSnapshot({
      current_plan: {
        tier: "premium",
        name: "Premium",
        status: "active",
        price_label: "$29.99/yr",
        manage_url: "javascript:alert('xss')",
      },
      plans: [
        {
          tier: "premium",
          name: "Premium",
          price_label: "$29.99/yr",
          features: ["Unlimited trip planning"],
        },
      ],
      billing_history: [
        {
          id: "inv_1",
          date: "2026-03-15T00:00:00.000Z",
          amount_label: "$29.99",
          status: "paid",
          invoice_url: "data:text/html,hello",
        },
      ],
    });

    expect(snapshot.currentPlan.manageUrl).toBeNull();
    expect(snapshot.billingHistory[0]?.invoiceUrl).toBeNull();
  });

  it("keeps safe billing links intact", () => {
    const snapshot = normalizeSubscriptionSnapshot({
      current_plan: {
        tier: "premium",
        name: "Premium",
        status: "active",
        price_label: "$29.99/yr",
        manage_url: "https://billing.example.com/portal",
      },
      plans: [
        {
          tier: "premium",
          name: "Premium",
          price_label: "$29.99/yr",
          features: ["Unlimited trip planning"],
        },
      ],
      billing_history: [
        {
          id: "inv_1",
          date: "2026-03-15T00:00:00.000Z",
          amount_label: "$29.99",
          status: "paid",
          invoice_url: "http://billing.example.com/invoices/inv_1.pdf",
        },
      ],
    });

    expect(snapshot.currentPlan.manageUrl).toBe(
      "https://billing.example.com/portal",
    );
    expect(snapshot.billingHistory[0]?.invoiceUrl).toBe(
      "http://billing.example.com/invoices/inv_1.pdf",
    );
  });
});
