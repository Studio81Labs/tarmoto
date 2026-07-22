import { buildRoutePreviewFromLines, type RoutePoint } from "@/lib/ride-detail";
import { useFormat } from "@/format/FormatProvider";
import { useTranslation } from "@/i18n/I18nProvider";

/**
 * Raw route overview for a trip: the simplified route drawn on a card plus a
 * "distance · days · region" totals line. Deliberately minimal — it is shown
 * where the full trip must stay private (the anonymous public share and the
 * pre-accept invite preview), so it never renders per-day waypoints or the
 * member roster.
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
  /** Accessible label for the route SVG (e.g. the trip title). */
  label: string;
}

export function TripRouteOverview({
  lines,
  distanceKm,
  dayCount,
  region,
  label,
}: TripRouteOverviewProps) {
  const t = useTranslation();
  const format = useFormat();
  const preview = buildRoutePreviewFromLines(lines, 960, 14);

  const stats = [
    distanceKm != null ? format.distanceKm(distanceKm) : null,
    t("{count, plural, one {# day} other {# days}}", { count: dayCount }),
    region || null,
  ].filter((s): s is string => Boolean(s));

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-paper p-4">
      {preview ? (
        <svg
          viewBox={preview.viewBox}
          role="img"
          aria-label={t("{label} route preview", { label })}
          className="h-auto w-full rounded-2xl bg-cream"
        >
          <path
            d={preview.path}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <p className="py-8 text-center text-sm text-fg-dim">
          {t("No route preview available for this trip.")}
        </p>
      )}
      {stats.length > 0 && (
        <p className="mt-3 text-center text-sm font-semibold tracking-wide text-ink">
          {stats.join(" · ")}
        </p>
      )}
    </div>
  );
}
