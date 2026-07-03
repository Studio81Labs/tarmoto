import { describe, expect, it } from "vitest";
import { mockGeocode, mockReverseGeocode } from "../mocks/geocode";

describe("mockGeocode", () => {
  it("matches case- and diacritic-insensitively", () => {
    expect(mockGeocode("zdar")[0]?.name).toBe("Žďár nad Sázavou");
    expect(mockGeocode("SPLIT")[0]?.name).toBe("Split");
  });

  it("prefers prefix matches and caps at five results", () => {
    const results = mockGeocode("b");
    expect(results).toEqual([]); // 1 char — too short
    const brno = mockGeocode("br");
    expect(brno[0]?.name).toBe("Brno");
    expect(mockGeocode("a").length).toBe(0);
    expect(mockGeocode("e").length).toBe(0);
  });

  it("returns coordinates with every match", () => {
    const [praha] = mockGeocode("praha");
    expect(praha).toMatchObject({ name: "Praha" });
    expect(praha!.lat).toBeCloseTo(50.08, 1);
    expect(praha!.lng).toBeCloseTo(14.44, 1);
  });
});

describe("mockReverseGeocode", () => {
  it("names a pin in town by the town", () => {
    expect(mockReverseGeocode(49.3961, 15.5912)).toBe("Jihlava");
  });

  it("names a nearby pin as 'near <town>'", () => {
    // ~15 km east of Jihlava.
    expect(mockReverseGeocode(49.3961, 15.8)).toBe("near Jihlava");
  });

  it("falls back to coordinates when nothing is within range", () => {
    expect(mockReverseGeocode(0, 0)).toBe("0.000, 0.000");
  });
});
