import { qualityProvenanceLabel } from "../index";

describe("qualityProvenanceLabel", () => {
  it("labels an OSM estimate when no rider has reported", () => {
    expect(qualityProvenanceLabel("osm_smoothness", 0)).toBe(
      "Estimated from surveyed smoothness",
    );
    expect(qualityProvenanceLabel("osm_surface", 0)).toBe(
      "Estimated from road surface",
    );
    expect(qualityProvenanceLabel("osm_highway", 0)).toBe(
      "Estimated from road type",
    );
  });
  it("returns null once riders have contributed (verified by data)", () => {
    expect(qualityProvenanceLabel("osm_highway", 3)).toBeNull();
  });
  it("returns null when there is no source", () => {
    expect(qualityProvenanceLabel(null, 0)).toBeNull();
  });
});
