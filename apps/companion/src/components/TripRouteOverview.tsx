import { buildRoutePreviewFromLines, type RoutePoint } from "@/lib/ride-detail";
import { useFormat } from "@/format/FormatProvider";
import { t } from "@/i18n";

/**
 * Raw route overview for a trip: the simplified route drawn on a card plus a
 * "distance · days · region" totals line. Deliberately minimal — it is shown
 * where the full trip must stay private (the anonymous public share and the
 * pre-accept invite preview), so it never renders per-day waypoints or the
 * member roster.
 *
 * `variant` themes it for its host: `dark` for the public marketing-style
 * share page, `light` for the cream dashboard join view.
 */
export interface TripRouteOverviewProps {
  /**
   * Per-day route polylines ([lat,lng] points). Kept as separate lines rather
   * than one flattened list so the preview doesn't bridge non-adjacent days
   * with an artificial straight segment.
   */
  lines: ReadonlyArray<readonly RoutePoint[]>;
  distanceKm: number | null;
  dayCount: number;
  region?: string | null;
  variant?: "dark" | "light";
  /** Accessible label for the route SVG (e.g. the trip title). */
  label: string;
}

export function TripRouteOverview({
  lines,
  distanceKm,
  dayCount,
  region,
  variant = "light",
  label,
}: TripRouteOverviewProps) {
  const format = useFormat();
  const preview = buildRoutePreviewFromLines(lines, 960, 14);
  const dark = variant === "dark";

  const stats = [
    distanceKm != null ? format.distanceKm(distanceKm) : null,
    dayCount === 1 ? t("1 day") : t("{count} days", { count: dayCount }),
    region || null,
  ].filter((s): s is string => Boolean(s));

  const cardClass = dark
    ? "overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70 p-5"
    : "overflow-hidden rounded-2xl border border-line bg-paper p-4";
  const svgBgClass = dark
    ? "bg-[linear-gradient(180deg,_rgba(15,23,42,0.94),_rgba(2,6,23,1))]"
    : "bg-cream";
  const stroke = dark ? "#22d3ee" : "var(--color-accent)";
  const emptyTextClass = dark ? "text-slate-400" : "text-fg-dim";
  const statsClass = dark ? "text-slate-200" : "text-ink";

  return (
    <div className={cardClass}>
      {preview ? (
        <svg
          viewBox={preview.viewBox}
          role="img"
          aria-label={`${label} route preview`}
          className={`h-auto w-full rounded-2xl ${svgBgClass}`}
        >
          <path
            d={preview.path}
            fill="none"
            stroke={stroke}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <p className={`py-8 text-center text-sm ${emptyTextClass}`}>
          {t("No route preview available for this trip.")}
        </p>
      )}
      {stats.length > 0 && (
        <p
          className={`mt-3 text-center text-sm font-semibold tracking-wide ${statsClass}`}
        >
          {stats.join(" · ")}
        </p>
      )}
    </div>
  );
}
