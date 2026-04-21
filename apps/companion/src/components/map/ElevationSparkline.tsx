import { buildSparklinePath } from "@/lib/elevation-sparkline";

interface Props {
  profile: number[] | null;
  width?: number;
  height?: number;
  stroke?: string;
  className?: string;
}

/**
 * Renders a minimal elevation sparkline. Returns null when the profile is
 * absent or too short to plot, so callers can use it unconditionally.
 *
 * `stroke` defaults to the tarmoto-cyan brand color; min/max labels render
 * at the right edge in muted slate so the line stays the dominant signal.
 */
export function ElevationSparkline({
  profile,
  width = 180,
  height = 40,
  stroke = "#0ED3CF",
  className,
}: Props) {
  if (!profile || profile.length < 2) return null;
  const { d, min, max } = buildSparklinePath(profile, width, height);
  const labelX = width - 2;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      aria-label={`Elevation profile from ${Math.round(min)}m to ${Math.round(max)}m`}
    >
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x={labelX}
        y={10}
        fontSize={9}
        fill="#64748b"
        textAnchor="end"
        className="tabular-nums"
      >
        {Math.round(max)}m
      </text>
      <text
        x={labelX}
        y={height - 2}
        fontSize={9}
        fill="#64748b"
        textAnchor="end"
        className="tabular-nums"
      >
        {Math.round(min)}m
      </text>
    </svg>
  );
}
