import {
  createFormatters,
  makeTranslator,
  FEATURE_DEFINITIONS,
  SUBSCRIPTION_TIERS,
  type SubscriptionTier,
} from "@tarmoto/shared";
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
      // Annotated, not implied: group rides exist only in the mobile app.
      "Group rides (mobile app)",
      "Advanced analytics",
      "Unlimited trip collaborators",
    ]);
    // "Priority hazard alerts" is gone: the registry grants it to Premium, but
    // it is not built, so the card no longer promises it.
    expect(snapshot.provider).toBeNull();
    expect(snapshot.managedBy).toBeNull();
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

  it("formats stable invoice amounts with the rider's regional locale", () => {
    const snapshot = normalizeSubscriptionSnapshot(
      {
        billing_history: [
          {
            id: "inv_1",
            date: "2026-01-01T00:00:00.000Z",
            amount_minor: 2999,
            currency: "EUR",
            amount_label: "backend display text",
            status: "paid",
          },
        ],
      },
      t,
      "cs-CZ",
    );

    expect(
      snapshot.billingHistory[0]?.amountLabel.replace(/[\u00A0\u202F]/g, " "),
    ).toBe("29,99 €");
  });

  it("maps a store-managed provider and managed_by from the raw snapshot", () => {
    const snapshot = normalizeSubscriptionSnapshot(
      {
        current_plan: {
          tier: "pro",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        provider: "apple",
        managed_by: "app_store",
      },
      t,
    );

    expect(snapshot.provider).toBe("apple");
    expect(snapshot.managedBy).toBe("app_store");
  });

  it("defaults provider and managed_by to null when absent or invalid", () => {
    const snapshot = normalizeSubscriptionSnapshot(
      {
        current_plan: {
          tier: "pro",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        provider: "not-a-real-provider",
        managed_by: "not-a-real-managed-by",
      },
      t,
    );

    expect(snapshot.provider).toBeNull();
    expect(snapshot.managedBy).toBeNull();
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
      "{count, plural, one {# active trip} other {# active trips}}":
        "XX-{count}-ActiveTrips",
      "Unlimited trip planning": "XX-UnlimitedTripPlanning",
      "Full road quality zoom": "XX-FullRoadQualityZoom",
      "Offline maps": "XX-OfflineMaps",
      "GPX export": "XX-GPXExport",
      "Everything in Pro": "XX-EverythingInPro",
      "Group rides": "XX-GroupRides",
      "Advanced analytics": "XX-AdvancedAnalytics",
      "Unlimited trip collaborators": "XX-UnlimitedTripCollaborators",
      "{count, plural, one {# trip collaborator} other {# trip collaborators}}":
        "XX-{count}-TripCollaborators",
      "{feature} (mobile app)": "XX-{feature}-MobileApp",
      "For group organisers and power users.": "XX-PremiumDescription",
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
      "XX-1-ActiveTrips",
    ]);
    expect(snapshot.plans.find((p) => p.tier === "pro")?.features).toEqual([
      "XX-UnlimitedTripPlanning",
      "XX-FullRoadQualityZoom",
      // The mobile annotation is applied through the translator too, so a
      // localized build cannot end up with an English "(mobile app)" tail.
      "XX-XX-OfflineMaps-MobileApp",
      "XX-GPXExport",
      "XX-5-TripCollaborators",
    ]);
    expect(snapshot.plans.find((p) => p.tier === "premium")?.features).toEqual([
      "XX-EverythingInPro",
      "XX-XX-GroupRides-MobileApp",
      "XX-AdvancedAnalytics",
      "XX-UnlimitedTripCollaborators",
    ]);
    // "Visa" is an excluded brand name (trademark), never routed through t().
    expect(snapshot.paymentMethod?.brand).toBe("Visa");
  });

  it("normalizeSubscriptionSnapshot derives localized plan copy from the tier", () => {
    const snapshot = normalizeSubscriptionSnapshot(
      { plans: [{ tier: "premium", price_label: "€1", features: [] }] },
      t,
    );
    const premiumPlan = snapshot.plans.find((p) => p.tier === "premium");
    expect(premiumPlan?.name).toBe("XX-Premium");
    expect(premiumPlan?.features).toEqual([
      "XX-EverythingInPro",
      "XX-XX-GroupRides-MobileApp",
      "XX-AdvancedAnalytics",
      "XX-UnlimitedTripCollaborators",
    ]);
    expect(premiumPlan?.description).toBe("XX-PremiumDescription");
  });

  it("normalizeSubscriptionSnapshot ignores backend-authored display prose", () => {
    const snapshot = normalizeSubscriptionSnapshot(
      {
        plans: [
          {
            tier: "premium",
            name: "Wire plan name",
            price_label: "€1",
            features: ["Wire feature"],
            description: "Wire description",
          },
        ],
      },
      t,
    );
    const premiumPlan = snapshot.plans.find((p) => p.tier === "premium");
    expect(premiumPlan?.name).toBe("XX-Premium");
    expect(premiumPlan?.features).toEqual([
      "XX-EverythingInPro",
      "XX-XX-GroupRides-MobileApp",
      "XX-AdvancedAnalytics",
      "XX-UnlimitedTripCollaborators",
    ]);
    expect(premiumPlan?.description).toBe("XX-PremiumDescription");
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

describe("plan cards derive from the feature registry", () => {
  const cardsByTier = () => {
    const snapshot = buildFallbackSubscriptionSnapshot(t);
    return new Map(snapshot.plans.map((plan) => [plan.tier, plan.features]));
  };

  it("never advertises a capability the registry does not grant that tier", () => {
    // The point of deriving from the registry: a bullet is a commercial
    // promise, and the tier that owns a capability is decided by the thing
    // that enforces it. Each label is matched back to the key that produced it.
    const cards = cardsByTier();
    const CLAIMS: Record<string, { key: string; tiers: SubscriptionTier[] }> = {
      "Offline maps (mobile app)": {
        key: "offline_maps",
        tiers: ["pro", "premium"],
      },
      "GPX export": { key: "gpx_export", tiers: ["pro", "premium"] },
      "Group rides (mobile app)": {
        key: "group_rides",
        tiers: ["premium"],
      },
      "Advanced analytics": { key: "advanced_analytics", tiers: ["premium"] },
      "Basic navigation": {
        key: "basic_navigation",
        tiers: ["free", "pro", "premium"],
      },
      "Hazard alerts": {
        key: "hazard_alerts",
        tiers: ["free", "pro", "premium"],
      },
    };

    for (const [label, { key, tiers }] of Object.entries(CLAIMS)) {
      // The expectation itself is checked against the registry, so this test
      // cannot drift into asserting a tier map that is no longer true.
      const definition = FEATURE_DEFINITIONS[
        key as keyof typeof FEATURE_DEFINITIONS
      ] as { tiers: readonly SubscriptionTier[] };
      expect([...definition.tiers].sort()).toEqual([...tiers].sort());

      for (const tier of SUBSCRIPTION_TIERS) {
        if (cards.get(tier)?.includes(label) && !tiers.includes(tier)) {
          throw new Error(
            `"${label}" is on the ${tier} card, but the registry grants ${key} only to ${tiers.join(", ")}`,
          );
        }
      }
    }
  });

  it("NEVER renders a capability that is not built", () => {
    // `api_access`, `garmin_export` and `priority_hazard_alerts` are Premium
    // grants in the registry and deferred in `docs/feature-flags.md`. Naive
    // derivation would newly promise a personal API token and Garmin export on
    // a €49.99 card. The natural regression is a new registry key that is
    // marketable by default, so this asserts on the rendered cards rather than
    // on the copy map.
    const cards = cardsByTier();
    const unbuiltCopy = [
      "Personal API token",
      "Direct route export to Garmin",
      "Priority hazard alerts",
    ];
    for (const [, features] of cards) {
      for (const label of features) {
        for (const unbuilt of unbuiltCopy) {
          expect(label).not.toContain(unbuilt);
        }
      }
    }
  });

  it("DROPS a zero-valued limit rather than advertising the absence", () => {
    // `0` is how the registry disables a capability for a tier — Free gets no
    // trip collaborators — so the Free card must not carry a bullet reading
    // "0 trip collaborators". It is selected on every card and rendered only
    // where the allowance is non-zero, which is the same treatment an
    // ungranted toggle gets.
    const limit = (
      FEATURE_DEFINITIONS.max_trip_collaborators as {
        tiers: Record<SubscriptionTier, number | null>;
      }
    ).tiers;
    expect(limit.free).toBe(0);

    const free = cardsByTier().get("free") ?? [];
    for (const label of free) {
      expect(label).not.toContain("trip collaborator");
    }
  });

  it("reads limit VALUES from the registry rather than restating them", () => {
    // `max_trip_collaborators` is Pro = 5. A hardcoded "5" would keep claiming
    // five after the registry moved.
    const cards = cardsByTier();
    const limit = (
      FEATURE_DEFINITIONS.max_trip_collaborators as {
        tiers: Record<SubscriptionTier, number | null>;
      }
    ).tiers;
    expect(cards.get("pro")).toContain(`${limit.pro} trip collaborators`);
    expect(limit.premium).toBeNull();
    expect(cards.get("premium")).toContain("Unlimited trip collaborators");
  });
});
