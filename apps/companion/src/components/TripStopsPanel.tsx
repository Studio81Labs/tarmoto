"use client";

import { useI18n } from "@/i18n/I18nProvider";
import { useEffect, useMemo, useState } from "react";
import { Loader2, ZoomIn } from "lucide-react";
import { Select } from "@tarmoto/ui";
import {
  POI_CATEGORY_META,
  poiCategoryMeta,
} from "@/components/planner/MapToolbar";
import { readPoiDetails } from "@/components/planner/PoiDetails";
import { FSQ_BRAND_COLOR } from "@/components/map/attribution";
import { formatDisplayLowerCase, haversineKm } from "@tarmoto/shared";
import { plannerApi } from "@/lib/planner/api";
import { poiDisplayName } from "@/lib/planner/labels";
import type { RouteStop } from "@/lib/planner/types";
import type { Trip } from "@/lib/types";
import { useTripStore } from "@/stores/trip";
import { useFormat } from "@/format/FormatProvider";
import { LocalizedStyledValue } from "@/i18n/LocalizedStyledValue";

const CORRIDOR_OPTIONS = [5, 10, 20] as const;
/** Route-change re-queries are debounced; filter changes apply fast. */
const ROUTE_REQUERY_DEBOUNCE_MS = 400;

function lineLengthKm(line: GeoJSON.LineString): number {
  let km = 0;
  for (let i = 1; i < line.coordinates.length; i += 1) {
    const [lng1, lat1] = line.coordinates[i - 1] ?? [];
    const [lng2, lat2] = line.coordinates[i] ?? [];
    if (
      typeof lng1 === "number" &&
      typeof lat1 === "number" &&
      typeof lng2 === "number" &&
      typeof lat2 === "number"
    ) {
      km += haversineKm(lat1, lng1, lat2, lng2);
    }
  }
  return km;
}

interface TripStopsPanelProps {
  trip: Trip | null;
  /**
   * Row click = the SAME interaction as clicking the POI's map pin:
   * fly to it and open the Add-as-via popover (revision 5 §D).
   */
  onFocusStop?: (stop: RouteStop) => void;
  /**
   * Planner travel month (1–12) — sets the seasonal `mountain_pass` status so
   * STOPS agrees with the Conditions pass overlay; omit for the current month.
   */
  month?: number;
}

/**
 * STOPS tab (revision 5): a route-wide corridor view over the SAME POIs
 * and the SAME `activePoiCategories` filters as the map's category bar —
 * different spatial lens (proximity to the route line instead of the
 * viewport), never a second filter state. Route-gated: without a route
 * line there is nothing to be "along".
 */
export function TripStopsPanel({
  trip,
  onFocusStop,
  month,
}: TripStopsPanelProps) {
  const { locale, t } = useI18n();
  const format = useFormat();
  const activePoiCategories = useTripStore((s) => s.activePoiCategories);
  const togglePoiCategory = useTripStore((s) => s.togglePoiCategory);
  const [corridorKm, setCorridorKm] = useState<number>(5);
  const [minStayRating, setMinStayRating] = useState<number | undefined>(
    undefined,
  );
  const [stops, setStops] = useState<RouteStop[]>([]);
  const [loading, setLoading] = useState(false);

  // ROUTE-WIDE corridor (§B), split into chains of LINKED days: an
  // unlinked successor means the hop between day N's finish and day
  // N+1's start is not ridden, so concatenating across it would measure
  // the corridor along a road the rider never takes.
  const routeLines = useMemo(() => {
    const chains: GeoJSON.LineString[] = [];
    let current: GeoJSON.Position[] = [];
    const flush = () => {
      if (current.length >= 2)
        chains.push({ type: "LineString", coordinates: current });
      current = [];
    };
    for (const day of trip?.days ?? []) {
      if (!day.startLinked) flush();
      current = current.concat(day.routeGeometry?.coordinates ?? []);
    }
    flush();
    return chains;
  }, [trip]);

  const categories = useMemo(
    () => [...activePoiCategories],
    [activePoiCategories],
  );

  // Which bulk venue sources are present in the loaded stops (#869) — drives the
  // legend's Foursquare credit + the two-tone category dots. `passes`/`tarmoto`
  // categories are shown separately as Tarmoto-derived, so only osm/fsq here.
  const stopSources = useMemo(() => {
    let osm = false;
    let fsq = false;
    for (const stop of stops) {
      if (stop.source === "osm") osm = true;
      else if (stop.source === "fsq") fsq = true;
    }
    return { osm, fsq };
  }, [stops]);

  useEffect(() => {
    if (routeLines.length === 0 || categories.length === 0) {
      setStops([]);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const perChain = await Promise.all(
          routeLines.map((line) =>
            plannerApi.getRouteStops(
              line,
              categories,
              corridorKm,
              minStayRating,
              month,
              { signal: controller.signal },
            ),
          ),
        );
        // Re-offset each chain's km onto the trip-wide ridden distance
        // (the unridden hop between chains contributes nothing), then
        // dedupe a stop that sits in two chains' corridors — keep its
        // nearest hit so the "off route" figure stays honest.
        let offsetKm = 0;
        const byId = new Map<string, RouteStop>();
        perChain.forEach((chainStops, index) => {
          for (const stop of chainStops) {
            const placed = {
              ...stop,
              kmAlongRoute:
                Math.round((stop.kmAlongRoute + offsetKm) * 10) / 10,
            };
            const seen = byId.get(stop.id);
            if (!seen || placed.distanceFromRouteKm < seen.distanceFromRouteKm)
              byId.set(stop.id, placed);
          }
          offsetKm += lineLengthKm(routeLines[index]!);
        });
        const merged = [...byId.values()].sort(
          (a, b) => a.kmAlongRoute - b.kmAlongRoute,
        );
        if (!cancelled) setStops(merged);
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
  }, [routeLines, categories, corridorKm, minStayRating, month]);

  const activeLabels = categories
    .map((category) =>
      formatDisplayLowerCase(t(poiCategoryMeta(category).label), locale),
    )
    .join(", ");

  return (
    <div className="space-y-5 pt-2">
      {/* §01 POI CATEGORIES — the SHARED set; toggling syncs the map bar. */}
      <div>
        <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] font-bold">
          <span className="tracking-[1px] text-accent">
            {t("§ {number}", { number: 1 })}
          </span>
          <span className="tracking-[1.4px] text-fg-mute">
            {t("POI CATEGORIES")}
          </span>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-fg-dim">
          {t(
            "Same filters as the map's category bar. Here they're ranked by distance from your route line.",
          )}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {POI_CATEGORY_META.map(({ category, label, icon: Icon }) => {
            const active = activePoiCategories.has(category);
            const tarmotoDerived =
              category === "mountain_pass" || category === "twisty_highlight";
            // A venue category can come from both OSM and FSQ — split its dot
            // when Foursquare stops are present (#869).
            const twoTone = !tarmotoDerived && stopSources.fsq;
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
                  title={
                    tarmotoDerived
                      ? t("Tarmoto data")
                      : twoTone
                        ? t("OpenStreetMap + Foursquare")
                        : t("OpenStreetMap")
                  }
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    tarmotoDerived
                      ? "bg-accent"
                      : "border border-line-strong bg-transparent"
                  }`}
                  style={
                    twoTone
                      ? {
                          // Left half outlined (OSM), right half Foursquare blue
                          // — the category is served from both sources.
                          background: `linear-gradient(90deg, transparent 0 50%, ${FSQ_BRAND_COLOR} 50% 100%)`,
                        }
                      : undefined
                  }
                />
              </button>
            );
          })}
        </div>
        <div className="mt-2.5 flex gap-4">
          {/* The OSM legend dot doubles as the ODbL attribution link (#852);
              the map control carries the full "© OpenStreetMap contributors". */}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener noreferrer"
            title="© OpenStreetMap contributors"
            className="flex items-center gap-1.5 font-mono text-[9px] text-fg-mute transition hover:text-ink"
          >
            <span className="h-1.5 w-1.5 rounded-full border border-line-strong" />
            {t("OSM")}
          </a>
          {/* Foursquare credit (#869) — shown only while FSQ stops are present;
              the dot doubles as the required Apache-2.0 / NOTICE.txt credit. */}
          {stopSources.fsq ? (
            <a
              href="https://foursquare.com"
              target="_blank"
              rel="noopener noreferrer"
              title="© Foursquare"
              className="flex items-center gap-1.5 font-mono text-[9px] text-fg-mute transition hover:text-ink"
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: FSQ_BRAND_COLOR }}
              />
              {t("FSQ")}
            </a>
          ) : null}
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
            {t("WITHIN {distance}", {
              distance: format.distanceKm(corridorKm),
            })}
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
              {format.distanceKm(km)}
            </button>
          ))}
        </div>
      </div>

      {/* Minimum stay rating — accommodation categories only (§D). */}
      <div>
        <Select
          label={
            <LocalizedStyledValue
              t={t}
              messageKey="Minimum stay rating {details}"
              valueName="details"
              formattedValue={t("(biker hotels & campgrounds)")}
              className="text-fg-faint"
            />
          }
          value={minStayRating != null ? String(minStayRating) : ""}
          onChange={(value) =>
            setMinStayRating(value ? Number(value) : undefined)
          }
          tone="cream"
          options={[
            { value: "", label: t("Any") },
            { value: "3", label: t("3 stars or better") },
            { value: "4", label: t("4 stars or better") },
            { value: "5", label: t("5 stars only") },
          ]}
        />
      </div>

      {/* §02 ALONG YOUR ROUTE — one flat route-wide list (§B), gated (§E). */}
      <div>
        <div className="mb-2.5 flex items-baseline justify-between">
          <div className="flex items-center gap-2 font-mono text-[10px] font-bold">
            <span className="tracking-[1px] text-accent">
              {t("§ {number}", { number: 2 })}
            </span>
            <span className="tracking-[1.4px] text-fg-mute">
              {t("ALONG YOUR ROUTE")}
            </span>
          </div>
          {routeLines.length > 0 ? (
            <span className="font-mono text-[10px] text-fg-mute">
              {t("{count, plural, one {# STOP} other {# STOPS}}", {
                count: stops.length,
              })}
            </span>
          ) : null}
        </div>

        {routeLines.length === 0 ? (
          <div className="rounded-[11px] border border-line bg-cream px-3.5 py-3">
            <p className="text-[12px] leading-relaxed text-fg-dim">
              {t(
                "Plan a route to see stops along it — the corridor needs a route line to measure from. The map's category pins work anytime.",
              )}
            </p>
          </div>
        ) : categories.length === 0 ? (
          <div className="rounded-[11px] border border-line bg-cream px-3.5 py-3">
            <p className="text-[12px] leading-relaxed text-fg-dim">
              {t("Turn on a POI category above to see stops along the route.")}
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
              {t("Measuring the corridor…")}
            </p>
          </div>
        ) : stops.length === 0 ? (
          <div className="rounded-[11px] border border-line bg-cream px-3.5 py-3">
            <p className="text-[12px] leading-relaxed text-fg-dim">
              {t(
                "No {filters} stops within {distance} of your route — try a wider corridor.",
                {
                  filters: activeLabels,
                  distance: format.distanceKm(corridorKm),
                },
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
                      {poiDisplayName(stop, t)}
                    </span>
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.4px] text-fg-mute">
                      {t("{category} · {offset} · {along}", {
                        category: t(meta.label),
                        offset:
                          stop.distanceFromRouteKm < 0.1
                            ? t("on route")
                            : t("{distance} off", {
                                distance: format.distanceKm(
                                  stop.distanceFromRouteKm,
                                ),
                              }),
                        along: t("at {distance}", {
                          distance: format.distanceKm(stop.kmAlongRoute),
                        }),
                      })}
                    </span>
                    {(() => {
                      const d = readPoiDetails(stop);
                      const bits = [
                        d.stars !== undefined
                          ? t("{stars}-star", { stars: d.stars })
                          : null,
                        d.cuisine ?? d.brand ?? null,
                      ].filter((b): b is string => b !== null);
                      return bits.length > 0 ? (
                        <span className="mt-0.5 block truncate text-[10px] text-fg-mute">
                          {bits.join(" · ")}
                        </span>
                      ) : null;
                    })()}
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
