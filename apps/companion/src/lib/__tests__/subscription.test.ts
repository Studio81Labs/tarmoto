import {
  describeRenewal,
  formatInvoiceDate,
  normalizeSubscriptionSnapshot,
  shouldUseSubscriptionPreview,
  type CurrentSubscriptionPlan,
} from "../subscription";
import { ApiError } from "../api";
import { createFormatters } from "@tarmoto/shared";

const format = createFormatters({ locale: "en", units: "metric" });

function plan(
  overrides: Partial<CurrentSubscriptionPlan> = {},
): CurrentSubscriptionPlan {
  return {
    tier: "pro",
    name: "Pro",
    status: "active",
    priceLabel: "€29.99/mo",
    renewsAt: "2026-11-15T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    manageUrl: null,
    ...overrides,
  };
}

describe("describeRenewal", () => {
  it("renders the localized renewal date for an active plan", () => {
    expect(describeRenewal(plan(), format)).toBe("Renews Nov 15, 2026");
  });

  it("falls back to the portal copy when no renewal date exists", () => {
    expect(describeRenewal(plan({ renewsAt: null }), format)).toBe(
      "Billing cycle managed in the portal",
    );
  });

  // Regression: format.date() renders "" for an unparseable timestamp; a
  // present-but-malformed renews_at must degrade to the retired helper's
  // "soon" copy, not silently reroute an active plan to the portal message
  // (or strip a trial's end-date line entirely).
  it("degrades an unparseable invoice date to the missing-value dash instead of a blank heading", () => {
    expect(formatInvoiceDate("2026-11-15T00:00:00.000Z", format)).toBe(
      "Nov 15, 2026",
    );
    expect(formatInvoiceDate("not-a-date", format)).toBe("—");
  });

  it('degrades to "soon" when the renewal date is present but unparseable', () => {
    expect(describeRenewal(plan({ renewsAt: "not-a-date" }), format)).toBe(
      "Renews soon",
    );
    expect(
      describeRenewal(
        plan({ renewsAt: "not-a-date", status: "trialing" }),
        format,
      ),
    ).toBe("Trial ends soon");
  });
});

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
          amount_label: "€29.99",
          status: "paid",
          invoice_url: "https://billing.example.com/invoices/inv_1.pdf",
        },
      ],
    });

    expect(snapshot.preview).toBe(true);
    // The synthesized fallback plan is Pro — the €29.99 mid tier.
    expect(snapshot.currentPlan.tier).toBe("pro");
    expect(snapshot.currentPlan.status).toBe("active");
    expect(snapshot.currentPlan.priceLabel).toBe("€29.99/yr");
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
        price_label: "€29.99/yr",
        manage_url: "javascript:alert('xss')",
      },
      plans: [
        {
          tier: "premium",
          name: "Premium",
          price_label: "€29.99/yr",
          features: ["Unlimited trip planning"],
        },
      ],
      billing_history: [
        {
          id: "inv_1",
          date: "2026-03-15T00:00:00.000Z",
          amount_label: "€29.99",
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
        price_label: "€29.99/yr",
        manage_url: "https://billing.example.com/portal",
      },
      plans: [
        {
          tier: "premium",
          name: "Premium",
          price_label: "€29.99/yr",
          features: ["Unlimited trip planning"],
        },
      ],
      billing_history: [
        {
          id: "inv_1",
          date: "2026-03-15T00:00:00.000Z",
          amount_label: "€29.99",
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
