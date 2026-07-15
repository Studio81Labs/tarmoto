import { QUALITY_SOURCES, type QualitySource } from "./constants";

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
