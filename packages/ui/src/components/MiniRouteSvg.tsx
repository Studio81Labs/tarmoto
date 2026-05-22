import { useId } from "react";
import { palette, qualityColors } from "../tokens";

/**
 * MiniRouteSvg · the small, randomised route sketch used on trip-draft
 * cards. Spec: `v2-pages.jsx` MiniRouteSvg.
 *
 * Different from `<RouteMini>` (canonical hand-drawn route preview with
 * fixed multi-segment quality ribbon) — this one is intentionally
 * abstract and seed-randomised:
 *
 *  - paper noise via feTurbulence
 *  - 5 wavy topo paths (Y offset randomised per seed)
 *  - base-colored road under a single quality-colored overlay
 *  - 2 endpoint pins (ink start, accent end)
 *
 * Use for trip-card thumbnails in summary lists. `RouteMini` stays
 * appropriate for "real" route previews where the actual quality
 * ribbon matters.
 *
 * `seed` controls the randomisation so two cards rendered side by side
 * look visually distinct (matches the spec's per-card variation).
 */
export interface MiniRouteSvgProps {
  /** 1–5 quality stop; picks the overlay colour from `qualityColors`. */
  q?: 1 | 2 | 3 | 4 | 5;
  /** Override the accent endpoint pin colour (default = canonical accent). */
  accent?: string;
  /** Per-card variation seed. */
  seed?: number;
  className?: string;
}

const PAPER_FILL = palette.paper;
const ROAD_BASE = "#C4BBA8";
const INK = palette.ink;
const DEFAULT_ACCENT = palette.accent;

export function MiniRouteSvg({
  q = 3,
  accent = DEFAULT_ACCENT,
  seed = 0,
  className,
}: MiniRouteSvgProps) {
  // Per-instance ID so two MiniRouteSvgs on the same page don't collide
  // on `#mn-<seed>` filter references. Matches the per-instance gradient
  // pattern from FunZoneGlyph (codex P2 fix on PR #624).
  const filterId = `${useId()}-mn-${seed}`;
  const wig = (i: number) => Math.sin(i * 1.7 + seed) * 12;
  const overlayStroke = qualityColors[q - 1] ?? qualityColors[2];
  return (
    <svg
      viewBox="0 0 200 120"
      preserveAspectRatio="xMidYMid slice"
      className={className}
      style={{ width: "100%", height: "100%" }}
      aria-hidden="true"
    >
      <defs>
        <filter id={filterId}>
          <feTurbulence baseFrequency="0.9" numOctaves={2} seed={seed} />
          <feColorMatrix values="0 0 0 0 0.1  0 0 0 0 0.08  0 0 0 0 0.05  0 0 0 0.06 0" />
        </filter>
      </defs>
      <rect width={200} height={120} fill={PAPER_FILL} />
      <rect
        width={200}
        height={120}
        filter={`url(#${filterId})`}
        opacity={0.6}
      />
      <g stroke="rgba(14,14,16,0.10)" strokeWidth={1} fill="none">
        {[20, 40, 60, 80, 100].map((y) => (
          <path
            key={y}
            d={`M -10 ${y + wig(y)} C 50 ${y - 8 + wig(y + seed)}, 110 ${y + 10}, 210 ${y - 4 + wig(y * 0.5)}`}
          />
        ))}
      </g>
      <g stroke={ROAD_BASE} strokeWidth={2.5} fill="none" strokeLinecap="round">
        <path d="M 10 100 C 50 80, 90 70, 120 50 S 170 30, 195 20" />
      </g>
      <path
        d="M 10 100 C 50 80, 90 70, 120 50 S 170 30, 195 20"
        stroke={overlayStroke}
        strokeWidth={3}
        fill="none"
        strokeLinecap="round"
      />
      <circle cx={10} cy={100} r={4} fill={INK} />
      <circle
        cx={195}
        cy={20}
        r={4}
        fill={accent}
        stroke={INK}
        strokeWidth={1}
      />
    </svg>
  );
}
