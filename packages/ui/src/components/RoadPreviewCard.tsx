import { cn } from "../utils/cn";
import { QualityBars } from "../atoms/QualityBars";
import { qualityColors, clampQuality, type QualityTier } from "../tokens";

/**
 * RoadPreviewCard · the signature trip-planner row. Spec: §13.
 * Anatomy: index chip + name + QualityBars on top, an elevation profile
 * with a quality-coloured ribbon, and a mono meta strip below.
 *
 * Active state inverts the card to ink fill. A non-zero `hazards`
 * count appends an accent warning to the meta row.
 */
export interface RoadPreviewSegment {
  q: QualityTier | number;
}

export interface RoadPreviewCardProps {
  index: number | string;
  name: string;
  /** Headline quality for the QualityBars in the corner (1–5). */
  quality: QualityTier | number;
  /** Per-sub-segment quality colours for the strip below the elevation. */
  segments: ReadonlyArray<RoadPreviewSegment>;
  /** Normalised 0–1 elevation samples (head → tail). */
  elevation: ReadonlyArray<number>;
  distanceKm: number;
  elevationGainM: number;
  turns: number;
  hazards?: number;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}

function buildElevationPath(samples: ReadonlyArray<number>): string {
  if (samples.length === 0) return "";
  const w = 200;
  const h = 50;
  const stepX = w / Math.max(1, samples.length - 1);
  const points = samples.map((v, i) => {
    const x = i * stepX;
    const y = h - Math.max(0, Math.min(1, v)) * h;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return `M ${points.join(" L ")} L ${w} 60 L 0 60 Z`;
}

export function RoadPreviewCard({
  index,
  name,
  quality,
  segments,
  elevation,
  distanceKm,
  elevationGainM,
  turns,
  hazards = 0,
  active = false,
  onClick,
  className,
}: RoadPreviewCardProps) {
  const tier = clampQuality(quality);
  const fill = qualityColors[tier - 1];
  const elevPath = buildElevationPath(elevation);
  const Component = onClick ? "button" : "div";

  return (
    <Component
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-2.5 rounded-[14px] border p-3.5 text-left font-sans",
        "transition-colors duration-100",
        active
          ? "bg-ink border-ink text-cream"
          : "bg-cream border-line text-ink",
        onClick && "cursor-pointer",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className={cn(
              "grid size-[22px] place-items-center rounded-md font-mono text-[11px] font-bold shrink-0",
              active ? "bg-cream/15 text-cream" : "bg-paper text-ink",
            )}
          >
            {index}
          </div>
          <div className="truncate text-sm font-bold">{name}</div>
        </div>
        <QualityBars q={tier} size={4} onDark={active} />
      </div>

      <div
        className={cn(
          "relative h-[52px] overflow-hidden rounded-lg",
          active ? "bg-cream/8" : "bg-paper",
        )}
      >
        <svg
          viewBox="0 0 200 60"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
          aria-hidden="true"
        >
          {elevPath && (
            <path
              d={elevPath}
              fill={fill}
              fillOpacity={0.35}
              stroke={fill}
              strokeWidth={1.2}
            />
          )}
          {segments.map((seg, i) => {
            const w = 200 / Math.max(1, segments.length);
            const segTier = clampQuality(seg.q);
            return (
              <rect
                key={i}
                x={i * w}
                y={54}
                width={w}
                height={6}
                fill={qualityColors[segTier - 1]}
              />
            );
          })}
        </svg>
      </div>

      <div
        className={cn(
          "flex flex-wrap justify-between gap-2 font-mono text-[11px]",
          active ? "text-fg-on-dark-dim" : "text-fg-dim",
        )}
      >
        <span>{distanceKm} KM</span>
        <span>
          {elevationGainM >= 0 ? "↗" : "↘"} {Math.abs(elevationGainM)}M
        </span>
        <span>{turns} TURNS</span>
        {hazards > 0 && <span className="text-accent">⚠ {hazards}</span>}
      </div>
    </Component>
  );
}
