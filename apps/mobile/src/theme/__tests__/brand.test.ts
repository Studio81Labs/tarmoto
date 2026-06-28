import {
  ACCENT,
  brandColorsDark,
  brandColorsLight,
  brandPalette,
  QUALITY_COLORS,
  QUALITY_FULL_LABELS,
  QUALITY_LABELS,
  qualityBrandColor,
  qualityBrandLabel,
  qualityIndex,
  UNSCORED_COLOR,
  UNSCORED_LABEL,
} from "../brand";

describe("brand quality ramp", () => {
  it("exposes a 5-stop ramp aligned with QUALITY_LABELS", () => {
    expect(QUALITY_COLORS).toHaveLength(5);
    expect(QUALITY_LABELS).toHaveLength(5);
    expect(QUALITY_FULL_LABELS).toHaveLength(5);
  });

  it("matches the canonical --q1..--q5 tokens byte-for-byte", () => {
    expect([...QUALITY_COLORS]).toEqual([
      "#E05A3C",
      "#F0A03C",
      "#E8D66A",
      "#C7D36A",
      "#6FD38A",
    ]);
  });
});

describe("qualityIndex", () => {
  it("maps each integer score to its 0-based ramp slot", () => {
    expect(qualityIndex(1)).toBe(0);
    expect(qualityIndex(3)).toBe(2);
    expect(qualityIndex(5)).toBe(4);
  });

  it("rounds fractional scores to the nearest bucket", () => {
    expect(qualityIndex(3.4)).toBe(2);
    expect(qualityIndex(3.6)).toBe(3);
  });

  it("clamps out-of-range and non-finite scores into [0, 4]", () => {
    expect(qualityIndex(0)).toBe(0);
    expect(qualityIndex(9)).toBe(4);
    expect(qualityIndex(-2)).toBe(0);
    expect(qualityIndex(NaN)).toBe(0);
    // Non-finite scores collapse to the bottom of the ramp, not the top.
    expect(qualityIndex(Infinity)).toBe(0);
    expect(qualityIndex(null)).toBe(0);
    expect(qualityIndex(undefined)).toBe(0);
  });
});

describe("qualityBrandColor / qualityBrandLabel", () => {
  it("returns the ramp colour for a score", () => {
    expect(qualityBrandColor(5)).toBe("#6FD38A");
    expect(qualityBrandColor(1)).toBe("#E05A3C");
  });

  it("returns the short label for a score", () => {
    expect(qualityBrandLabel(5)).toBe("Hero");
    expect(qualityBrandLabel(2)).toBe("Rough");
  });

  it("returns the unscored state for missing data, not the Q1 bucket", () => {
    // Missing data must not read as the worst road.
    expect(qualityBrandColor(null)).toBe(UNSCORED_COLOR);
    expect(qualityBrandColor(undefined)).toBe(UNSCORED_COLOR);
    expect(qualityBrandColor(NaN)).toBe(UNSCORED_COLOR);
    expect(qualityBrandColor(Infinity)).toBe(UNSCORED_COLOR);
    expect(qualityBrandLabel(null)).toBe(UNSCORED_LABEL);
    expect(qualityBrandLabel(undefined)).toBe(UNSCORED_LABEL);
    expect(UNSCORED_COLOR).not.toBe(QUALITY_COLORS[0]);
    expect(UNSCORED_LABEL).not.toBe(QUALITY_LABELS[0]);
  });
});

describe("brandPalette", () => {
  it("defaults to the light (Atlas) palette", () => {
    expect(brandPalette()).toBe(brandColorsLight);
    expect(brandPalette("light")).toBe(brandColorsLight);
  });

  it("returns the night palette for the dark theme", () => {
    expect(brandPalette("dark")).toBe(brandColorsDark);
  });

  it("keeps the single accent consistent across themes", () => {
    expect(brandColorsLight.accent).toBe(ACCENT);
    expect(brandColorsDark.accent).toBe(ACCENT);
  });
});
