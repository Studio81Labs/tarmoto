import { createFormatters, makeTranslator } from "@tarmoto/shared";
import { t } from "@/i18n";
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
  tierLabel,
  type CurrentSubscriptionPlan,
} from "../subscription";
import { ApiError } from "../api";

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

describe("tierLabel", () => {
  it("labels each tier", () => {
    expect(tierLabel("pro", t)).toBe("Pro");
    expect(tierLabel("premium", t)).toBe("Premium");
    expect(tierLabel("free", t)).toBe("Free");
  });
});

describe("planActionLabel", () => {
  it("labels the current plan as such", () => {
    expect(planActionLabel("pro", "pro", t)).toBe("Current plan");
  });

  it("labels a higher tier as an upgrade", () => {
    expect(planActionLabel("premium", "free", t)).toBe("Upgrade");
  });

  it("labels a lower tier as a downgrade", () => {
    expect(planActionLabel("free", "premium", t)).toBe("Downgrade");
  });
});

describe("describeRenewal", () => {
  it("renders the localized renewal date for an active plan", () => {
    expect(describeRenewal(plan(), format, t)).toBe("Renews Nov 15, 2026");
  });

  it("falls back to the portal copy when no renewal date exists", () => {
    expect(describeRenewal(plan({ renewsAt: null }), format, t)).toBe(
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
    expect(describeRenewal(plan({ renewsAt: "not-a-date" }), format, t)).toBe(
      "Renews soon",
    );
    expect(
      describeRenewal(
        plan({ renewsAt: "not-a-date", status: "trialing" }),
        format,
        t,
      ),
    ).toBe("Trial ends soon");
  });

  it("labels a scheduled downgrade", () => {
    expect(describeRenewal(plan({ cancelAtPeriodEnd: true }), format, t)).toBe(
      "Downgrades Nov 15, 2026",
    );
  });

  it("labels a canceled plan with a remaining access window", () => {
    expect(describeRenewal(plan({ status: "canceled" }), format, t)).toBe(
      "Access ends Nov 15, 2026",
    );
  });

  it("labels a canceled plan with no access window", () => {
    expect(
      describeRenewal(plan({ status: "canceled", renewsAt: null }), format, t),
    ).toBe("Canceled");
  });
});

describe("invoiceStatusLabel", () => {
  it("labels each status", () => {
    expect(invoiceStatusLabel("open", t)).toBe("Open");
    expect(invoiceStatusLabel("refunded", t)).toBe("Refunded");
    expect(invoiceStatusLabel("paid", t)).toBe("Paid");
  });
});

describe("formatPaymentMethodLabel", () => {
  it("title-cases the brand and appends the last 4 digits", () => {
    expect(
      formatPaymentMethodLabel(
        { brand: "visa", last4: "4242", expMonth: 8, expYear: 2028 },
        t,
      ),
    ).toBe("Visa ending in 4242");
  });

  it("falls back to Card when the brand is empty", () => {
    expect(
      formatPaymentMethodLabel(
        { brand: "", last4: "4242", expMonth: 8, expYear: 2028 },
        t,
      ),
    ).toBe("Card ending in 4242");
  });
});

describe("formatPaymentMethodExpiry", () => {
  it("zero-pads the month and keeps the raw 4-digit year", () => {
    expect(
      formatPaymentMethodExpiry(
        { brand: "visa", last4: "4242", expMonth: 8, expYear: 2028 },
        t,
      ),
    ).toBe("Expires 08/2028");
  });
});

describe("buildFallbackSubscriptionSnapshot", () => {
  it("produces the preview snapshot with English plan copy", () => {
    const snapshot = buildFallbackSubscriptionSnapshot(t);
    expect(snapshot.currentPlan.name).toBe("Pro");
    expect(snapshot.plans.map((p) => p.name)).toEqual([
      "Free",
      "Pro",
      "Premium",
    ]);
    expect(snapshot.plans.find((p) => p.tier === "free")?.features).toEqual([
      "Basic navigation",
      "Road quality overlay (limited)",
      "Hazard alerts",
      "1 active trip",
    ]);
    expect(snapshot.plans.find((p) => p.tier === "premium")?.features).toEqual([
      "Everything in Pro",
      "Unlimited group rides",
      "Priority hazard alerts",
      "Advanced analytics",
    ]);
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
    const snapshot = normalizeSubscriptionSnapshot(
      {
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
      },
      t,
    );

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
    const snapshot = normalizeSubscriptionSnapshot(
      {
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
      },
      t,
    );

    expect(snapshot.currentPlan.manageUrl).toBeNull();
    expect(snapshot.billingHistory[0]?.invoiceUrl).toBeNull();
  });

  it("keeps safe billing links intact", () => {
    const snapshot = normalizeSubscriptionSnapshot(
      {
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
      },
      t,
    );

    expect(snapshot.currentPlan.manageUrl).toBe(
      "https://billing.example.com/portal",
    );
    expect(snapshot.billingHistory[0]?.invoiceUrl).toBe(
      "http://billing.example.com/invoices/inv_1.pdf",
    );
  });

  it("falls back to the default plan features, translated, when the backend omits an amount label or feature list", () => {
    const snapshot = normalizeSubscriptionSnapshot(
      {
        billing_history: [
          {
            id: "inv_1",
            date: "2026-01-01T00:00:00.000Z",
            status: "paid",
          },
        ],
      },
      t,
    );

    expect(snapshot.billingHistory[0]?.amountLabel).toBe("Unavailable");
  });
});

// Builds a translator over a minimal en-only catalog stub (independent of the
// real companion catalog) whose values are DISTINCT sentinels ("XX…" / "XX-…")
// rather than an identity map. An identity map can't tell a real `t()` call
// apart from a regression that bypasses `t()` and returns the raw canonical
// English constant — both would produce the same string. With sentinel
// values, a bypass regression returns the untranslated English constant and
// these assertions fail.
describe("subscription translator wiring", () => {
  const t = makeTranslator<string>({
    en: {
      Pro: "XX-Pro",
      Premium: "XX-Premium",
      Free: "XX-Free",
      "Current plan": "XX-CurrentPlan",
      Upgrade: "XX-Upgrade",
      Downgrade: "XX-Downgrade",
      soon: "XX-soon",
      "Downgrades {date}": "XX Downgrades {date}",
      "Trial ends {date}": "XX Trial ends {date}",
      Canceled: "XX-Canceled",
      "Access ends {date}": "XX Access ends {date}",
      "Renews {date}": "XX Renews {date}",
      "Billing cycle managed in the portal":
        "XX-BillingCycleManagedInThePortal",
      "{brand} ending in {last4}": "XX {brand} ending in {last4}",
      Card: "XX-Card",
      "Expires {mm}/{yyyy}": "XX Expires {mm}/{yyyy}",
      Open: "XX-Open",
      Refunded: "XX-Refunded",
      Paid: "XX-Paid",
      "Basic navigation": "XX-BasicNavigation",
      "Road quality overlay (limited)": "XX-RoadQualityOverlayLimited",
      "Hazard alerts": "XX-HazardAlerts",
      "1 active trip": "XX-OneActiveTrip",
      "Unlimited trip planning": "XX-UnlimitedTripPlanning",
      "Full road quality zoom": "XX-FullRoadQualityZoom",
      "Offline maps": "XX-OfflineMaps",
      "GPX export": "XX-GPXExport",
      "Everything in Pro": "XX-EverythingInPro",
      "Unlimited group rides": "XX-UnlimitedGroupRides",
      "Priority hazard alerts": "XX-PriorityHazardAlerts",
      "Advanced analytics": "XX-AdvancedAnalytics",
      "API access": "XX-APIAccess",
      Unavailable: "XX-Unavailable",
    },
  });

  it("tierLabel returns the translated sentinel for each tier", () => {
    expect(tierLabel("pro", t)).toBe("XX-Pro");
    expect(tierLabel("premium", t)).toBe("XX-Premium");
    expect(tierLabel("free", t)).toBe("XX-Free");
  });

  it("planActionLabel returns the translated sentinel for each branch", () => {
    expect(planActionLabel("pro", "pro", t)).toBe("XX-CurrentPlan");
    expect(planActionLabel("premium", "free", t)).toBe("XX-Upgrade");
    expect(planActionLabel("free", "premium", t)).toBe("XX-Downgrade");
  });

  it("describeRenewal routes the active-renewal template through the translator", () => {
    expect(describeRenewal(plan(), format, t)).toBe("XX Renews Nov 15, 2026");
  });

  it("describeRenewal routes the scheduled-downgrade template through the translator", () => {
    expect(describeRenewal(plan({ cancelAtPeriodEnd: true }), format, t)).toBe(
      "XX Downgrades Nov 15, 2026",
    );
  });

  it("describeRenewal routes the trial-ends template and the soon fallback through the translator", () => {
    expect(
      describeRenewal(
        plan({ status: "trialing", renewsAt: "not-a-date" }),
        format,
        t,
      ),
    ).toBe("XX Trial ends XX-soon");
  });

  it("describeRenewal routes the bare-canceled label through the translator", () => {
    expect(
      describeRenewal(plan({ status: "canceled", renewsAt: null }), format, t),
    ).toBe("XX-Canceled");
  });

  it("describeRenewal routes the access-ends template through the translator", () => {
    expect(describeRenewal(plan({ status: "canceled" }), format, t)).toBe(
      "XX Access ends Nov 15, 2026",
    );
  });

  it("describeRenewal routes the no-renewal portal copy through the translator", () => {
    expect(describeRenewal(plan({ renewsAt: null }), format, t)).toBe(
      "XX-BillingCycleManagedInThePortal",
    );
  });

  it("invoiceStatusLabel returns the translated sentinel for each status", () => {
    expect(invoiceStatusLabel("open", t)).toBe("XX-Open");
    expect(invoiceStatusLabel("refunded", t)).toBe("XX-Refunded");
    expect(invoiceStatusLabel("paid", t)).toBe("XX-Paid");
  });

  it("formatPaymentMethodLabel routes the brand template through the translator", () => {
    expect(
      formatPaymentMethodLabel(
        { brand: "visa", last4: "4242", expMonth: 8, expYear: 2028 },
        t,
      ),
    ).toBe("XX Visa ending in 4242");
  });

  it("formatPaymentMethodLabel routes the empty-brand Card fallback through the translator", () => {
    expect(
      formatPaymentMethodLabel(
        { brand: "", last4: "4242", expMonth: 8, expYear: 2028 },
        t,
      ),
    ).toBe("XX XX-Card ending in 4242");
  });

  it("formatPaymentMethodExpiry routes the expiry template through the translator", () => {
    expect(
      formatPaymentMethodExpiry(
        { brand: "visa", last4: "4242", expMonth: 8, expYear: 2028 },
        t,
      ),
    ).toBe("XX Expires 08/2028");
  });

  it("buildFallbackSubscriptionSnapshot routes plan names and feature lists through the translator", () => {
    const snapshot = buildFallbackSubscriptionSnapshot(t);
    expect(snapshot.currentPlan.name).toBe("XX-Pro");
    expect(snapshot.plans.find((p) => p.tier === "free")?.features).toEqual([
      "XX-BasicNavigation",
      "XX-RoadQualityOverlayLimited",
      "XX-HazardAlerts",
      "XX-OneActiveTrip",
    ]);
    expect(snapshot.plans.find((p) => p.tier === "pro")?.features).toEqual([
      "XX-UnlimitedTripPlanning",
      "XX-FullRoadQualityZoom",
      "XX-OfflineMaps",
      "XX-GPXExport",
    ]);
    expect(snapshot.plans.find((p) => p.tier === "premium")?.features).toEqual([
      "XX-EverythingInPro",
      "XX-UnlimitedGroupRides",
      "XX-PriorityHazardAlerts",
      "XX-AdvancedAnalytics",
    ]);
    // "Visa" is an excluded brand name (trademark), never routed through t().
    expect(snapshot.paymentMethod?.brand).toBe("Visa");
  });

  it("normalizeSubscriptionSnapshot routes normalizePlans' name/feature fallback through the translator", () => {
    const snapshot = normalizeSubscriptionSnapshot(
      { plans: [{ tier: "premium", price_label: "€1", features: [] }] },
      t,
    );
    const premiumPlan = snapshot.plans.find((p) => p.tier === "premium");
    expect(premiumPlan?.name).toBe("XX-Premium");
    expect(premiumPlan?.features).toEqual([
      "XX-UnlimitedGroupRides",
      "XX-PriorityHazardAlerts",
      "XX-APIAccess",
    ]);
  });

  it("normalizeSubscriptionSnapshot routes backend-provided plan name/features through the translator", () => {
    // The backend PLAN_CATALOG sends plan copy in English that mirrors the
    // registered catalog keys, so wire-provided name/features are localized at
    // the normalize boundary (Codex P2 — previously this path was bypassed and
    // /settings/subscription stayed English for normal users). Reuse
    // "Pro"/"Premium" — both registered sentinel keys above — as the WIRE
    // values: they come back as sentinels, proving the wire path is translated.
    const snapshot = normalizeSubscriptionSnapshot(
      {
        plans: [
          {
            tier: "premium",
            name: "Premium",
            price_label: "€1",
            features: ["Pro", "Premium"],
            description: "Pro",
          },
        ],
      },
      t,
    );
    const premiumPlan = snapshot.plans.find((p) => p.tier === "premium");
    expect(premiumPlan?.name).toBe("XX-Premium");
    expect(premiumPlan?.features).toEqual(["XX-Pro", "XX-Premium"]);
    // The backend Premium plan carries an English description too — reuse the
    // registered "Pro" sentinel key as the wire description to prove it's
    // translated at the boundary (Codex P2 follow-up).
    expect(premiumPlan?.description).toBe("XX-Pro");
  });

  it("normalizeSubscriptionSnapshot routes the missing-amount-label invoice fallback through the translator", () => {
    const snapshot = normalizeSubscriptionSnapshot(
      {
        billing_history: [
          { id: "inv_1", date: "2026-01-01T00:00:00.000Z", status: "paid" },
        ],
      },
      t,
    );
    expect(snapshot.billingHistory[0]?.amountLabel).toBe("XX-Unavailable");
  });
});
