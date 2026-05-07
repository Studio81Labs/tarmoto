"use client";
import { t } from "@/i18n";
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
  const { drawnBbox, selectedZoneId, setSelectedZoneId } = useDiscoverStore();
  return (
    <aside className="w-[300px] border-r border-slate-800 bg-slate-950 overflow-y-auto flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div>
          <h2 className="text-sm font-semibold text-white">{t("Fun Zones")}</h2>
          <p className="text-xs text-slate-400">
            {loading
              ? "Loading…"
              : `${zones.length} in ${drawnBbox ? "drawn region" : "view"}`}
          </p>
        </div>
        {drawnBbox ? (
          <span className="text-[10px] uppercase tracking-wider text-tarmoto-cyan bg-tarmoto-cyan/10 px-2 py-0.5 rounded">
            {t("Drawn ")}
          </span>
        ) : (
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            {t("Viewport ")}
          </span>
        )}
      </header>

      {error ? (
        <div className="p-4 text-sm text-slate-300">
          <p className="mb-2">{t("Couldn't load zones.")}</p>
          <button
            type="button"
            onClick={onRetry}
            className="text-tarmoto-cyan hover:underline"
          >
            {t("Retry ")}
          </button>
        </div>
      ) : loading && zones.length === 0 ? (
        <div className="p-4 space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 rounded bg-slate-900 border border-slate-800 animate-pulse"
            />
          ))}
        </div>
      ) : zones.length === 0 ? (
        <div className="p-4 text-sm text-slate-400">
          {drawnBbox
            ? "No Fun Zones in drawn region — try a larger area or clear."
            : "No Fun Zones in view yet — zoom out or drag the map."}
        </div>
      ) : (
        <ul className="divide-y divide-slate-800">
          {zones.map((zone, i) => {
            const active = zone.id === selectedZoneId;
            return (
              <li key={zone.id}>
                <button
                  type="button"
                  onClick={() => setSelectedZoneId(zone.id)}
                  className={`w-full text-left px-4 py-3 transition flex gap-3 items-start ${
                    active
                      ? "bg-slate-900 border-l-2 border-tarmoto-cyan"
                      : "hover:bg-slate-900/60 border-l-2 border-transparent"
                  }`}
                >
                  <span className="flex-shrink-0 mt-0.5 w-7 h-7 rounded-full bg-tarmoto-cyan/10 text-tarmoto-cyan text-xs font-semibold flex items-center justify-center tabular-nums">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-white truncate">
                        {zone.name ?? fallbackName(zone)}
                      </h3>
                      <span className="text-xs tabular-nums text-tarmoto-cyan flex-shrink-0">
                        {zone.composite_score.toFixed(1)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      {zone.road_count}
                      {t("roads ")}
                      {zone.total_curve_km != null
                        ? ` · ${Math.round(zone.total_curve_km)} km curves`
                        : ""}
                      {zone.avg_quality != null
                        ? ` · avg ${zone.avg_quality.toFixed(1)}★`
                        : ""}
                    </p>
                    {zone.best_season ? (
                      <p className="text-[10px] text-slate-500 mt-0.5">
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
