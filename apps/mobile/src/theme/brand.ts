/**
 * Tarmoto brand design-system tokens (mobile).
 *
 * Canonical reference: `docs/design/mobile-spec/source/` — the frozen
 * Claude Design handoff. Tokens mirror `colors_and_type.css` and the
 * `mobile/tokens.jsx` resolver from that bundle.
 *
 * This module is **additive**. The legacy `@/theme` palette (cyan-on-dark)
 * still backs every screen that has not yet been migrated. New brand
 * surfaces import from here; per-screen phases move screens across one at a
 * time so the migration never flips all ~40 screens at once. See
 * `docs/design/mobile-spec/README.md` for the phase plan.
 *
 * The handoff explored three "looks" (Atlas / Onyx / Rally). Production
 * ships **Atlas** — the canonical cream + ink brand. The night palette is
 * kept because immersive surfaces (ride mode, welcome hero) are always dark.
 */

/**
 * Road-quality colour ramp, Q1 (avoid) → Q5 (hero). Indexed by
 * `score - 1`. Matches `--q1..--q5` in `colors_and_type.css` and the `QC`
 * array in `mobile/tokens.jsx`.
 */
export const QUALITY_COLORS = [
  "#E05A3C", // q1 · avoid
  "#F0A03C", // q2 · rough
  "#E8D66A", // q3 · fair
  "#C7D36A", // q4 · great
  "#6FD38A", // q5 · hero
] as const;

/** Short, rider-facing quality labels (Q1 → Q5). */
export const QUALITY_LABELS = [
  "Avoid",
  "Rough",
  "Fair",
  "Great",
  "Hero",
] as const;

/** Formal quality labels (Q1 → Q5), used where prose tone fits better. */
export const QUALITY_FULL_LABELS = [
  "Very poor",
  "Poor",
  "Fair",
  "Good",
  "Excellent",
] as const;

/** The single brand accent. Used sparingly (<5% of pixels). */
export const ACCENT = "#FF6A1A";

/**
 * Deepened accent for small graphical fills on the cream sunken track.
 *
 * The raw `ACCENT` (#FF6A1A) is tuned for ink/cream surfaces but only reaches
 * ~2.1:1 against the `sunken` (#E7DECF) progress track — below the 3:1 WCAG
 * non-text contrast floor for graphical objects. This burnt-orange keeps the
 * "active" accent read while clearing 3:1 against `sunken`. Use it for accent
 * fills painted on the cream sunken surface (e.g. the active download bar),
 * not for the broad accent surfaces that already pass on ink/cream.
 */
export const ACCENT_DARK = "#C2410C";

/**
 * Type families. These are the *intended* families; the `.ttf` assets are
 * not bundled yet, so until the font-linking follow-up lands, text falls
 * back to the platform sans/mono and relies on `weight` for emphasis.
 * Referencing an unregistered family is safe on both platforms (graceful
 * fallback). See the README's Phase 1 note.
 */
export const brandFonts = {
  sans: "SpaceGrotesk",
  mono: "JetBrainsMono",
  /** Emotional marketing beats only — not used in product UI. */
  serif: "Fraunces",
} as const;

/** Numeric weights, mirroring the design's Space Grotesk usage. */
export const brandFontWeight = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  extrabold: "800",
} as const;

/** Light (Atlas) surface palette — `colors_and_type.css` + tokens.jsx light. */
export const brandColorsLight = {
  bg: "#F5EFE6",
  raised: "#FFFFFF",
  raised2: "#EDE6DA",
  sunken: "#E7DECF",
  fg: "#0E0E10",
  dim: "rgba(14,14,16,0.60)",
  mute: "rgba(14,14,16,0.42)",
  faint: "rgba(14,14,16,0.20)",
  line: "rgba(14,14,16,0.10)",
  lineStrong: "rgba(14,14,16,0.16)",
  invBg: "#0E0E10",
  invFg: "#F5EFE6",
  invDim: "rgba(245,239,230,0.62)",
  invLine: "rgba(245,239,230,0.14)",
  qEmpty: "rgba(14,14,16,0.08)",
  accent: ACCENT,
} as const;

/** Night palette — for immersive dark surfaces (ride mode, welcome hero). */
export const brandColorsDark = {
  bg: "#111216",
  raised: "#1B1D23",
  raised2: "#23262D",
  sunken: "#0B0C0F",
  fg: "#F3EEE6",
  dim: "rgba(243,238,230,0.62)",
  mute: "rgba(243,238,230,0.42)",
  faint: "rgba(243,238,230,0.22)",
  line: "rgba(243,238,230,0.10)",
  lineStrong: "rgba(243,238,230,0.18)",
  invBg: "#F3EEE6",
  invFg: "#0E0E10",
  invDim: "rgba(14,14,16,0.60)",
  invLine: "rgba(14,14,16,0.12)",
  qEmpty: "rgba(243,238,230,0.10)",
  accent: ACCENT,
} as const;

/**
 * Structural palette type. Both `brandColorsLight` and `brandColorsDark`
 * are declared `as const`, so their literal string types differ; widening
 * the values to `string` here lets `brandPalette()` return either.
 */
export type BrandPalette = Record<keyof typeof brandColorsLight, string>;

/** Resolve the brand palette for a theme. Defaults to light (Atlas). */
export function brandPalette(theme: "light" | "dark" = "light"): BrandPalette {
  return theme === "dark" ? brandColorsDark : brandColorsLight;
}

/** Radii for the production Atlas look (`persona.atlas` in tokens.jsx). */
export const brandRadii = {
  sm: 12,
  md: 18,
  lg: 24,
  pill: 999,
} as const;

/** 4pt spacing grid, from `colors_and_type.css` (`--sp-*`). */
export const brandSpacing = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s8: 32,
  s10: 40,
  s12: 48,
} as const;

/**
 * Neutral tone for roads with no scored quality data yet — a road the crowd
 * hasn't measured is NOT a bad road. Matches the intent of the legacy
 * `qualityColor(null)` -> tertiary grey, kept theme-agnostic like the Q ramp.
 */
export const UNSCORED_COLOR = "#9C968C";

/** Label for roads with no scored quality data yet. */
export const UNSCORED_LABEL = "Unscored";

/**
 * Accessible semantic status foreground colours for status **text and icons**
 * on the light brand surfaces (cream / white `Card`).
 *
 * The quality ramp (`QUALITY_COLORS`) is tuned as a *fill* colour for maps and
 * bars; on a white surface its greens/ambers fall well below WCAG AA for text
 * (Q5 green ~1.9:1, Q2 amber ~2.1:1). Status messaging uses these darker,
 * brand-sympathetic shades instead — each clears AA (≥4.5:1) for normal text
 * on both `#FFFFFF` and the `raised2` cream. Keep the ramp for quality visuals.
 */
export const statusFg = {
  success: "#136B3A",
  warning: "#8A5300",
  danger: "#B3261E",
} as const;

/**
 * Off-state track for the brand `Toggle`. The design's light overlay
 * (`rgba(14,14,16,0.16)`) is only ~1.4:1 on a white card and against the
 * white knob, so an off switch can visually vanish. These are mid-grey
 * tracks that clear the 3:1 non-text-control contrast against both the
 * surface and the knob, per theme.
 */
export const TOGGLE_OFF_TRACK = {
  light: "#808080",
  dark: "rgba(243,238,230,0.45)",
} as const;

/**
 * Clamp a known quality score to a 1–5 ramp index (0-based). Scores are
 * rounded to the nearest integer bucket, then clamped to `[0, 4]` so the
 * index is always a valid `QUALITY_COLORS` / label position.
 *
 * This is the ramp primitive for scores that exist. No-data (`null` /
 * non-finite) collapses to the bottom here; callers that distinguish
 * "unscored" from "worst" must use `qualityBrandColor` / `qualityBrandLabel`,
 * which short-circuit to the unscored state before indexing.
 */
export function qualityIndex(score: number | null | undefined): number {
  if (score == null || !Number.isFinite(score)) return 0;
  const bucket = Math.round(score);
  return Math.max(0, Math.min(4, bucket - 1));
}

/**
 * Brand quality colour for a 1–5 score (rounds to the nearest bucket).
 * Missing data (`null` / non-finite) returns the neutral unscored tone, not
 * Q1 — so unmeasured roads don't read as "Avoid".
 */
export function qualityBrandColor(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return UNSCORED_COLOR;
  return QUALITY_COLORS[qualityIndex(score)];
}

/**
 * Short brand quality label for a 1–5 score. Missing data (`null` /
 * non-finite) returns `Unscored`, not the Q1 label.
 */
export function qualityBrandLabel(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return UNSCORED_LABEL;
  return QUALITY_LABELS[qualityIndex(score)];
}
