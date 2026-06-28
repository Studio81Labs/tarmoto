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
  statusFg,
  TOGGLE_OFF_TRACK,
  UNSCORED_COLOR,
  UNSCORED_LABEL,
} from "../brand";

// WCAG relative-luminance contrast ratio between a hex colour and a hex bg.
function contrastRatio(fg: string, bg: string): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string): number => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const a = lum(fg);
  const b = lum(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

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

describe("statusFg", () => {
  // Status text/icons render on white cards and the cream raised2 surface;
  // both must clear WCAG AA for normal text so success/warning/danger
  // messaging is legible (the quality ramp does not — that's why these exist).
  it.each([
    ["success", statusFg.success],
    ["warning", statusFg.warning],
    ["danger", statusFg.danger],
  ])("%s clears AA (>=4.5:1) on white and raised2", (_name, color) => {
    expect(contrastRatio(color, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(color, brandColorsLight.raised2),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("the raw quality ramp would fail as foreground text on white", () => {
    // Guards the rationale: ramp greens/ambers are fill colours, not text.
    expect(contrastRatio(QUALITY_COLORS[4], "#FFFFFF")).toBeLessThan(4.5);
    expect(contrastRatio(QUALITY_COLORS[1], "#FFFFFF")).toBeLessThan(4.5);
  });
});

// Composite an `rgba(r,g,b,a)` string over an opaque hex background.
function flattenRgbaOverHex(rgba: string, bgHex: string): string {
  const m = rgba.match(/rgba?\(([^)]+)\)/);
  if (!m) return rgba;
  const [r, g, b, a = "1"] = m[1].split(",").map((s) => parseFloat(s.trim()));
  const bg = [1, 3, 5].map((i) => parseInt(bgHex.slice(i, i + 2), 16));
  const mix = [r, g, b].map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
  return "#" + mix.map((c) => c.toString(16).padStart(2, "0")).join("");
}

describe("control + heading contrast on the light card", () => {
  it("Toggle off-track clears 3:1 against the white card and knob", () => {
    // Non-text control contrast: the off switch must not vanish on white.
    expect(
      contrastRatio(TOGGLE_OFF_TRACK.light, "#FFFFFF"),
    ).toBeGreaterThanOrEqual(3);
  });

  it("the `dim` tone is legible for section-heading stamps on white", () => {
    // Settings uses `dim` (not the default muted eyebrow) for real headings.
    const dimOnWhite = flattenRgbaOverHex(brandColorsLight.dim, "#FFFFFF");
    expect(contrastRatio(dimOnWhite, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    // The default muted eyebrow tone would NOT pass as a heading — that's
    // why the override exists.
    const muteOnWhite = flattenRgbaOverHex(brandColorsLight.mute, "#FFFFFF");
    expect(contrastRatio(muteOnWhite, "#FFFFFF")).toBeLessThan(4.5);
  });
});
