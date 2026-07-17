import { fsqPoiImportConfig, osmPoiImportConfig } from "./poi-import.config.js";
import { DEFAULT_REGIONS } from "@tarmoto/ingest";

describe("osmPoiImportConfig", () => {
  const ENABLED = "TARMOTO_OSM_POI_IMPORT_ENABLED";
  const DIR = "TARMOTO_OSM_POI_IMPORT_DIR";
  const REGIONS = "TARMOTO_OSM_POI_IMPORT_REGIONS";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [ENABLED, DIR, REGIONS]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of [ENABLED, DIR, REGIONS]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("defaults to disabled, no extract dir, and the full 17-region coverage list", () => {
    const cfg = osmPoiImportConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.extractDir).toBeNull();
    expect(cfg.regions).toHaveLength(17);
    expect(cfg.regions.map((r) => r.code)).toEqual(
      DEFAULT_REGIONS.map((r) => r.code),
    );
  });

  it("reads the enabled flag and the extract dir", () => {
    process.env[ENABLED] = "true";
    process.env[DIR] = "/data/poi-extracts";
    const cfg = osmPoiImportConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.extractDir).toBe("/data/poi-extracts");
  });

  it("narrows the coverage list to the selected regions, in order, deduped", () => {
    process.env[REGIONS] = "sk, cz , CZ";
    const cfg = osmPoiImportConfig();
    expect(cfg.regions.map((r) => r.code)).toEqual(["SK", "CZ"]);
    // The bbox comes from the authoritative default, not the env.
    expect(cfg.regions[0]?.bbox).toEqual(
      DEFAULT_REGIONS.find((r) => r.code === "SK")?.bbox,
    );
  });

  it("falls back to the full list when the region list is blank", () => {
    process.env[REGIONS] = "  ";
    expect(osmPoiImportConfig().regions).toHaveLength(17);
  });

  it("throws on an unknown region code instead of silently skipping it", () => {
    process.env[REGIONS] = "CZ,ZZ";
    expect(() => osmPoiImportConfig()).toThrow(
      /Invalid TARMOTO_OSM_POI_IMPORT_REGIONS: unknown region "ZZ"/,
    );
  });
});

describe("fsqPoiImportConfig", () => {
  const ENABLED = "TARMOTO_FSQ_POI_IMPORT_ENABLED";
  const DIR = "TARMOTO_FSQ_POI_IMPORT_DIR";
  const REGIONS = "TARMOTO_FSQ_POI_IMPORT_REGIONS";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [ENABLED, DIR, REGIONS]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of [ENABLED, DIR, REGIONS]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("reads its own FSQ env vars (disabled by default, shared region model)", () => {
    expect(fsqPoiImportConfig().enabled).toBe(false);
    expect(fsqPoiImportConfig().extractDir).toBeNull();
    process.env[ENABLED] = "true";
    process.env[DIR] = "/data/fsq-extracts";
    process.env[REGIONS] = "CZ";
    const cfg = fsqPoiImportConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.extractDir).toBe("/data/fsq-extracts");
    expect(cfg.regions.map((r) => r.code)).toEqual(["CZ"]);
  });

  it("is independent of the OSM import flag", () => {
    process.env.TARMOTO_OSM_POI_IMPORT_ENABLED = "true";
    try {
      expect(fsqPoiImportConfig().enabled).toBe(false);
    } finally {
      delete process.env.TARMOTO_OSM_POI_IMPORT_ENABLED;
    }
  });

  it("names the FSQ var when a region code is unknown", () => {
    process.env[REGIONS] = "CZ,ZZ";
    expect(() => fsqPoiImportConfig()).toThrow(
      /Invalid TARMOTO_FSQ_POI_IMPORT_REGIONS: unknown region "ZZ"/,
    );
  });
});
