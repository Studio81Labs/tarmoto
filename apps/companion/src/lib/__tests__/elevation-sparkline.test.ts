import { describe, expect, it } from "vitest";
import { buildSparklinePath } from "../elevation-sparkline";

describe("buildSparklinePath", () => {
  it("maps a simple ascending profile onto the canvas", () => {
    // width 100, height 40. Profile [0, 50, 100] means:
    // - x step = 100 / (3-1) = 50
    // - y mapping: min=0 → y=40, max=100 → y=0
    // Points: (0,40), (50,20), (100,0)
    const result = buildSparklinePath([0, 50, 100], 100, 40);

    expect(result.d).toBe("M0,40 L50,20 L100,0");
    expect(result.min).toBe(0);
    expect(result.max).toBe(100);
  });

  it("returns empty d and NaN min/max for < 2 points", () => {
    expect(buildSparklinePath([], 100, 40)).toEqual({
      d: "",
      min: Number.NaN,
      max: Number.NaN,
    });
    expect(buildSparklinePath([42], 100, 40)).toEqual({
      d: "",
      min: Number.NaN,
      max: Number.NaN,
    });
  });

  it("flattens to a horizontal mid-line when all values are equal", () => {
    // min === max → avoid divide-by-zero. Line sits at height/2.
    const result = buildSparklinePath([5, 5, 5, 5], 60, 20);
    expect(result.d).toBe("M0,10 L20,10 L40,10 L60,10");
    expect(result.min).toBe(5);
    expect(result.max).toBe(5);
  });
});
