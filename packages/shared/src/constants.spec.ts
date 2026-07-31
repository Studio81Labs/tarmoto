import {
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
