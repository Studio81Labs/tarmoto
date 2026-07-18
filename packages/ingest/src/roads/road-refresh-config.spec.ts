import { DEFAULT_REGIONS } from "../poi/regions.js";
import {
  DRIVABLE_HIGHWAYS,
  ROAD_TAGS_FILTER_EXPRESSIONS,
  TILE_MAX_SPAN_DEG_DEFAULT,
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
  it("reads the road env (enabled gate, shared dir + regions + tile span)", () => {
    const cfg = resolveRoadRefreshConfig({
      TARMOTO_OSM_ROAD_REFRESH_ENABLED: "true",
      TARMOTO_OSM_ROAD_IMPORT_DIR: "/data/road-extracts",
      TARMOTO_OSM_ROAD_IMPORT_REGIONS: "CZ,SK",
      TARMOTO_OSM_ROAD_TILE_SPAN_DEG: "1.5",
    } as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
    expect(cfg.targetDir).toBe("/data/road-extracts");
    expect(cfg.regions.map((r) => r.code)).toEqual(["CZ", "SK"]);
    expect(cfg.tileSpanDeg).toBe(1.5);
  });

  it("defaults off, null dir, all regions, default tile span when unset", () => {
    const cfg = resolveRoadRefreshConfig({} as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(false);
    expect(cfg.targetDir).toBeNull();
    expect(cfg.regions.length).toBe(DEFAULT_REGIONS.length);
    expect(cfg.tileSpanDeg).toBe(TILE_MAX_SPAN_DEG_DEFAULT);
  });

  it("throws on an unknown region code (no silent drop)", () => {
    expect(() =>
      resolveRoadRefreshConfig({
        TARMOTO_OSM_ROAD_IMPORT_REGIONS: "CZ,ZZ",
      } as NodeJS.ProcessEnv),
    ).toThrow(/ZZ/);
  });

  it("throws on an invalid tile span (no silent producer/importer desync)", () => {
    expect(() =>
      resolveRoadRefreshConfig({
        TARMOTO_OSM_ROAD_TILE_SPAN_DEG: "0",
      } as NodeJS.ProcessEnv),
    ).toThrow(/TARMOTO_OSM_ROAD_TILE_SPAN_DEG/);
  });
});
