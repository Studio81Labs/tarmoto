import {
  PLANNER_POI_CATEGORIES,
  QUALITY_SOURCES,
  type PlannerPoiCategory,
  type QualitySource,
} from "./constants";

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
