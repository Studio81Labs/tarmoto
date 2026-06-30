import { cn } from "../utils/cn";
import { palette, qualityColors } from "../tokens";

/**
 * RouteMini · canonical hand-drawn route preview. From design `atoms.jsx`.
 *
 * Topo contours + quality-segmented road ribbon, with optional hazard
 * pulse and animated rider position. Used in trip-card thumbnails and
 * share previews where a real map render is too heavy.
 */
export interface RouteMiniProps {
  /** 0–1 along the route. 0 hides the rider. */
  progress?: number;
  showHazard?: boolean;
  dark?: boolean;
  tall?: boolean;
  className?: string;
}

const SAMPLES: Array<[number, number]> = [
  [8, 150],
  [60, 142],
  [100, 128],
  [140, 120],
  [185, 100],
  [220, 88],
  [260, 72],
  [310, 55],
  [372, 30],
];

export function RouteMini({
  progress = 0,
  showHazard = false,
  dark = false,
  tall = false,
  className,
}: RouteMiniProps) {
  const bg = dark ? "#17181C" : palette.paper;
  const topoStroke = dark ? "rgba(255,255,255,0.08)" : "rgba(14,14,16,0.08)";
  const roadBase = dark ? "#1A1B1E" : "#C4BBA8";

  const rider = (() => {
    if (progress <= 0) return null;
    const t = Math.max(0, Math.min(1, progress));
    const i = Math.min(
      SAMPLES.length - 2,
      Math.floor(t * (SAMPLES.length - 1)),
    );
    const f = t * (SAMPLES.length - 1) - i;
    const from = SAMPLES[i];
    const to = SAMPLES[i + 1];
    if (!from || !to) return null;
    const [x0, y0] = from;
    const [x1, y1] = to;
    return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f };
  })();

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-[18px]",
        className,
      )}
      style={{ height: tall ? 180 : 120, background: bg }}
    >
      <svg
        viewBox="0 0 380 180"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 size-full"
        aria-hidden="true"
      >
        {[40, 70, 100, 130].map((y) => (
          <path
            key={y}
            d={`M -10 ${y} C 60 ${y - 10}, 140 ${y + 15}, 220 ${y - 5} S 340 ${y + 8}, 400 ${y - 5}`}
            stroke={topoStroke}
            strokeWidth="1"
            fill="none"
          />
        ))}
        <path
          d="M 8 150 C 60 140, 100 120, 140 130 S 220 80, 270 70 S 340 40, 372 30"
          stroke={roadBase}
          strokeWidth="10"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 8 150 C 40 145, 70 130, 100 128"
          stroke={qualityColors[4]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 100 128 C 130 125, 160 110, 185 100"
          stroke={qualityColors[3]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 185 100 C 210 90, 235 75, 260 72"
          stroke={qualityColors[1]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 260 72 C 290 68, 320 50, 372 30"
          stroke={qualityColors[4]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        {showHazard && (
          <g transform="translate(222 86)">
            <circle r="10" fill={palette.accent} opacity="0.3">
              <animate
                attributeName="r"
                values="6;14;6"
                dur="1.6s"
                repeatCount="indefinite"
              />
            </circle>
            <circle r="6" fill={palette.accent} />
          </g>
        )}
        <circle cx="8" cy="150" r="7" fill={palette.accent} />
        <circle cx="8" cy="150" r="3" fill={palette.ink} />
        <circle cx="372" cy="30" r="7" fill={palette.ink} />
        <circle cx="372" cy="30" r="3" fill={palette.cream} />
        {rider && (
          <g transform={`translate(${rider.x} ${rider.y})`}>
            <circle r="12" fill={palette.accent} opacity="0.25" />
            <circle
              r="6"
              fill={palette.accent}
              stroke={dark ? palette.ink : palette.cream}
              strokeWidth="1.5"
            />
          </g>
        )}
      </svg>
    </div>
  );
}
