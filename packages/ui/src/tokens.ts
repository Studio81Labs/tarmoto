/**
 * JS mirror of the design tokens in `styles/tokens.css`.
 * Use these for inline-style components (SVG fills, framer-motion, etc.)
 * where CSS variables aren't ergonomic.
 *
 * Spec: tarmoto/project/Web App v2 Design Map.html · section 01–06.
 */

export const palette = {
  cream: "#F5EFE6",
  paper: "#EDE6DA",
  paper2: "#E5DBCB",
  ink: "#0E0E10",
  tarmac: "#2B2C30",
  accent: "#FF6A1A",
  accentHot: "#FF7A30",
} as const;

/** Warm → green road-quality ramp (always five stops, always in order). */
export const qualityColors = [
  "#E05A3C", // q1 · avoid
  "#F0A03C", // q2 · rough
  "#E8D66A", // q3 · ok
  "#C7D36A", // q4 · great
  "#6FD38A", // q5 · hero
] as const;

export type QualityTier = 1 | 2 | 3 | 4 | 5;

export const qualityLabel = {
  1: "Avoid",
  2: "Rough",
  3: "OK",
  4: "Great",
  5: "Hero",
} as const satisfies Record<QualityTier, string>;

export const fonts = {
  sans: "'Space Grotesk', system-ui, -apple-system, Helvetica, sans-serif",
  mono: "'JetBrains Mono', 'SFMono-Regular', Menlo, monospace",
  serif: "'Fraunces', Georgia, serif",
} as const;

export const radii = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 14,
  xl: 20,
  device: 38,
  pill: 999,
} as const;

/** Clamp + round any number into a valid quality tier (1–5). */
export function clampQuality(q: number): QualityTier {
  return Math.max(1, Math.min(5, Math.round(q))) as QualityTier;
}
