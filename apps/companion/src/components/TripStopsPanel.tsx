"use client";
import { t } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { Loader2, ZoomIn } from "lucide-react";
import { Select } from "@tarmoto/ui";
import {
  POI_CATEGORY_META,
  poiCategoryMeta,
} from "@/components/planner/MapToolbar";
import { plannerApi } from "@/lib/planner/api";
import type { RouteStop } from "@/lib/planner/types";
import type { Trip } from "@/lib/types";
import { useTripStore } from "@/stores/trip";

const CORRIDOR_OPTIONS = [5, 10, 20] as const;
/** Route-change re-queries are debounced; filter changes apply fast. */
const ROUTE_REQUERY_DEBOUNCE_MS = 400;

interface TripStopsPanelProps {
  trip: Trip | null;
  /**
   * Row click = the SAME interaction as clicking the POI's map pin:
   * fly to it and open the Add-as-via popover (revision 5 §D).
   */
  onFocusStop?: (stop: RouteStop) => void;
}

/**
 * STOPS tab (revision 5): a route-wide corridor view over the SAME POIs
 * and the SAME `activePoiCategories` filters as the map's category bar —
 * different spatial lens (proximity to the route line instead of the
 * viewport), never a second filter state. Route-gated: without a route
 * line there is nothing to be "along".
 */
export function TripStopsPanel({ trip, onFocusStop }: TripStopsPanelProps) {
  const activePoiCategories = useTripStore((s) => s.activePoiCategories);
  const togglePoiCategory = useTripStore((s) => s.togglePoiCategory);
  const [corridorKm, setCorridorKm] = useState<number>(5);
  const [minStayRating, setMinStayRating] = useState<number | undefined>(
    undefined,
  );
  const [stops, setStops] = useState<RouteStop[]>([]);
  const [loading, setLoading] = useState(false);

  // ROUTE-WIDE line: concatenate every day's geometry in order, so a
  // split multi-day trip still reads as one corridor (§B).
  const routeLine = useMemo(() => {
    const coordinates =
      trip?.days.flatMap((day) => day.routeGeometry?.coordinates ?? []) ?? [];
    if (coordinates.length < 2) return null;
    return { type: "LineString", coordinates } as GeoJSON.LineString;
  }, [trip]);

  const categories = useMemo(
    () => [...activePoiCategories],
    [activePoiCategories],
  );

  useEffect(() => {
    if (!routeLine || categories.length === 0) {
      setStops([]);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await plannerApi.getRouteStops(
          routeLine,
          categories,
          corridorKm,
          minStayRating,
          { signal: controller.signal },
        );
        if (!cancelled) setStops(result);
      } catch (err) {
        if ((err as { name?: string }).name !== "AbortError") {
          console.warn("[planner] route stops fetch failed", err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, ROUTE_REQUERY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [routeLine, categories, corridorKm, minStayRating]);

  const activeLabels = categories
    .map((category) => poiCategoryMeta(category).label.toLowerCase())
    .join(", ");

  return (
    <div className="space-y-5 pt-2">
      {/* §01 POI CATEGORIES — the SHARED set; toggling syncs the map bar. */}
      <div>
        <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] font-bold">
          <span className="tracking-[1px] text-accent">§ 01</span>
          <span className="tracking-[1.4px] text-fg-mute">
            {t("POI CATEGORIES")}
          </span>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-fg-dim">
          {t(
            "Same filters as the map's category bar. Here they're ranked by distance from your route line. ",
          )}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {POI_CATEGORY_META.map(({ category, label, icon: Icon }) => {
            const active = activePoiCategories.has(category);
            const tarmotoDerived =
              category === "mountain_pass" || category === "twisty_highlight";
            return (
              <button
                key={category}
                type="button"
                aria-pressed={active}
                onClick={() => togglePoiCategory(category)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[12px] font-bold transition ${
                  active
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-line-strong bg-transparent text-fg-dim hover:border-ink hover:text-ink"
                }`}
              >
                <Icon size={13} />
                {t(label)}
                <span
                  aria-hidden="true"
                  title={tarmotoDerived ? "Tarmoto data" : "OpenStreetMap"}
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    tarmotoDerived
                      ? "bg-accent"
                      : "border border-line-strong bg-transparent"
                  }`}
                />
              </button>
            );
          })}
        </div>
        <div className="mt-2.5 flex gap-4">
          <span className="flex items-center gap-1.5 font-mono text-[9px] text-fg-mute">
            <span className="h-1.5 w-1.5 rounded-full border border-line-strong" />
            {t("OSM")}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[9px] text-fg-mute">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {t("TARMOTO-DERIVED")}
          </span>
        </div>
      </div>

      {/* Corridor selector (§D) — drives the proximity filter. */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim">
            {t("Corridor from route")}
          </span>
          <span className="font-mono text-[10px] text-fg-mute">
            {t("WITHIN {km} KM", { km: corridorKm })}
          </span>
        </div>
        <div className="flex gap-1.5">
          {CORRIDOR_OPTIONS.map((km) => (
            <button
              key={km}
              type="button"
              aria-pressed={corridorKm === km}
              onClick={() => setCorridorKm(km)}
              className={`flex-1 rounded-[9px] border py-2 text-center text-[12.5px] font-bold transition ${
                corridorKm === km
                  ? "border-ink bg-ink text-cream"
                  : "border-line bg-cream text-fg-dim hover:border-line-strong"
              }`}
            >
              {t("{km} km", { km })}
            </button>
          ))}
        </div>
      </div>

      {/* Minimum stay rating — accommodation categories only (§D). */}
      <div>
        <label
          htmlFor="trip-stops-rating"
          className="mb-1 block text-xs text-fg-mute"
        >
          {t("Minimum stay rating ")}
          <span className="text-fg-faint">
            {t("(biker hotels & campgrounds)")}
          </span>
        </label>
        <Select
          id="trip-stops-rating"
          value={minStayRating ?? ""}
          onChange={(value) =>
            setMinStayRating(value ? Number(value) : undefined)
          }
          tone="cream"
        >
          <option value="">{t("Any")}</option>
          <option value="3">{t("3 stars or better")}</option>
          <option value="4">{t("4 stars or better")}</option>
          <option value="5">{t("5 stars only")}</option>
        </Select>
      </div>

      {/* §02 ALONG YOUR ROUTE — one flat route-wide list (§B), gated (§E). */}
      <div>
        <div className="mb-2.5 flex items-baseline justify-between">
          <div className="flex items-center gap-2 font-mono text-[10px] font-bold">
            <span className="tracking-[1px] text-accent">§ 02</span>
            <span className="tracking-[1.4px] text-fg-mute">
              {t("ALONG YOUR ROUTE")}
            </span>
          </div>
          {routeLine ? (
            <span className="font-mono text-[10px] text-fg-mute">
              {t("{count} STOPS", { count: stops.length })}
            </span>
          ) : null}
        </div>

        {!routeLine ? (
          <div className="rounded-[11px] border border-line bg-cream px-3.5 py-3">
            <p className="text-[12px] leading-relaxed text-fg-dim">
              {t(
                "Plan a route to see stops along it — the corridor needs a route line to measure from. The map's category pins work anytime. ",
              )}
            </p>
          </div>
        ) : categories.length === 0 ? (
          <div className="rounded-[11px] border border-line bg-cream px-3.5 py-3">
            <p className="text-[12px] leading-relaxed text-fg-dim">
              {t("Turn on a POI category above to see stops along the route. ")}
            </p>
          </div>
        ) : loading && stops.length === 0 ? (
          <div className="flex items-center gap-2.5 rounded-[11px] border border-line bg-cream px-3.5 py-3">
            <Loader2
              size={14}
              aria-hidden
              className="shrink-0 animate-spin text-fg-mute"
            />
            <p className="text-[12px] leading-relaxed text-fg-dim">
              {t("Measuring the corridor… ")}
            </p>
          </div>
        ) : stops.length === 0 ? (
          <div className="rounded-[11px] border border-line bg-cream px-3.5 py-3">
            <p className="text-[12px] leading-relaxed text-fg-dim">
              {t(
                "No {filters} stops within {km} km of your route — try a wider corridor. ",
                { filters: activeLabels, km: corridorKm },
              )}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {stops.map((stop) => {
              const meta = poiCategoryMeta(stop.category);
              const Icon = meta.icon;
              const tarmotoDerived = stop.source === "tarmoto";
              return (
                <button
                  key={stop.id}
                  type="button"
                  title={t("Zoom to & add as via")}
                  onClick={() => onFocusStop?.(stop)}
                  className="flex w-full items-center gap-2.5 rounded-[11px] border border-line bg-cream px-3 py-2.5 text-left transition hover:border-line-strong hover:bg-paper"
                >
                  <span
                    className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg ${
                      tarmotoDerived
                        ? "bg-accent text-cream"
                        : "border border-line bg-cream text-ink"
                    }`}
                  >
                    <Icon size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold text-ink">
                      {stop.name}
                    </span>
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.4px] text-fg-mute">
                      {`${meta.label} · ${
                        stop.distanceFromRouteKm < 0.1
                          ? t("on route")
                          : t("{km} km off", { km: stop.distanceFromRouteKm })
                      } · ${t("km {at}", { at: stop.kmAlongRoute })}`}
                    </span>
                  </span>
                  <ZoomIn size={15} className="shrink-0 text-fg-mute" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
