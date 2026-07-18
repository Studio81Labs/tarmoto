import { t } from "@/i18n";
import { buildSparklinePath, profileExtrema } from "@/lib/segment-preview";
import type { Formatters } from "@tarmoto/shared";
interface Props {
  profile: number[] | null;
  /** Elevation formatter — honours the rider's metric/imperial preference. */
  format: Formatters;
  width?: number;
  height?: number;
  stroke?: string;
  className?: string;
}
/**
 * Renders a minimal elevation sparkline. Returns null when the profile is
 * absent or too short to plot, so callers can use it unconditionally.
 *
 * `stroke` defaults to the canonical accent (#FF6A1A); min/max labels
 * render at the right edge in muted slate so the line stays the dominant
 * signal.
 */
export function ElevationSparkline({
  profile,
  format,
  width = 180,
  height = 40,
  stroke = "#FF6A1A",
  className,
}: Props) {
  if (!profile || profile.length < 2) return null;
  const d = buildSparklinePath(profile, width, height);
  const ext = profileExtrema(profile);
  if (!d || !ext) return null;
  const labelX = width - 2;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      aria-label={t("Elevation profile from {min} to {max}", {
        min: format.elevation(ext.min),
        max: format.elevation(ext.max),
      })}
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
        {Math.round(ext.max)}
        {t("m ")}
      </text>
      <text
        x={labelX}
        y={height - 2}
        fontSize={9}
        fill="#64748b"
        textAnchor="end"
        className="tabular-nums"
      >
        {Math.round(ext.min)}
        {t("m ")}
      </text>
    </svg>
  );
}
