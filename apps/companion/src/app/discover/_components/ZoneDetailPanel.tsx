"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  fetchFunZoneDetail,
  type FunZoneDetail,
  type FunZoneListItem,
} from "@/lib/discover";
import { ElevationSparkline } from "@/components/map/ElevationSparkline";
import { Skeleton } from "@tarmoto/ui";
import { useFormat } from "@/format/FormatProvider";
import { useDiscoverStore } from "./useDiscoverStore";
interface Props {
  /** Matching list item so the header can render immediately from the list
   *  cache, while the detail fetch resolves the top-roads section. */
  summary: FunZoneListItem | null;
}
/**
 * Right-side panel: zone header, stat strip, and ranked top-roads list with
 * per-road elevation sparklines. Driven by useDiscoverStore.selectedZoneId.
 */
export function ZoneDetailPanel({ summary }: Props) {
  const format = useFormat();
  const { selectedZoneId, setSelectedZoneId } = useDiscoverStore();
  const [detail, setDetail] = useState<FunZoneDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedZoneId) {
      setDetail(null);
      setError(null);
      return;
    }
    // Clear the prior zone's detail so the panel falls back to the list
    // summary (name + score) for the new zone while we refetch, instead
    // of briefly showing the previous zone's top roads and stats.
    setDetail(null);
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    (async () => {
      try {
        const d = await fetchFunZoneDetail(selectedZoneId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (d == null) {
          // 404 — the zone disappeared between list and detail fetch. Close
          // the panel quietly and let the list state reconcile on next poll.
          setSelectedZoneId(null);
          return;
        }
        setDetail(d);
      } catch (err) {
        if (
          (
            err as {
              name?: string;
            }
          ).name === "AbortError"
        )
          return;
        setError("Couldn't load zone details.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // setSelectedZoneId is stable from Zustand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedZoneId]);
  if (!selectedZoneId) return null;
  const zone = detail?.zone ?? summary;
  const topRoads: FunZoneDetail["top_roads"] = detail?.top_roads ?? [];
  return (
    <aside className="w-[360px] border-l border-line bg-paper flex flex-col animate-slide-in-right">
      <header className="flex items-start justify-between px-4 py-3 border-b border-line gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink truncate">
            {zone?.name ?? "Unnamed zone"}
          </h2>
          <p className="text-xs text-fg-dim mt-0.5 tabular-nums">
            {t("Score ")}
            {zone?.composite_score != null
              ? format.decimal(zone.composite_score, 1)
              : "—"}
            {zone?.best_season ? ` · ${zone.best_season}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSelectedZoneId(null)}
          aria-label={t("Close zone details")}
          className="text-fg-dim hover:text-ink transition"
        >
          <X size={18} />
        </button>
      </header>

      {zone ? (
        <div className="grid grid-cols-3 gap-3 px-4 py-3 border-b border-line text-center">
          <Stat label="Roads" value={String(zone.road_count)} />
          <Stat
            label={`Curve ${format.splitDistanceKm(1).unit}`}
            value={
              zone.total_curve_km != null
                ? format.splitDistanceKm(zone.total_curve_km).value
                : "—"
            }
          />
          <Stat
            label="Quality"
            value={
              zone.avg_quality != null
                ? format.decimal(zone.avg_quality, 1)
                : "—"
            }
          />
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="p-4 text-sm text-fg-dim">
            <p className="mb-2">{error}</p>
          </div>
        ) : loading && topRoads.length === 0 ? (
          <div className="p-4 space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full rounded-[10px]" />
            ))}
          </div>
        ) : topRoads.length === 0 ? (
          <div className="p-4 text-sm text-fg-dim">
            {t("No contributing roads available yet. ")}
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {topRoads.map((road: FunZoneDetail["top_roads"][number]) => (
              <li key={road.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium text-ink truncate">
                      {road.road_name ?? "Unnamed road"}
                      {road.road_number ? ` — ${road.road_number}` : ""}
                    </h3>
                    <p className="text-xs text-fg-dim tabular-nums">
                      {road.quality_score != null
                        ? `★ ${format.decimal(road.quality_score, 1)} · `
                        : ""}
                      {t("curviness ")}
                      {format.decimal(road.curviness_score, 1)} ·{" "}
                      {format.distanceKm(road.length_m / 1000)} ·{" "}
                      {road.surface_type}
                    </p>
                  </div>
                </div>
                {road.elevation_profile ? (
                  <div className="mt-2">
                    <ElevationSparkline profile={road.elevation_profile} />
                  </div>
                ) : (
                  <p className="text-[10px] text-fg-dim mt-2">
                    {t("No elevation data ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-lg font-semibold text-ink tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-fg-dim">
        {label}
      </div>
    </div>
  );
}
