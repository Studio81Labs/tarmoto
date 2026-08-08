import {
  GRANT_PLAN_SOURCES,
  PLAN_SOURCES,
  SUBSCRIPTION_TIERS,
  higherTier,
  isGrantPlanSource,
  PLANNER_POI_CATEGORIES,
  QUALITY_SOURCES,
  SUBSCRIPTION_PROVIDERS,
  IAP_PRODUCTS,
  managedByForProvider,
  type PlannerPoiCategory,
  type QualitySource,
} from "./constants";

describe("subscription providers", () => {
  it("lists the three billing providers", () => {
    expect(SUBSCRIPTION_PROVIDERS).toEqual(["stripe", "apple", "google"]);
  });
  it("maps each paid tier to trial + no-trial store products", () => {
    for (const tier of ["pro", "premium"] as const) {
      expect(IAP_PRODUCTS[tier].apple.trial).toMatch(/\.trial$/);
      expect(IAP_PRODUCTS[tier].apple.noTrial).not.toMatch(/\.trial$/);
      expect(IAP_PRODUCTS[tier].google.productId).toContain(tier);
    }
  });
  it("maps providers to their managed-by surface", () => {
    expect(managedByForProvider("stripe")).toBe("stripe_portal");
    expect(managedByForProvider("apple")).toBe("app_store");
    expect(managedByForProvider("google")).toBe("play_store");
  });
});

describe("PLANNER_POI_CATEGORIES", () => {
  it("keeps the persisted planner category contract exhaustive", () => {
    expect(PLANNER_POI_CATEGORIES).toEqual([
      "fuel",
      "food",
      "cafe",
      "viewpoint",
      "campground",
      "biker_hotel",
      "mountain_pass",
      "twisty_highlight",
    ]);
    const category: PlannerPoiCategory = "twisty_highlight";
    expect(PLANNER_POI_CATEGORIES).toContain(category);
  });
});

describe("QUALITY_SOURCES", () => {
  it("lists the three OSM signals in precedence order and never 'reading'", () => {
    expect(QUALITY_SOURCES).toEqual([
      "osm_smoothness",
      "osm_surface",
      "osm_highway",
    ]);
    expect(QUALITY_SOURCES as readonly string[]).not.toContain("reading");
  });

  it("QualitySource is the union of the tuple", () => {
    const s: QualitySource = "osm_surface";
    expect(QUALITY_SOURCES).toContain(s);
  });
});

describe("grant plan sources", () => {
  it("is a strict subset of PLAN_SOURCES", () => {
    // A source that exists in one list and not the other is the drift this
    // pairing exists to prevent.
    for (const source of GRANT_PLAN_SOURCES) {
      expect(PLAN_SOURCES).toContain(source);
    }
    expect(GRANT_PLAN_SOURCES).not.toContain("subscription");
  });

  it("treats NULL as billed, not granted", () => {
    // `PLAN_SOURCES` documents null as "indistinguishable from `subscription`",
    // so a row predating the column is a legacy PAID rider. Classifying it as a
    // grant would make every one of them un-cancellable.
    expect(isGrantPlanSource(null)).toBe(false);
    expect(isGrantPlanSource(undefined)).toBe(false);
    expect(isGrantPlanSource("subscription")).toBe(false);
  });

  it("recognises every grant source", () => {
    expect(isGrantPlanSource("founder")).toBe(true);
    expect(isGrantPlanSource("promo")).toBe(true);
    expect(isGrantPlanSource("admin")).toBe(true);
  });
});

describe("higherTier", () => {
  it("returns the higher of two tiers", () => {
    expect(higherTier("free", "pro")).toBe("pro");
    expect(higherTier("pro", "free")).toBe("pro");
    expect(higherTier("pro", "premium")).toBe("premium");
    expect(higherTier("premium", "pro")).toBe("premium");
  });

  it("is symmetric and idempotent", () => {
    for (const a of SUBSCRIPTION_TIERS) {
      for (const b of SUBSCRIPTION_TIERS) {
        expect(higherTier(a, b)).toBe(higherTier(b, a));
      }
      expect(higherTier(a, a)).toBe(a);
    }
  });

  it("treats an absent tier as no entitlement, not as a winner", () => {
    // A rider with no grant must not be capped, and a rider with no
    // subscription must keep their grant.
    expect(higherTier(null, "premium")).toBe("premium");
    expect(higherTier("pro", undefined)).toBe("pro");
    expect(higherTier(null, null)).toBe("free");
  });

  it("ranks an unrecognised tier BELOW free — fails closed", () => {
    // This sits on the entitlement read path. An unknown value must not
    // out-rank a real tier, and must not throw.
    expect(higherTier("nonsense" as never, "free")).toBe("free");
    expect(higherTier("nonsense" as never, "premium")).toBe("premium");
    expect(higherTier("nonsense" as never, null)).toBe("free");
  });
});
