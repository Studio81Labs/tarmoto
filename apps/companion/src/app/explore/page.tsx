"use client";
import { t } from "@/i18n";
import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMapStore } from "@/stores/map";
import { useAuthStore } from "@/stores/auth";
import { Filter, MapPin, Search, RotateCcw } from "lucide-react";
import {
  DEFAULT_MAP_FILTERS,
  filtersEqual,
  filtersFromSearchParams,
  filtersToSearchParams,
  type FilterableSurface,
  type QualityTier,
} from "@/lib/map-filters";
import { HAZARD_CONFIG, HAZARD_TYPES_UI } from "@/lib/utils";
import type { HazardType } from "@tarmoto/shared";
import { QualityMap, type QualityMapHandle } from "./_components/QualityMap";
import {
  SegmentDetailSidebar,
  type SegmentDetailPanelState,
} from "./_components/SegmentDetailSidebar";
import { ApiError, api, roadsApi } from "@/lib/api";
import { ClosuresPanel } from "@/components/ClosuresPanel";
import { PassesPanel } from "@/components/PassesPanel";
import { currentUtcMonth } from "@/lib/passes-summary";

declare global {
  interface Window {
    __tarmotoSelectExploreSegment?: (segmentId: string) => void;
  }
}
/**
 * ExplorerPage — Full-screen road quality map explorer
 *
 * Filter state is mirrored to the URL (?q=...&s=...&c=...) so the view is
 * shareable. QualityMap consumes the store's `filters` and dims non-matching
 * segments via MapLibre paint expressions rather than hiding them outright.
 */
const QUALITY_OPTIONS: {
  key: QualityTier;
  label: string;
  color: string;
}[] = [
  { key: "excellent", label: "Excellent", color: "bg-quality-excellent" },
  { key: "good", label: "Good", color: "bg-quality-good" },
  { key: "fair", label: "Fair", color: "bg-quality-fair" },
  { key: "poor", label: "Poor", color: "bg-quality-poor" },
  { key: "very-poor", label: "Very Poor", color: "bg-quality-very-poor" },
];
const SURFACE_OPTIONS: {
  key: FilterableSurface;
  label: string;
  color: string;
}[] = [
  { key: "asphalt", label: "Asphalt", color: "bg-surface-asphalt" },
  { key: "concrete", label: "Concrete", color: "bg-surface-concrete" },
  { key: "cobblestone", label: "Cobblestone", color: "bg-surface-cobblestone" },
  { key: "gravel", label: "Gravel", color: "bg-surface-gravel" },
  { key: "dirt", label: "Dirt", color: "bg-surface-dirt" },
];
const HAZARD_OPTIONS: {
  key: HazardType;
  label: string;
  emoji: string;
  hex: string;
}[] = HAZARD_TYPES_UI.map((key) => ({
  key,
  label: HAZARD_CONFIG[key].label,
  emoji: HAZARD_CONFIG[key].emoji,
  hex: HAZARD_CONFIG[key].hex,
}));

function formatBbox(bbox: readonly [number, number, number, number]): string {
  return bbox.join(",");
}

// `<input type="date">` round-trip helpers. The element wants
// `YYYY-MM-DD` strings keyed off the browser locale's calendar day;
// the closures API consumes ISO instants. We anchor each round-trip
// at noon UTC so a viewer in any timezone parses the local date the
// rider picked into the same calendar day instant.
function toDateInputValue(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInputValue(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 12, 0, 0));
}

// Today, normalised to the same noon-UTC anchor the date picker
// produces. Using a raw `new Date()` would feed the closures API
// the current instant — closures starting later today wouldn't
// match `active_on=<now>` until the rider re-picked the visible
// date, even though the picker UI already shows today.
//
// The year/month/day come from the rider's *local* calendar
// (`getFullYear()` / `getMonth()` / `getDate()`), not UTC. A user
// in California at 18:00 PST sees Friday on their device even
// though UTC is already Saturday at 02:00; pulling UTC fields
// here would boot the picker on Saturday's preview while the
// browser still reads Friday.
function todayAsPreviewDate(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0),
  );
}

// `Filters` panel — endpoint mapping reference
// ──────────────────────────────────────────────
// Each filter section corresponds to a specific backend contract;
// changing the section signature here means touching the matching
// endpoint:
//
//  • Road quality / Surface  → GET /api/v1/tiles/... (segment vector
//    tiles). Filtering is done client-side via the MapLibre opacity
//    expression in `QualityMap.buildQualityOpacityExpression` —
//    the tile payload carries `quality_score` and `surface_type` and
//    the active toggle simply dims non-matching segments.
//  • Hazards                 → GET /api/v1/hazards (PostGIS bbox).
//    `HazardOverlay` reads `filters.hazardTypes` to filter the
//    rendered markers.
//  • Closures / Passes       → GET /api/v1/closures + GET /api/v1/passes.
//    Driven from the top-bar info-layer toggles (#570), not the
//    filter column. When either toggle is on, a right-docked panel
//    surfaces the structured list for the current viewport bbox.
//    `ClosuresPanel` carries a noon-UTC date picker so the rider
//    can preview "tomorrow", "next weekend", etc.; `PassesPanel`
//    keeps its month-of-year selector (passes are seasonal).
//
// Pages can opt into a new filter only after the corresponding tile/
// endpoint actually serves it — for example, the prior `Curviness`
// slider was removed (#576) because `road_segments.curviness_score`
// holds quality-shaped 0–5 values, not the 0–100 the slider implied,
// so the filter was effectively a no-op for every realistic value.
function ExplorerPageInner() {
  const [filterOpen, setFilterOpen] = useState(true);
  const [conditionsMonth, setConditionsMonth] = useState<number>(() =>
    currentUtcMonth(),
  );
  const [conditionsDate, setConditionsDate] = useState<Date>(() =>
    todayAsPreviewDate(),
  );
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );
  const [conditionBbox, setConditionBbox] = useState<string | null>(null);
  const [segmentDetailState, setSegmentDetailState] =
    useState<SegmentDetailPanelState>({ status: "idle" });
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    center,
    zoom,
    showQualityOverlay,
    showHazardOverlay,
    showSurfaceOverlay,
    showClosuresLayer,
    showPassesLayer,
    toggleQuality,
    toggleHazards,
    toggleSurface,
    toggleClosuresLayer,
    togglePassesLayer,
    filters,
    toggleQualityTier,
    toggleSurfaceType,
    toggleHazardType,
    setFilters,
    setCenter,
    setZoom,
    resetFilters,
  } = useMapStore();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // Imperative handle to the MapLibre camera. `MapCanvas` reads
  // its initial center/zoom only at mount (to avoid yanking user
  // pans), so search-pick flows need this narrow opt-in channel
  // to actually fly the map.
  const mapRef = useRef<QualityMapHandle | null>(null);
  // Hydrate the store from URL params on mount and on back/forward navigation.
  // `hydrated` is state (not a ref) so the URL-sync effect waits for the render
  // that follows the store update — otherwise it would see stale `filters` from
  // the same commit and overwrite the URL with defaults.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setFilters(filtersFromSearchParams(searchParams));
    setHydrated(true);
  }, [searchParams, setFilters]);
  // Reflect store changes back into the URL without scrolling or pushing history.
  useEffect(() => {
    if (!hydrated) return;
    const current = new URLSearchParams(searchParams.toString());
    const next = filtersToSearchParams(filters, current);
    if (next.toString() === current.toString()) return;
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [filters, hydrated, pathname, router, searchParams]);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    window.__tarmotoSelectExploreSegment = (segmentId: string) => {
      if (segmentId) setSelectedSegmentId(segmentId);
    };
    return () => {
      delete window.__tarmotoSelectExploreSegment;
    };
  }, []);
  useEffect(() => {
    if (!selectedSegmentId) {
      setSegmentDetailState({ status: "idle" });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setSegmentDetailState({
      status: "loading",
      segmentId: selectedSegmentId,
    });

    roadsApi
      .getSegmentDetail(selectedSegmentId, { signal: controller.signal })
      .then(({ data }) => {
        if (cancelled) return;
        setSegmentDetailState({ status: "ready", segment: data });
      })
      .catch((err) => {
        if ((err as { name?: string }).name === "AbortError") return;
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setSegmentDetailState({
            status: "not-found",
            segmentId: selectedSegmentId,
          });
          return;
        }
        setSegmentDetailState({
          status: "error",
          segmentId: selectedSegmentId,
          message:
            err instanceof Error
              ? err.message
              : "Could not load road segment details.",
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedSegmentId]);
  const isDefault = filtersEqual(filters, DEFAULT_MAP_FILTERS);
  return (
    // `tarmoto-no-cream` opts the entire map page out of the
    // signed-in AppShell's cream theme. The whole experience was
    // authored for a dark mapping surface (basemap tiles, semantic
    // overlay colours, dark legend) and the cream remap turns
    // `bg-slate-800 text-slate-300` toolbar buttons into ink-on-
    // paper for authenticated users while leaving translucent
    // `bg-quality-good/20 text-quality-good` washes unremapped —
    // a mix that broke contrast on the toggle pills. Pinning the
    // page to dark keeps signed-in and public renderings visually
    // identical and lets the WCAG-AA contrast budget here apply to
    // a single canvas.
    <div className="tarmoto-no-cream flex flex-col h-full bg-slate-950">
      {/* Search bar — only rendered for signed-in riders. The
          underlying `/api/v1/geocode` endpoint sits behind
          AuthGuard, so a public visitor would get 401 on every
          query. Hide rather than show-an-error-state, matching
          how the rest of the public explore degrades. */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800">
        {isAuthenticated ? (
          <ExploreSearch
            onPick={(place) => {
              // Fly the actual MapLibre camera. Updating the
              // store alone wouldn't move the visible map —
              // MapCanvas reads center/zoom only at init. We
              // still mirror the new position back into the
              // store so a subsequent remount lands in the same
              // place.
              mapRef.current?.flyTo({
                lng: place.lng,
                lat: place.lat,
                zoom: EXPLORE_SEARCH_RESULT_ZOOM,
              });
              setCenter({ lng: place.lng, lat: place.lat });
              setZoom(EXPLORE_SEARCH_RESULT_ZOOM);
            }}
          />
        ) : (
          <div className="flex-1 max-w-md" />
        )}

        <div className="flex items-center gap-1.5">
          {/* Active toggle: filled brand accent (high-contrast primary
              affordance from the design system). Inactive: slate
              surface with cream text. The old `bg-tarmoto-cyan/10
              text-tarmoto-cyan` for the Filters button rendered as
              ~4:1 orange-on-dark — failed WCAG AA and read as a
              dim glow rather than an actionable state. Quality /
              Hazards / Surface keep their semantic data colours
              (the green / red / blue cues map to the layer the
              button toggles) but the inactive text bumps from
              slate-400 → slate-300 to clear the AA threshold on
              the slate-800 backdrop. */}
          <button
            onClick={() => setFilterOpen(!filterOpen)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition ${
              filterOpen
                ? "bg-accent text-ink"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            <Filter size={14} />
            {t("Filters ")}
          </button>

          <button
            onClick={toggleQuality}
            className={`px-3 py-2 rounded-lg text-sm transition ${
              showQualityOverlay
                ? "bg-quality-good/20 text-quality-good"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {t("Quality ")}
          </button>

          <button
            onClick={toggleHazards}
            className={`px-3 py-2 rounded-lg text-sm transition ${
              showHazardOverlay
                ? "bg-red-500/20 text-red-300"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {t("Hazards ")}
          </button>

          <button
            onClick={toggleSurface}
            className={`px-3 py-2 rounded-lg text-sm transition ${
              showSurfaceOverlay
                ? "bg-blue-500/20 text-blue-300"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {t("Surface ")}
          </button>

          {/* Info-layer toggles — open a docked side panel with the
              closures/passes data for the current viewport. Visually
              grouped with the data-layer paint toggles above (Quality
              / Hazards / Surface) because they share the same "tap
              to reveal information about this map area" intent. */}
          <button
            onClick={toggleClosuresLayer}
            className={`px-3 py-2 rounded-lg text-sm transition ${
              showClosuresLayer
                ? "bg-amber-500/20 text-amber-300"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {t("Closures ")}
          </button>

          <button
            onClick={togglePassesLayer}
            className={`px-3 py-2 rounded-lg text-sm transition ${
              showPassesLayer
                ? "bg-purple-500/20 text-purple-300"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {t("Passes ")}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Filter panel */}
        {filterOpen && (
          <div className="w-64 border-r border-slate-800 bg-slate-950 overflow-y-auto p-4 space-y-6 animate-slide-in-right">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">
                {t("Filters")}
              </h2>
              <button
                type="button"
                onClick={resetFilters}
                disabled={isDefault}
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                <RotateCcw size={12} />
                {t("Reset ")}
              </button>
            </div>

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
                {t("Road quality ")}
              </h3>
              <div className="space-y-2">
                {QUALITY_OPTIONS.map((opt) => (
                  <label
                    key={opt.key}
                    className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={filters.quality.has(opt.key)}
                      onChange={() => toggleQualityTier(opt.key)}
                      className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
                    />
                    <span className={`w-2.5 h-2.5 rounded-full ${opt.color}`} />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
                {t("Surface type ")}
              </h3>
              <div className="space-y-2">
                {SURFACE_OPTIONS.map((opt) => (
                  <label
                    key={opt.key}
                    className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={filters.surface.has(opt.key)}
                      onChange={() => toggleSurfaceType(opt.key)}
                      className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
                    />
                    <span className={`w-2.5 h-2.5 rounded-full ${opt.color}`} />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
                {t("Hazard type ")}
              </h3>
              <div className="space-y-2">
                {HAZARD_OPTIONS.map((opt) => (
                  <label
                    key={opt.key}
                    className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={filters.hazardTypes.has(opt.key)}
                      onChange={() => toggleHazardType(opt.key)}
                      className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
                    />
                    <span
                      aria-hidden="true"
                      className="inline-flex w-4 h-4 items-center justify-center text-[11px] leading-none rounded-full"
                      style={{ backgroundColor: opt.hex }}
                    >
                      {opt.emoji}
                    </span>
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Map */}
        <div className="flex-1 relative bg-slate-900">
          <QualityMap
            ref={mapRef}
            center={center}
            zoom={zoom}
            filters={filters}
            showQuality={showQualityOverlay}
            showSurface={showSurfaceOverlay}
            showHazards={showHazardOverlay}
            onSegmentSelect={setSelectedSegmentId}
            onViewChange={(view) => {
              setCenter({ lng: view.lng, lat: view.lat });
              setZoom(view.zoom);
              setConditionBbox(formatBbox(view.bbox));
            }}
          />
          <MapLegend
            showQuality={showQualityOverlay}
            showSurface={showSurfaceOverlay}
            showHazards={showHazardOverlay}
          />
          <SegmentDetailSidebar
            state={segmentDetailState}
            onClose={() => setSelectedSegmentId(null)}
          />
        </div>

        {/* Info-layer panel — docks to the right whenever the rider
            toggles Closures or Passes on. Shares the panel rather
            than spawning two competing right-rail drawers; the
            date picker is scoped to Closures (Passes uses month
            selection inside `PassesPanel` itself). */}
        {(showClosuresLayer || showPassesLayer) && (
          <div className="w-80 border-l border-slate-800 bg-slate-950 overflow-y-auto p-4 space-y-4 animate-slide-in-right">
            {showClosuresLayer && (
              <div className="space-y-3">
                <label className="block space-y-1.5">
                  <span className="text-xs uppercase tracking-wider text-slate-300">
                    {t("Preview closures on")}
                  </span>
                  <input
                    type="date"
                    value={toDateInputValue(conditionsDate)}
                    onChange={(e) => {
                      const next = parseDateInputValue(e.target.value);
                      if (next) setConditionsDate(next);
                    }}
                    aria-label={t("Preview closures on")}
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent transition"
                  />
                </label>
                {conditionBbox ? (
                  <ClosuresPanel
                    month={conditionsMonth}
                    previewDate={conditionsDate}
                    routes={[]}
                    bbox={conditionBbox}
                    showRouteWarnings={false}
                  />
                ) : (
                  <p className="text-xs text-slate-400">
                    {t("Pan the map to load closures for this area.")}
                  </p>
                )}
              </div>
            )}
            {showPassesLayer &&
              (conditionBbox ? (
                <PassesPanel
                  month={conditionsMonth}
                  onMonthChange={setConditionsMonth}
                  routes={[]}
                  bbox={conditionBbox}
                  showRouteWarnings={false}
                />
              ) : (
                <p className="text-xs text-slate-400">
                  {t("Pan the map to load passes for this area.")}
                </p>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
// Geocode search for the /explore header. Reuses the same
// `/api/v1/geocode` endpoint the rides + community PlaceSearch
// drives — the planner's existing provider, so we don't introduce
// another geocoder dependency. UX is intentionally narrower than
// PlaceSearch (no radius picker, no persistent selection state):
// type → see matches → click → fly the map there. Documented as
// the answer to the issue's first AC ("Behavior decided +
// documented…").
const EXPLORE_SEARCH_DEBOUNCE_MS = 350;
const EXPLORE_SEARCH_MIN_CHARS = 2;
const EXPLORE_SEARCH_RESULT_ZOOM = 12;

interface GeocodeMatch {
  label: string;
  lat: number;
  lng: number;
}

function ExploreSearch({ onPick }: { onPick: (place: GeocodeMatch) => void }) {
  const [draft, setDraft] = useState("");
  const [matches, setMatches] = useState<GeocodeMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Outside-click closes the dropdown.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Debounced geocode fetch — mirrors the PlaceSearch pattern so
  // a rider typing across keystrokes doesn't fan out one request
  // per character.
  useEffect(() => {
    const q = draft.trim();
    if (q.length < EXPLORE_SEARCH_MIN_CHARS) {
      setMatches([]);
      setLoading(false);
      setError(false);
      return;
    }
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(false);
      api
        .GET("/api/v1/geocode", {
          params: { query: { q } as never },
          signal: ctrl.signal,
        })
        .then(({ data, error: apiError }) => {
          if (ctrl.signal.aborted) return;
          setLoading(false);
          if (apiError) {
            setMatches([]);
            setError(true);
            return;
          }
          const body = data as unknown as { results: GeocodeMatch[] };
          setMatches(body.results ?? []);
        })
        .catch((err: Error) => {
          if (ctrl.signal.aborted) return;
          setLoading(false);
          if (err.name !== "AbortError") {
            setMatches([]);
            setError(true);
          }
        });
    }, EXPLORE_SEARCH_DEBOUNCE_MS);
    return () => {
      // Cancel both the pending debounce AND any request that
      // already left — without the abort, a late response from
      // a stale query could repopulate `matches` for the wrong
      // input after the rider has already typed something else
      // (or cleared the field).
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [draft]);

  const handlePick = (place: GeocodeMatch) => {
    setDraft(place.label);
    setOpen(false);
    setMatches([]);
    onPick(place);
  };

  const showResults =
    open &&
    (loading ||
      error ||
      matches.length > 0 ||
      draft.trim().length >= EXPLORE_SEARCH_MIN_CHARS);

  return (
    <div ref={containerRef} className="relative flex-1 max-w-md">
      <Search
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
      />
      <input
        type="text"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={t("Search for a place…")}
        aria-label={t("Search for a place")}
        autoComplete="off"
        className="w-full pl-9 pr-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-accent transition"
      />
      {showResults && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl">
          {loading && matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400">
              {t("Searching…")}
            </div>
          ) : error ? (
            <div className="px-3 py-2 text-xs text-red-300">
              {t("Couldn't search right now. Try again.")}
            </div>
          ) : matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400">
              {t("No places found.")}
            </div>
          ) : (
            matches.map((m, i) => (
              <button
                key={`${m.lat},${m.lng},${i}`}
                type="button"
                onClick={() => handlePick(m)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800"
              >
                <MapPin
                  size={12}
                  className="shrink-0 text-slate-500"
                  aria-hidden="true"
                />
                <span className="truncate">{m.label}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface MapLegendProps {
  showQuality: boolean;
  showSurface: boolean;
  showHazards: boolean;
}
function MapLegend({ showQuality, showSurface, showHazards }: MapLegendProps) {
  if (!showQuality && !showSurface && !showHazards) return null;
  return (
    <div className="absolute bottom-10 left-4 z-10 rounded-xl bg-slate-950/90 border border-slate-700 backdrop-blur px-3 py-2.5 text-xs text-slate-200 space-y-2 pointer-events-none">
      {showQuality && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-300 mb-1.5">
            {t("Road quality ")}
          </p>
          <div className="flex items-center gap-2">
            {QUALITY_OPTIONS.map((opt) => (
              <div key={opt.key} className="flex items-center gap-1">
                <span className={`h-1.5 w-3 rounded-full ${opt.color}`} />
                <span className="text-[10px]">{opt.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {showSurface && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-300 mb-1.5">
            {t("Surface ")}
          </p>
          <div className="flex items-center gap-2">
            {SURFACE_OPTIONS.map((opt) => (
              <div key={opt.key} className="flex items-center gap-1">
                <span className={`h-1.5 w-3 rounded-full ${opt.color}`} />
                <span className="text-[10px]">{opt.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {showHazards && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-300 mb-1.5">
            {t("Hazards ")}
          </p>
          <div className="flex items-center gap-x-2 gap-y-1 flex-wrap max-w-[260px]">
            {HAZARD_OPTIONS.map((opt) => (
              <div key={opt.key} className="flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="inline-flex w-3.5 h-3.5 items-center justify-center text-[10px] leading-none rounded-full"
                  style={{ backgroundColor: opt.hex }}
                >
                  {opt.emoji}
                </span>
                <span className="text-[10px]">{opt.label}</span>
              </div>
            ))}
          </div>
          <p className="text-[9px] text-slate-500 mt-1">
            {t("Opacity fades as reports age ")}
          </p>
        </div>
      )}
    </div>
  );
}
export default function ExplorerPage() {
  return (
    <Suspense fallback={null}>
      <ExplorerPageInner />
    </Suspense>
  );
}
