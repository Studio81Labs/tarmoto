import {
  DEV_MAP_STYLE_URL,
  QUALITY_STEP_BREAKS,
  getQualityTileUrlTemplate,
  qualityLineStyle,
} from "../MapScreen.helpers";
import { colors } from "@/theme";

describe("getQualityTileUrlTemplate", () => {
  it("appends the MVT tile path to the given api base", () => {
    expect(getQualityTileUrlTemplate("http://localhost:3000/v1")).toBe(
      "http://localhost:3000/v1/roads/tiles/{z}/{x}/{y}.mvt?layers=quality",
    );
    expect(getQualityTileUrlTemplate("https://api.tarmoto.app/v1")).toBe(
      "https://api.tarmoto.app/v1/roads/tiles/{z}/{x}/{y}.mvt?layers=quality",
    );
  });

  it("keeps xyz placeholders unsubstituted so MapLibre can fill them", () => {
    const template = getQualityTileUrlTemplate("http://localhost:3000/v1");
    expect(template).toContain("{z}");
    expect(template).toContain("{x}");
    expect(template).toContain("{y}");
  });

  it("requests only the quality MVT layer (hazards/surface are separate features)", () => {
    expect(getQualityTileUrlTemplate("http://localhost:3000/v1")).toContain(
      "layers=quality",
    );
  });
});

describe("qualityLineStyle", () => {
  it("uses theme quality colours in ascending-score order", () => {
    // step: default, t1, c1, t2, c2, t3, c3, t4, c4
    const expr = qualityLineStyle.lineColor as unknown as unknown[];
    expect(expr[0]).toBe("step");
    expect(expr[2]).toBe(colors.quality.veryPoor);
    expect(expr[3]).toBe(QUALITY_STEP_BREAKS[0]);
    expect(expr[4]).toBe(colors.quality.poor);
    expect(expr[5]).toBe(QUALITY_STEP_BREAKS[1]);
    expect(expr[6]).toBe(colors.quality.fair);
    expect(expr[7]).toBe(QUALITY_STEP_BREAKS[2]);
    expect(expr[8]).toBe(colors.quality.good);
    expect(expr[9]).toBe(QUALITY_STEP_BREAKS[3]);
    expect(expr[10]).toBe(colors.quality.excellent);
  });

  it("reads quality_score from the vector-tile feature", () => {
    const expr = qualityLineStyle.lineColor as unknown as unknown[];
    expect(expr[1]).toEqual(["get", "quality_score"]);
  });

  it("keeps step thresholds sorted and matching theme half-point buckets", () => {
    // theme.qualityColor() bucketing: ≥4.5 excellent, ≥3.5 good, ≥2.5 fair,
    // ≥1.5 poor, else very poor. The step expression fires the color for a
    // threshold when `quality_score >= threshold`, so the same breaks apply.
    expect(QUALITY_STEP_BREAKS).toEqual([1.5, 2.5, 3.5, 4.5]);
    const sorted = [...QUALITY_STEP_BREAKS].sort((a, b) => a - b);
    expect(sorted).toEqual([...QUALITY_STEP_BREAKS]);
  });

  it("scales line width with zoom so roads stay visible at every level", () => {
    const expr = qualityLineStyle.lineWidth as unknown as unknown[];
    expect(expr[0]).toBe("interpolate");
    expect(expr[2]).toEqual(["zoom"]);
    // At country zoom roads are thin; at street zoom they're thick.
    // Pair layout: [..., stop1, w1, stop2, w2, ...]
    const widthAt8 = expr[4] as number;
    const widthAt20 = expr[10] as number;
    expect(widthAt20).toBeGreaterThan(widthAt8);
  });

  it("fades segments with low confidence via lineOpacity (0-100 scale per backend DTO)", () => {
    const expr = qualityLineStyle.lineOpacity as unknown as unknown[];
    expect(expr[0]).toBe("interpolate");
    expect(expr[2]).toEqual(["get", "confidence"]);
    // Backend serves confidence as an int 0-100 ("0-100, based on number of
    // readings" — see road-segment.dto.ts). Stops must match that range.
    const [, , , lowerStop, opacityAtLow, upperStop, opacityAtHigh] = expr as [
      string,
      unknown,
      unknown,
      number,
      number,
      number,
      number,
    ];
    expect(lowerStop).toBe(0);
    expect(upperStop).toBe(100);
    expect(opacityAtLow).toBeLessThan(opacityAtHigh);
    expect(opacityAtHigh).toBe(1);
  });
});

describe("DEV_MAP_STYLE_URL", () => {
  it("uses the MapLibre public demotiles style until a Tarmoto basemap ships", () => {
    expect(DEV_MAP_STYLE_URL).toMatch(/^https:\/\/demotiles\.maplibre\.org\//);
  });
});
