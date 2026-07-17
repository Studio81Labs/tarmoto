"use client";
import { t } from "@/i18n";
import { useFormat } from "@/format/FormatProvider";
import { Skeleton } from "@tarmoto/ui";
import { useDiscoverStore } from "./useDiscoverStore";
import type { FunZoneListItem } from "@/lib/discover";
interface Props {
  zones: FunZoneListItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}
/**
 * Left sidebar listing Fun Zones in the effective bbox (viewport or drawn
 * region), ranked by composite_score. Hover echoes to the map; click
 * selects the zone and opens the detail panel.
 */
export function ZoneListPanel({ zones, loading, error, onRetry }: Props) {
  const format = useFormat();
  const { drawnBbox, selectedZoneId, setSelectedZoneId } = useDiscoverStore();
  return (
    <aside className="w-[300px] border-r border-line bg-paper overflow-y-auto flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-line">
        <div>
          <h2 className="text-sm font-semibold text-ink">{t("Fun Zones")}</h2>
          <p className="text-xs text-fg-dim">
            {loading
              ? "Loading…"
              : `${zones.length} in ${drawnBbox ? "drawn region" : "view"}`}
          </p>
        </div>
        {drawnBbox ? (
          <span className="text-[10px] uppercase tracking-wider text-accent bg-accent/10 px-2 py-0.5 rounded">
            {t("Drawn ")}
          </span>
        ) : (
          <span className="text-[10px] uppercase tracking-wider text-fg-dim">
            {t("Viewport ")}
          </span>
        )}
      </header>

      {error ? (
        <div className="p-4 text-sm text-fg-dim">
          <p className="mb-2">{t("Couldn't load zones.")}</p>
          <button
            type="button"
            onClick={onRetry}
            className="text-accent hover:underline"
          >
            {t("Retry ")}
          </button>
        </div>
      ) : loading && zones.length === 0 ? (
        <div className="p-4 space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-[10px]" />
          ))}
        </div>
      ) : zones.length === 0 ? (
        <div className="p-4 text-sm text-fg-dim">
          {drawnBbox
            ? "No Fun Zones in drawn region — try a larger area or clear."
            : "No Fun Zones in view yet — zoom out or drag the map."}
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {zones.map((zone, i) => {
            const active = zone.id === selectedZoneId;
            return (
              <li key={zone.id}>
                <button
                  type="button"
                  onClick={() => setSelectedZoneId(zone.id)}
                  className={`w-full text-left px-4 py-3 transition flex gap-3 items-start ${
                    active
                      ? "bg-paper-2 border-l-2 border-accent"
                      : "hover:bg-paper-2/60 border-l-2 border-transparent"
                  }`}
                >
                  <span className="flex-shrink-0 mt-0.5 w-7 h-7 rounded-full bg-accent/10 text-accent text-xs font-semibold flex items-center justify-center tabular-nums">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-ink truncate">
                        {zone.name ?? fallbackName(zone)}
                      </h3>
                      <span className="text-xs tabular-nums text-accent flex-shrink-0">
                        {format.decimal(zone.composite_score, 1)}
                      </span>
                    </div>
                    <p className="text-xs text-fg-dim mt-1">
                      {zone.road_count}
                      {t("roads ")}
                      {zone.total_curve_km != null
                        ? ` · ${format.distanceKm(zone.total_curve_km)} curves`
                        : ""}
                      {zone.avg_quality != null
                        ? ` · avg ${format.decimal(zone.avg_quality, 1)}★`
                        : ""}
                    </p>
                    {zone.best_season ? (
                      <p className="text-[10px] text-fg-dim mt-0.5">
                        {zone.best_season}
                      </p>
                    ) : null}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
function fallbackName(zone: FunZoneListItem): string {
  // Use the polygon centroid as a rough placeholder name when the zone has
  // no human label yet. The `boundary` is a closed ring; averaging its
  // vertices is a cheap centroid approximation.
  const points = zone.boundary as unknown as Array<{
    lat: number;
    lng: number;
  }>;
  if (points.length === 0) return "Unnamed zone";
  const lat =
    points.reduce((sum: number, point) => sum + point.lat, 0) / points.length;
  const lng =
    points.reduce((sum: number, point) => sum + point.lng, 0) / points.length;
  return `Zone near ${lat.toFixed(2)}, ${lng.toFixed(2)}`;
}
