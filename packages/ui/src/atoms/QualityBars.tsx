import { cn } from "../utils/cn";
import { qualityColors, clampQuality, type QualityTier } from "../tokens";

/**
 * Five-bar quality glyph (Tarmoto's signature). Spec: §10.
 *
 * Rules:
 *  - Always five bars
 *  - Filled bars all share the q-stop colour (not a gradient)
 *  - Unfilled = ink @ 8% (light) or cream @ 12% (`onDark`)
 *  - Gap is always 2 px · radius 1.5 · height = size × 2.2
 */
export interface QualityBarsProps {
  q: QualityTier | number;
  /** Width of a single bar in px. Height is computed at `size * 2.2`. */
  size?: number;
  onDark?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function QualityBars({
  q,
  size = 5,
  onDark = false,
  className,
  ariaLabel,
}: QualityBarsProps) {
  const tier = clampQuality(q);
  const fill = qualityColors[tier - 1];
  const empty = onDark ? "rgba(245,239,230,0.12)" : "rgba(14,14,16,0.08)";
  return (
    <span
      role="img"
      aria-label={ariaLabel ?? `Quality ${tier} of 5`}
      className={cn("inline-flex items-end gap-[2px]", className)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          aria-hidden="true"
          style={{
            width: size,
            height: size * 2.2,
            borderRadius: 1.5,
            background: n <= tier ? fill : empty,
            display: "inline-block",
          }}
        />
      ))}
    </span>
  );
}
