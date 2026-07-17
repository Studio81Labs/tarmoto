import {
  DRIVABLE_HIGHWAYS,
  ROAD_TAGS_FILTER_EXPRESSIONS,
  resolveRoadRefreshConfig,
} from "./index.js";

describe("road tag filter", () => {
  it("is one w/highway= expression covering every drivable class (importer superset)", () => {
    expect(ROAD_TAGS_FILTER_EXPRESSIONS).toHaveLength(1);
    const expr = ROAD_TAGS_FILTER_EXPRESSIONS[0]!;
    expect(expr.startsWith("w/highway=")).toBe(true);
    for (const hw of DRIVABLE_HIGHWAYS) {
      expect(expr).toContain(hw);
    }
    // ways only — roads are ways, not nodes/relations (unlike the POI nwr/ filter)
    expect(expr.startsWith("nwr/")).toBe(false);
  });
});

describe("resolveRoadRefreshConfig", () => {
  it("reads the road env (enabled gate, shared dir + regions)", () => {
    const cfg = resolveRoadRefreshConfig({
      TARMOTO_OSM_ROAD_REFRESH_ENABLED: "true",
      TARMOTO_OSM_ROAD_IMPORT_DIR: "/data/road-extracts",
      TARMOTO_OSM_ROAD_IMPORT_REGIONS: "CZ,SK",
    } as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
    expect(cfg.targetDir).toBe("/data/road-extracts");
    expect(cfg.regions.map((r) => r.code)).toEqual(["CZ", "SK"]);
  });

  it("defaults off, null dir, all regions when unset", () => {
    const cfg = resolveRoadRefreshConfig({} as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(false);
    expect(cfg.targetDir).toBeNull();
    expect(cfg.regions.length).toBeGreaterThan(1);
  });

  it("throws on an unknown region code (no silent drop)", () => {
    expect(() =>
      resolveRoadRefreshConfig({
        TARMOTO_OSM_ROAD_IMPORT_REGIONS: "CZ,ZZ",
      } as NodeJS.ProcessEnv),
    ).toThrow(/ZZ/);
  });
});
