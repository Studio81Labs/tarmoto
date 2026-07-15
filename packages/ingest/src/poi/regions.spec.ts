import { DEFAULT_REGIONS, parseRegions } from "./regions.js";

describe("DEFAULT_REGIONS", () => {
  it("is the full 17-region coverage list", () => {
    expect(DEFAULT_REGIONS).toHaveLength(17);
  });

  it("every region carries a valid ISO-2 code and a non-degenerate bbox", () => {
    for (const { code, bbox } of DEFAULT_REGIONS) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(bbox.maxLng - bbox.minLng).toBeGreaterThan(0);
      expect(bbox.maxLat - bbox.minLat).toBeGreaterThan(0);
    }
  });
});

describe("parseRegions", () => {
  const ENV = "TARMOTO_POI_IMPORT_REGIONS";

  it("returns the full list for undefined or blank input", () => {
    expect(parseRegions(undefined, ENV)).toHaveLength(17);
    expect(parseRegions("   ", ENV)).toHaveLength(17);
  });

  it("narrows to the selected codes — upper-cased, trimmed, deduped, in order", () => {
    const r = parseRegions("sk, cz , CZ", ENV);
    expect(r.map((x) => x.code)).toEqual(["SK", "CZ"]);
    // bbox comes from the authoritative default, not the input
    expect(r[0]?.bbox).toEqual(
      DEFAULT_REGIONS.find((x) => x.code === "SK")?.bbox,
    );
  });

  it("throws on an unknown code, naming the env var", () => {
    expect(() => parseRegions("CZ,ZZ", ENV)).toThrow(
      /Invalid TARMOTO_POI_IMPORT_REGIONS: unknown region "ZZ"/,
    );
  });
});
