"use client";
import { t } from "@/i18n";
import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMapStore } from "@/stores/map";
import { useAuthStore } from "@/stores/auth";
import { MapPin, Search, RotateCcw } from "lucide-react";
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
import { Stamp } from "@tarmoto/ui";

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
  // SSR-stable initial value (true) avoids a hydration mismatch on
  // narrow viewports where a `matchMedia`-driven initializer would
  // return a different value than the server-rendered HTML. The
  // post-mount effect below narrows the default for real browsers.
  const [filterOpen, setFilterOpen] = useState<boolean>(true);
  // Wide-viewport detection. Drives both the post-mount sidebar
  // default and the info-panel layout swap (grid third column vs.
  // absolute overlay) so a phone toggling Closures/Passes still
  // sees a usable map rather than a 70 px sliver.
  const [isWideViewport, setIsWideViewport] = useState(true);
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsWideViewport(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  // Post-mount narrow-screen default: close the sidebar so the map
  // gets full width on phones. Runs once on mount; subsequent user
  // toggles of the Filters pill are respected (the effect is keyed
  // to `[]`, not to the viewport state, so a resize doesn't yank
  // the sidebar open or closed against the rider's wishes).
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    if (!window.matchMedia("(min-width: 1024px)").matches) {
      setFilterOpen(false);
    }
  }, []);
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
    // Test-only hook letting Playwright drive segment selection without a
    // real map click. Kept out of real production builds, but the e2e build
    // opts in via `NEXT_PUBLIC_E2E` (set only by playwright.config) so the
    // suite can run against a production build — `next dev`'s per-route JIT
    // compile is what made the CI run exceed its timeout.
    if (
      process.env.NODE_ENV === "production" &&
      process.env.NEXT_PUBLIC_E2E !== "1"
    ) {
      return;
    }
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
    // Spec-aligned Route Explorer (v2-pages.jsx RoadExplorerView): a
    // 300|1fr grid with the Filters sidebar on the left, full-bleed
    // map on the right carrying floating search + layer pills +
    // legend overlays. Closures / Passes info panel docks in via a
    // third column when those layers are toggled.
    //
    // Responsive grid template via CSS variables so each side column
    // collapses to 0 when its content is hidden — handles the
    // narrow-viewport case where the fixed 300 px + 320 px chrome
    // would crowd out the map and leave the rider with no recovery
    // affordance (the floating "Filters" pill in the layer overlay
    // is the toggle, matching the spec's primary-accent pill).
    <div
      className="grid h-full min-h-0 grid-cols-[var(--explore-left)_1fr_var(--explore-right)] bg-cream text-ink"
      style={
        {
          "--explore-left": filterOpen ? "300px" : "0px",
          // Info panel only takes a real grid column on wide
          // viewports. On narrow viewports it overlays the map
          // (see the absolute-positioned aside below) so a phone
          // doesn't lose its entire map area to a fixed rail.
          "--explore-right":
            isWideViewport && (showClosuresLayer || showPassesLayer)
              ? "320px"
              : "0px",
        } as React.CSSProperties
      }
    >
      {/* LEFT — Filters sidebar. Always present in the grid so the
          map column stays in the middle track — `display: none`
          would drop the aside from layout and the map would land
          in the 0-width first column instead. Closed state =
          `overflow-hidden` on a 0-width column clips the children,
          and `inert` + `aria-hidden` drop the (still-mounted)
          form controls out of focus order and the AT tree so
          keyboard users don't tab through invisible inputs. */}
      <aside
        className="flex min-h-0 flex-col overflow-hidden border-r border-line bg-paper"
        inert={!filterOpen}
        aria-hidden={!filterOpen}
      >
        <div className="flex items-center justify-between border-b border-line px-5 pb-3 pt-[18px]">
          <h2 className="font-sans text-[18px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
            {t("Filters")}
          </h2>
          <button
            type="button"
            onClick={resetFilters}
            disabled={isDefault}
            className="inline-flex items-center gap-1 font-mono text-[11px] font-bold uppercase tracking-[1px] text-fg-dim transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw size={12} />
            {t("Reset")}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-[18px]">
            <Stamp as="h3" className="mb-2.5 block">
              {t("Road quality")}
            </Stamp>
            <div className="flex flex-col gap-2">
              {QUALITY_OPTIONS.map((opt) => (
                <FilterCheckbox
                  key={opt.key}
                  checked={filters.quality.has(opt.key)}
                  onChange={() => toggleQualityTier(opt.key)}
                  swatch={
                    <span
                      aria-hidden="true"
                      className={`h-2.5 w-2.5 rounded-full ${opt.color}`}
                    />
                  }
                  label={opt.label}
                />
              ))}
            </div>
          </div>

          <div className="mb-[18px]">
            <Stamp as="h3" className="mb-2.5 block">
              {t("Surface type")}
            </Stamp>
            <div className="flex flex-col gap-2">
              {SURFACE_OPTIONS.map((opt) => (
                <FilterCheckbox
                  key={opt.key}
                  checked={filters.surface.has(opt.key)}
                  onChange={() => toggleSurfaceType(opt.key)}
                  swatch={
                    <span
                      aria-hidden="true"
                      className={`h-2.5 w-2.5 rounded-full ${opt.color}`}
                    />
                  }
                  label={opt.label}
                />
              ))}
            </div>
          </div>

          <div className="mb-[18px]">
            <Stamp as="h3" className="mb-2.5 block">
              {t("Hazard type")}
            </Stamp>
            <div className="flex flex-col gap-2">
              {HAZARD_OPTIONS.map((opt) => (
                <FilterCheckbox
                  key={opt.key}
                  checked={filters.hazardTypes.has(opt.key)}
                  onChange={() => toggleHazardType(opt.key)}
                  swatch={
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: opt.hex }}
                    />
                  }
                  label={opt.label}
                />
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* CENTER — Map + floating overlays */}
      <div className="relative min-h-0 min-w-0 bg-cream">
        <div className="absolute inset-0">
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
        </div>

        {/* Floating top overlay — search + layer toggle pills. Search
            renders only for signed-in riders (the underlying
            `/api/v1/geocode` endpoint sits behind AuthGuard), so a
            public visitor sees only the pills. The search container
            is a fixed 380 px (clamped to the viewport width) so
            toggling the Filters sidebar doesn't reflow the input or
            the pill row alongside it. */}
        <div className="absolute left-4 right-4 top-4 z-10 flex flex-wrap items-center gap-2.5">
          {isAuthenticated ? (
            <div className="w-[380px] max-w-full">
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
            </div>
          ) : null}

          {/* Layer pills per spec: rounded-10, 12 700, soft shadow.
              The leading "Filters" pill toggles the left sidebar.
              All active states use the solid brand-accent fill so
              the active pill stays legible over a busy map — the
              spec's `accent/20` swatch reads as low-contrast
              transparency once real map content sits underneath. */}
          <button
            type="button"
            onClick={() => setFilterOpen((value) => !value)}
            aria-pressed={filterOpen}
            aria-label={t("Toggle filters")}
            className={`inline-flex items-center gap-1.5 rounded-[10px] border border-line-strong px-4 py-2.5 text-[12px] font-bold shadow-[0_6px_16px_rgba(14,14,16,0.08)] transition ${
              filterOpen
                ? "bg-accent text-ink"
                : "bg-cream text-ink hover:bg-paper"
            }`}
          >
            {t("Filters")}
          </button>
          <button
            type="button"
            onClick={toggleQuality}
            aria-pressed={showQualityOverlay}
            className={`inline-flex items-center gap-1.5 rounded-[10px] border border-line-strong px-4 py-2.5 text-[12px] font-bold shadow-[0_6px_16px_rgba(14,14,16,0.08)] transition ${
              showQualityOverlay
                ? "bg-accent text-ink"
                : "bg-cream text-ink hover:bg-paper"
            }`}
          >
            {t("Quality")}
          </button>
          <button
            type="button"
            onClick={toggleHazards}
            aria-pressed={showHazardOverlay}
            className={`inline-flex items-center gap-1.5 rounded-[10px] border border-line-strong px-4 py-2.5 text-[12px] font-bold shadow-[0_6px_16px_rgba(14,14,16,0.08)] transition ${
              showHazardOverlay
                ? "bg-accent text-ink"
                : "bg-cream text-ink hover:bg-paper"
            }`}
          >
            {t("Hazards")}
          </button>
          <button
            type="button"
            onClick={toggleSurface}
            aria-pressed={showSurfaceOverlay}
            className={`inline-flex items-center gap-1.5 rounded-[10px] border border-line-strong px-4 py-2.5 text-[12px] font-bold shadow-[0_6px_16px_rgba(14,14,16,0.08)] transition ${
              showSurfaceOverlay
                ? "bg-accent text-ink"
                : "bg-cream text-ink hover:bg-paper"
            }`}
          >
            {t("Surface")}
          </button>
          <button
            type="button"
            onClick={toggleClosuresLayer}
            aria-pressed={showClosuresLayer}
            className={`inline-flex items-center gap-1.5 rounded-[10px] border border-line-strong px-4 py-2.5 text-[12px] font-bold shadow-[0_6px_16px_rgba(14,14,16,0.08)] transition ${
              showClosuresLayer
                ? "bg-accent text-ink"
                : "bg-cream text-ink hover:bg-paper"
            }`}
          >
            {t("Closures")}
          </button>
          <button
            type="button"
            onClick={togglePassesLayer}
            aria-pressed={showPassesLayer}
            className={`inline-flex items-center gap-1.5 rounded-[10px] border border-line-strong px-4 py-2.5 text-[12px] font-bold shadow-[0_6px_16px_rgba(14,14,16,0.08)] transition ${
              showPassesLayer
                ? "bg-accent text-ink"
                : "bg-cream text-ink hover:bg-paper"
            }`}
          >
            {t("Passes")}
          </button>
        </div>

        <MapLegend
          showQuality={showQualityOverlay}
          showSurface={showSurfaceOverlay}
          showHazards={showHazardOverlay}
        />
        <SegmentDetailSidebar
          state={segmentDetailState}
          onClose={() => setSelectedSegmentId(null)}
        />

        {/* Narrow-viewport info panel — overlays the map instead of
            taking a grid column so a phone keeps useful map area
            underneath. Close button toggles off whichever info
            layer is active (mirrors how toggling the pill in the
            top overlay dismisses the panel). */}
        {(showClosuresLayer || showPassesLayer) && !isWideViewport && (
          <aside
            className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col gap-4 overflow-y-auto border-l border-line bg-paper p-4 pt-16 shadow-[-6px_0_16px_rgba(14,14,16,0.08)]"
            aria-label={t("Info layers")}
          >
            <button
              type="button"
              onClick={() => {
                if (showClosuresLayer) toggleClosuresLayer();
                if (showPassesLayer) togglePassesLayer();
              }}
              className="absolute right-3 top-3 rounded-md border border-line-strong bg-cream px-2 py-1 text-[11px] font-bold uppercase tracking-[1px] text-ink transition hover:bg-paper-2"
              aria-label={t("Close info panel")}
            >
              {t("Close")}
            </button>
            <InfoPanelContent
              showClosures={showClosuresLayer}
              showPasses={showPassesLayer}
              conditionsMonth={conditionsMonth}
              setConditionsMonth={setConditionsMonth}
              conditionsDate={conditionsDate}
              setConditionsDate={setConditionsDate}
              conditionBbox={conditionBbox}
            />
          </aside>
        )}
      </div>

      {/* RIGHT — Closures / Passes info panel. On wide viewports
          docks in as a real third grid column (the `--explore-right`
          CSS variable allocates 320 px); on narrow viewports the
          grid column collapses to 0 and the same content renders
          as a top-anchored overlay over the map (with a close
          affordance) so a phone keeps a usable map underneath. */}
      {(showClosuresLayer || showPassesLayer) && isWideViewport && (
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l border-line bg-paper p-4">
          <InfoPanelContent
            showClosures={showClosuresLayer}
            showPasses={showPassesLayer}
            conditionsMonth={conditionsMonth}
            setConditionsMonth={setConditionsMonth}
            conditionsDate={conditionsDate}
            setConditionsDate={setConditionsDate}
            conditionBbox={conditionBbox}
          />
        </aside>
      )}
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

// Closures + Passes info-panel content. Shared between the wide-
// viewport third-grid-column aside and the narrow-viewport
// overlay aside so the closures date picker, ClosuresPanel, and
// PassesPanel only get described once.
function InfoPanelContent({
  showClosures,
  showPasses,
  conditionsMonth,
  setConditionsMonth,
  conditionsDate,
  setConditionsDate,
  conditionBbox,
}: {
  showClosures: boolean;
  showPasses: boolean;
  conditionsMonth: number;
  setConditionsMonth: (month: number) => void;
  conditionsDate: Date;
  setConditionsDate: (date: Date) => void;
  conditionBbox: string | null;
}) {
  return (
    <>
      {showClosures && (
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs uppercase tracking-wider text-ink">
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
              className="w-full rounded-lg border border-line-strong bg-paper px-2 py-1.5 text-sm text-ink transition focus:border-accent focus:outline-none"
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
            <p className="text-xs text-fg-dim">
              {t("Pan the map to load closures for this area.")}
            </p>
          )}
        </div>
      )}
      {showPasses &&
        (conditionBbox ? (
          <PassesPanel
            month={conditionsMonth}
            onMonthChange={setConditionsMonth}
            routes={[]}
            bbox={conditionBbox}
            showRouteWarnings={false}
          />
        ) : (
          <p className="text-xs text-fg-dim">
            {t("Pan the map to load passes for this area.")}
          </p>
        ))}
    </>
  );
}

// Spec-styled filter checkbox: 16 × 16 rounded-4 ink-bordered
// square that fills with solid ink + cream checkmark when on.
// The native `<input>` stays in the DOM (visually hidden via
// `sr-only`) for keyboard + screen-reader semantics; the visual
// square renders in a sibling span styled with the `peer-…`
// modifier chain so focus rings and checked-state styling stay
// linked to the underlying input state.
function FilterCheckbox({
  checked,
  onChange,
  swatch,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  swatch: React.ReactNode;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-[13px] font-medium text-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`flex h-4 w-4 items-center justify-center rounded-[4px] border-[1.5px] border-ink transition peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-1 ${
          checked ? "bg-ink" : "bg-cream"
        }`}
      >
        {checked && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            className="text-cream"
          >
            <path
              d="M2 6l3 3 5-6"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      {swatch}
      <span>{label}</span>
    </label>
  );
}

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
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-dim"
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
        className="w-full pl-9 pr-4 py-2 rounded-lg bg-paper border border-line-strong text-ink text-sm placeholder:text-fg-dim focus:outline-none focus:border-accent transition"
      />
      {showResults && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-line-strong bg-cream py-1 shadow-xl">
          {loading && matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-fg-dim">
              {t("Searching…")}
            </div>
          ) : error ? (
            <div className="px-3 py-2 text-xs text-red-300">
              {t("Couldn't search right now. Try again.")}
            </div>
          ) : matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-fg-dim">
              {t("No places found.")}
            </div>
          ) : (
            matches.map((m, i) => (
              <button
                key={`${m.lat},${m.lng},${i}`}
                type="button"
                onClick={() => handlePick(m)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink transition hover:bg-paper"
              >
                <MapPin
                  size={12}
                  className="shrink-0 text-fg-dim"
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
    <div className="absolute bottom-10 left-4 z-10 rounded-xl bg-paper/90 border border-line-strong backdrop-blur px-3 py-2.5 text-xs text-ink space-y-2 pointer-events-none">
      {showQuality && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-ink mb-1.5">
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
          <p className="text-[10px] uppercase tracking-wider text-ink mb-1.5">
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
          <p className="text-[10px] uppercase tracking-wider text-ink mb-1.5">
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
          <p className="text-[9px] text-fg-dim mt-1">
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
