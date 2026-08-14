"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  fetchFunZoneDetail,
  funZoneSeasonLabel,
  type FunZoneDetail,
  type FunZoneListItem,
} from "@/lib/discover";
import { ElevationSparkline } from "@/components/map/ElevationSparkline";
import { Skeleton } from "@tarmoto/ui";
import { useFormat } from "@/format/FormatProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { surfaceTypeLabel } from "@/lib/utils";

interface Props {
  /** Zone whose detail is open; null renders nothing. */
  zoneId: string | null;
  /** Matching list item so the header can render immediately from the list
   *  cache, while the detail fetch resolves the top-roads section. */
  summary: FunZoneListItem | null;
  onClose: () => void;
}

/**
 * Right-docked drawer for a clicked Fun Zone: zone header, stat strip, and
 * ranked top-roads list with per-road elevation sparklines. Carried over
 * from the retired /discover page's ZoneDetailPanel, restyled for the
 * cream explorer and driven by props instead of the discover store.
 */
export function FunZonePanel({ zoneId, summary, onClose }: Props) {
  const t = useTranslation();
  const format = useFormat();
  // Read the kill HERE rather than take it as a prop: this panel is the only
  // consumer, and a prop is one more thing a caller has to remember. Must sit
  // with the other hooks — there is an early return below. The zone itself is
  // a curviness discovery feature (composite score: 40% curviness, 25%
  // quality, 15% elevation, 15% road count), so the switch removes the quality
  // READOUTS, not the zone.
  const { enabled: qualityEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const [detail, setDetail] = useState<FunZoneDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!zoneId) {
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
        const d = await fetchFunZoneDetail(zoneId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (d == null) {
          // 404 — the zone disappeared between list and detail fetch. Close
          // the panel quietly and let the overlay reconcile on next fetch.
          onClose();
          return;
        }
        setDetail(d);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setError(t("Couldn't load zone details."));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // onClose is a stable inline setter wrapper from the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, zoneId]);
  if (!zoneId) return null;
  const zone = detail?.zone ?? summary;
  const topRoads: FunZoneDetail["top_roads"] = detail?.top_roads ?? [];
  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 flex w-[360px] max-w-full flex-col border-l border-line bg-paper shadow-[-6px_0_16px_rgba(14,14,16,0.08)] animate-slide-in-right"
      aria-label={t("Fun Zone details")}
    >
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-ink">
            {zone?.name ?? t("Unnamed zone")}
          </h2>
          <p className="mt-0.5 text-xs tabular-nums text-fg-dim">
            {zone?.best_season
              ? t("Score {score} · {season}", {
                  score:
                    zone.composite_score != null
                      ? format.decimal(zone.composite_score, 1)
                      : "—",
                  season: t(funZoneSeasonLabel(zone.best_season)),
                })
              : t("Score {score}", {
                  score:
                    zone?.composite_score != null
                      ? format.decimal(zone.composite_score, 1)
                      : "—",
                })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close zone details")}
          className="text-fg-dim transition hover:text-ink"
        >
          <X size={18} />
        </button>
      </header>

      {zone ? (
        <div className="grid grid-cols-3 gap-3 border-b border-line px-4 py-3 text-center">
          <Stat label={t("Roads")} value={format.integer(zone.road_count)} />
          <Stat
            label={t("Curve {unit}", { unit: format.splitDistanceKm(1).unit })}
            value={
              zone.total_curve_km != null
                ? format.splitDistanceKm(zone.total_curve_km).value
                : "—"
            }
          />
          {/* Omitted whole under the kill: an em dash beside a "Quality" label
              still tells the visitor a figure exists and is withheld. */}
          {qualityEnabled ? (
            <Stat
              label={t("Quality")}
              value={
                zone.avg_quality != null
                  ? format.decimal(zone.avg_quality, 1)
                  : "—"
              }
            />
          ) : null}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="p-4 text-sm text-fg-dim">
            <p className="mb-2">{error}</p>
          </div>
        ) : loading && topRoads.length === 0 ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full rounded-[10px]" />
            ))}
          </div>
        ) : topRoads.length === 0 ? (
          <div className="p-4 text-sm text-fg-dim">
            {t("No contributing roads available yet.")}
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {topRoads.map((road: FunZoneDetail["top_roads"][number]) => (
              <li key={road.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium text-ink">
                      {road.road_name ?? t("Unnamed road")}
                      {road.road_number ? ` — ${road.road_number}` : ""}
                    </h3>
                    <p className="text-xs tabular-nums text-fg-dim">
                      {qualityEnabled && road.quality_score != null
                        ? `★ ${format.decimal(road.quality_score, 1)} · `
                        : ""}
                      {t("curviness {score}", {
                        score: format.decimal(road.curviness_score, 1),
                      })}{" "}
                      · {format.distanceKm(road.length_m / 1000)} ·{" "}
                      {t(surfaceTypeLabel(road.surface_type))}
                    </p>
                  </div>
                </div>
                {road.elevation_profile ? (
                  <div className="mt-2">
                    <ElevationSparkline
                      profile={road.elevation_profile}
                      format={format}
                    />
                  </div>
                ) : (
                  <p className="mt-2 text-[10px] text-fg-dim">
                    {t("No elevation data")}
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
      <div className="text-lg font-semibold tabular-nums text-ink">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-fg-dim">
        {label}
      </div>
    </div>
  );
}
