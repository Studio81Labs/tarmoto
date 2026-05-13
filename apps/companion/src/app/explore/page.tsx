"use client";
import { t } from "@/i18n";
import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMapStore } from "@/stores/map";
import { Filter, Search, RotateCcw } from "lucide-react";
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
import { QualityMap } from "./_components/QualityMap";
import {
  SegmentDetailSidebar,
  type SegmentDetailPanelState,
} from "./_components/SegmentDetailSidebar";
import { ApiError, roadsApi } from "@/lib/api";

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
function ExplorerPageInner() {
  const [filterOpen, setFilterOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );
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
    toggleQuality,
    toggleHazards,
    toggleSurface,
    filters,
    toggleQualityTier,
    toggleSurfaceType,
    toggleHazardType,
    setMinCurviness,
    setFilters,
    setCenter,
    setZoom,
    resetFilters,
  } = useMapStore();
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
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800">
        <div className="relative flex-1 max-w-md">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("Search roads, regions...")}
            className="w-full pl-9 pr-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setFilterOpen(!filterOpen)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition ${
              filterOpen
                ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
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
                ? "bg-quality-good/10 text-quality-good"
                : "bg-slate-800 text-slate-400"
            }`}
          >
            {t("Quality ")}
          </button>

          <button
            onClick={toggleHazards}
            className={`px-3 py-2 rounded-lg text-sm transition ${
              showHazardOverlay
                ? "bg-red-500/10 text-red-400"
                : "bg-slate-800 text-slate-400"
            }`}
          >
            {t("Hazards ")}
          </button>

          <button
            onClick={toggleSurface}
            className={`px-3 py-2 rounded-lg text-sm transition ${
              showSurfaceOverlay
                ? "bg-blue-500/10 text-blue-400"
                : "bg-slate-800 text-slate-400"
            }`}
          >
            {t("Surface ")}
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

            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {t("Curviness ")}
                </h3>
                <span className="text-xs text-slate-400 tabular-nums">
                  {filters.minCurviness === 0
                    ? "Any"
                    : `≥ ${filters.minCurviness}`}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={filters.minCurviness}
                onChange={(e) => setMinCurviness(Number(e.target.value))}
                aria-label={t("Minimum curviness")}
                className="w-full accent-tarmoto-cyan"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>{t("Straight")}</span>
                <span>{t("Very twisty")}</span>
              </div>
            </div>
          </div>
        )}

        {/* Map */}
        <div className="flex-1 relative bg-slate-900">
          <QualityMap
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
      </div>
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
    <div className="absolute bottom-10 left-4 z-10 rounded-xl bg-slate-950/80 border border-slate-800 backdrop-blur px-3 py-2.5 text-xs text-slate-300 space-y-2 pointer-events-none">
      {showQuality && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
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
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
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
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
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
