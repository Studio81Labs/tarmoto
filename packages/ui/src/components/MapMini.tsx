import { cn } from "../utils/cn";
import { palette, qualityColors } from "../tokens";

/**
 * MapMini · paper/light/dark vignette used in the Map Modes preview.
 * Renders a tiny SVG scene with contours, a road base, the quality
 * ribbon, two waypoints, and an optional hazard pin. Spec: §18 Map
 * modes.
 *
 * This is a documentation primitive — the real map is MapLibre + vector
 * tiles. The MapMini intentionally re-uses the same vocabulary so the
 * legend in the design map shows identical visual semantics.
 */
export type MapMiniMode = "paper" | "light" | "dark";

export interface MapMiniProps {
  mode?: MapMiniMode;
  showHazard?: boolean;
  className?: string;
}

const bgFor: Record<MapMiniMode, string> = {
  paper: palette.paper,
  light: palette.cream,
  dark: "#17181C",
};

const contourStrokeFor: Record<MapMiniMode, string> = {
  paper: "rgba(14,14,16,0.08)",
  light: "rgba(14,14,16,0.05)",
  dark: "rgba(255,255,255,0.06)",
};

const roadBaseFor: Record<MapMiniMode, string> = {
  paper: "#C4BBA8",
  light: "#C4BBA8",
  dark: "#1E1F23",
};

export function MapMini({
  mode = "paper",
  showHazard = true,
  className,
}: MapMiniProps) {
  const contours = mode === "light" ? [40, 90, 140] : [40, 70, 100, 130, 160];
  const ringFill = mode === "dark" ? palette.cream : palette.cream;
  return (
    <div
      className={cn(
        "relative aspect-[16/10] overflow-hidden rounded-[12px] border border-line",
        className,
      )}
      style={{ background: bgFor[mode] }}
    >
      <svg
        viewBox="0 0 320 200"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 size-full"
        aria-hidden="true"
      >
        <g stroke={contourStrokeFor[mode]} strokeWidth="1" fill="none">
          {contours.map((y) => (
            <path
              key={y}
              d={`M -10 ${y} C 80 ${y - 10}, 160 ${y + 10}, 320 ${y - 10}`}
            />
          ))}
        </g>
        <path
          d="M 20 150 C 90 130, 140 100, 200 70 S 290 60, 310 80"
          stroke={roadBaseFor[mode]}
          strokeWidth="4"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 20 150 C 90 130, 140 100, 200 70"
          stroke={qualityColors[4]}
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
        <circle
          cx="20"
          cy="150"
          r="9"
          fill={palette.ink}
          stroke={ringFill}
          strokeWidth="2"
        />
        <circle
          cx="200"
          cy="70"
          r="9"
          fill={palette.ink}
          stroke={ringFill}
          strokeWidth="2"
        />
        {showHazard && (
          <circle
            cx="125"
            cy="90"
            r="7"
            fill={palette.accent}
            stroke={ringFill}
            strokeWidth="1.5"
          />
        )}
      </svg>
    </div>
  );
}
