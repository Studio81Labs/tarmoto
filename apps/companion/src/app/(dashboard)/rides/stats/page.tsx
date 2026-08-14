"use client";

import { useI18n, useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage, type EnglishMessageKey } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  type TooltipValueType,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3, Loader2 } from "lucide-react";
import {
  Card,
  DataTable,
  MetricTile,
  Mono,
  PageHeader,
  SegmentedControl,
  SkeletonDashboard,
  Stamp,
  type DataTableColumn,
  type MetricTileProps,
} from "@tarmoto/ui";
import { RidesEmptyState } from "../_RidesEmptyState";
import { fetchAllRides } from "@/lib/rides-fetch";
import {
  fetchRideBreakdown,
  rideBreakdownLabel,
  type RideBreakdown,
  type RideBreakdownSlice,
} from "@/lib/rides-breakdown";
import { useAuthStore } from "@/stores/auth";
import { useFormat } from "@/format/FormatProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import {
  formatDisplayLowerCase,
  formatSplitValueUnit,
  kmToMiles,
  type Formatters,
} from "@tarmoto/shared";
import {
  availableYears,
  computeAllTimeTotals,
  computeCalendarHeatmap,
  computeDistanceSeries,
  formatDistanceChartValue,
  computeQualityTrend,
  computeYearOverYear,
  computeYearlyTotals,
  DEFAULT_RIDE_FILTERS,
  filterRides,
  statsWindowLabel,
  STATS_WINDOWS,
  type QualityPoint,
  type RideForStats,
  type RideFilters,
  type RideType,
  type StatsWindow,
  type YearlyTotal,
} from "@/lib/ride-stats";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
const RIDE_TYPE_OPTIONS: { value: string; label: EnglishMessageKey }[] = [
  { value: "all", label: "All" },
  { value: "free", label: "Free" },
  { value: "commute", label: "Commute" },
  { value: "trip", label: "Trip" },
  { value: "tracked", label: "Tracked" },
];
// Year-over-year line palette tuned for cream surfaces. Each hue lands
// at ≥3:1 against bg-cream so the chart lines read as distinct strokes
// (WCAG 3:1 graphic-element bar). The plain canonical accent (#FF6A1A)
// is only ~2.5:1 on cream, so year 1 uses a darker brand-orange variant
// (#D44F00 ≈ 4.3:1) — same hue family but cream-safe as a chart line.
// The other four are dark variants of the original cyan/violet/pink/
// yellow/emerald spread so the per-year colour cue stays usable.
const YOY_COLORS = [
  "#D44F00", // dark brand orange (was canonical accent → ~2.5:1 fail)
  "#7C3AED", // violet-600 (was violet-400)
  "#9D2C5C", // deep magenta (matches compare RouteBox B)
  "#A16207", // amber-700 (was yellow-400)
  "#047857", // emerald-700 (matches compare DeltaChip improved)
] as const;
export default function StatsPage() {
  const { locale, t } = useI18n();
  const [rides, setRides] = useState<RideForStats[]>([]);
  const [loading, setLoading] = useState(true);
  // Debounced: fast loads render content directly, no spinner flash.
  const showLoader = useDelayedLoading(loading);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<RideFilters>(DEFAULT_RIDE_FILTERS);
  const format = useFormat();
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  // Wait for `AuthSync` to populate the access token before paginating
  // `/api/v1/rides` — otherwise the first request races AuthSync and
  // 401s. Same pattern as `useRidesQuery` and `useUserTrips`.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    setLoading(true);
    fetchAllRides()
      .then((all) => {
        if (cancelled) return;
        setRides(all);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          getUserFacingErrorMessage(err, t("Could not load ride history")),
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, authReady]);
  // Surface + curviness breakdown is a server-side per-segment aggregate, so it
  // refetches whenever the active filter changes (unlike the client-aggregated
  // cards). `null` = still loading; the card renders honest empty/error states.
  const [breakdown, setBreakdown] = useState<RideBreakdown | null>(null);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    setBreakdown(null);
    setBreakdownError(null);
    fetchRideBreakdown(filters)
      .then((data) => {
        if (!cancelled) setBreakdown(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBreakdownError(
            getUserFacingErrorMessage(err, t("Could not load the breakdown")),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t, authReady, filters]);
  const filtered = useMemo(() => filterRides(rides, filters), [rides, filters]);
  const totals = useMemo(() => computeAllTimeTotals(filtered), [filtered]);
  // YoY and the "All years" table compare across years, so they ignore the
  // time window — otherwise a windowed filter would collapse both to a single
  // data point. Ride-type still applies.
  const ridesAcrossYears = useMemo(
    () => filterRides(rides, { ...filters, window: "all" }),
    [rides, filters],
  );
  // Year anchors come from the ride-type-filtered set so the calendar/YoY/all
  // years stay in scope — otherwise picking "Trip" could anchor the calendar on
  // a year that only has commutes and render an empty grid.
  const years = useMemo(
    () => availableYears(ridesAcrossYears),
    [ridesAcrossYears],
  );
  const series = useMemo(
    () => computeDistanceSeries(filtered, filters.window, format),
    [filtered, filters.window, format],
  );
  // The heatmap is intentionally decoupled from the time window: it always
  // shows a full calendar-year grid for the latest year with data (the
  // rider's current/last active year). A short window otherwise reshaped it
  // into a handful of oversized cells. It uses the window-independent
  // `ridesAcrossYears` (ride-type still applies) so changing 30d/90d/year/all
  // doesn't redraw it.
  const focusYear = years[0] ?? new Date().getFullYear();
  const calendar = useMemo(
    () => computeCalendarHeatmap(ridesAcrossYears, focusYear),
    [ridesAcrossYears, focusYear],
  );
  const yoyYears = useMemo(() => years.slice(0, 3), [years]);
  const yearlyTotals = useMemo(
    () => computeYearlyTotals(ridesAcrossYears),
    [ridesAcrossYears],
  );
  // Quality trend is the last 12 months regardless of the window (ride-type
  // still applies), computed client-side from `avg_road_quality`.
  const qualityTrend = useMemo(
    () => computeQualityTrend(ridesAcrossYears, format),
    [ridesAcrossYears, format],
  );
  const yoy = useMemo(
    () => computeYearOverYear(ridesAcrossYears, yoyYears, format),
    [ridesAcrossYears, yoyYears, format],
  );
  if (loading) {
    return (
      <div className="mx-auto w-full max-w-page p-4 md:p-7">
        <StatsPageHeader />
        {showLoader && <SkeletonDashboard label={t("Loading rides…")} />}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <StatsPageHeader />
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-700">
          {loadError}
        </div>
      </div>
    );
  }
  if (rides.length === 0) {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <StatsPageHeader />
        <RidesEmptyState
          icon={<BarChart3 size={18} strokeWidth={2} />}
          title={t("No rides recorded yet")}
          body={t(
            "Stats need at least a few rides to draw any conclusions. Start riding with the Tarmoto mobile app to see your numbers here.",
          )}
        />
      </div>
    );
  }
  const windowLabel = statsWindowLabel(filters.window, t);
  // The chart switches from monthly to daily bars on the short windows; the
  // header copy follows so "Distance by day" reads honestly for 90/30 days.
  const isDayView = filters.window === "30d" || filters.window === "90d";
  const chartStamp = isDayView ? t("Distance by day") : t("Distance by month");
  const chartTitle =
    filters.window === "all"
      ? t("Last {count, plural, one {# month} other {# months}}", {
          count: 12,
        })
      : windowLabel;
  // The heatmap is always the focus calendar year (window-independent).
  // A year is an identifier, not a count: localize its digits without
  // inserting a thousands separator ("2026", never "2,026").
  const heatmapLabel = format.number(focusYear, {
    useGrouping: false,
    maximumFractionDigits: 0,
  });
  // `key` is unique per bar, so the axis tick + tooltip both resolve their
  // human labels through this map rather than the (ambiguous) display string.
  const seriesByKey = new Map(series.map((point) => [point.key, point]));
  const tickLabel = (key: string) => seriesByKey.get(key)?.axisLabel ?? key;
  const tooltipLabel = (key: string) =>
    seriesByKey.get(key)?.tooltipLabel ?? key;
  // Charts plot in the rider's display unit so a single card never mixes km and
  // mi. `value` is the converted distance the bars/axis/tooltip read. The
  // format seam already reads the account's unit preference, so `format.units`
  // replaces a separate `unitSystem` store read.
  const toDisplayDistance = (km: number) =>
    format.units === "imperial" ? kmToMiles(km) : km;
  const chartData = series.map((point) => ({
    ...point,
    value: toDisplayDistance(point.distanceKm),
  }));
  // "… total" sums only the displayed buckets (not all-time), so the
  // "Last 12 months" / windowed chart and its total stay in agreement.
  const seriesTotalKm = series.reduce((acc, p) => acc + p.distanceKm, 0);
  const chartTotal = format.splitDistanceKm(seriesTotalKm);
  const distanceUnit = chartTotal.unit;
  const distanceTooltip = (value: TooltipValueType | undefined) => {
    const n =
      typeof value === "number" ? value : Number.parseFloat(String(value));
    return Number.isFinite(n) ? formatDistanceChartValue(n, format) : "—";
  };
  // YoY values are km on the wire; convert each year's series to the display
  // unit so the chart, axis and tooltip match the unit-aware KPIs/table.
  const yoyDisplay = yoy.map((point) => {
    const next = { ...point };
    for (const year of yoyYears) {
      next[String(year)] = toDisplayDistance(Number(point[String(year)] ?? 0));
    }
    return next;
  });
  const formatDistance = (km: number) => format.distanceKm(km);
  const yearColumns: DataTableColumn<YearlyTotal>[] = [
    {
      key: "year",
      label: t("Year"),
      primary: true,
      render: (row) => (
        <span className="font-bold text-ink">
          {format.number(row.year, {
            useGrouping: false,
            maximumFractionDigits: 0,
          })}
        </span>
      ),
    },
    {
      key: "rides",
      label: t("Rides"),
      align: "right",
      numeric: true,
      render: (row) => format.integer(row.rides),
    },
    {
      key: "distance",
      label: t("Distance"),
      align: "right",
      numeric: true,
      render: (row) => formatDistance(row.distanceKm),
    },
    {
      key: "avg",
      label: t("Avg / ride"),
      align: "right",
      numeric: true,
      render: (row) =>
        row.rides > 0 ? formatDistance(row.distanceKm / row.rides) : "—",
    },
  ];
  return (
    <div className="mx-auto w-full max-w-page animate-fade-in space-y-[18px] p-4 md:p-7">
      <StatsPageHeader />

      {/* Filters sit under the heading (matching Ride History) rather than on
          the header row. */}
      <FilterBar filters={filters} onChange={setFilters} />

      <TotalsGrid
        totals={totals}
        windowLabel={formatDisplayLowerCase(windowLabel, locale)}
        format={format}
      />

      <Card padded={false} className="p-[22px]">
        <SectionHeading
          className="mb-[18px]"
          stamp={chartStamp}
          title={chartTitle}
          caption={t("{measurement} total", {
            measurement: formatSplitValueUnit(chartTotal),
          })}
        />
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(14, 14, 16, 0.10)"
              />
              <XAxis
                dataKey="key"
                stroke="rgba(14, 14, 16, 0.42)"
                fontSize={12}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={16}
                tickFormatter={(value: string) => tickLabel(value)}
              />
              <YAxis
                stroke="rgba(14, 14, 16, 0.42)"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(value: number) => format.integer(value)}
              />
              <Tooltip
                contentStyle={{
                  background: "#F5EFE6",
                  border: "1px solid rgba(14, 14, 16, 0.10)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#0E0E10" }}
                labelFormatter={(label) => tooltipLabel(String(label))}
                formatter={(value) => [distanceTooltip(value), t("Distance")]}
              />
              {/* Dark brand-orange #D44F00 ≈ 4.3:1 on cream; canonical
                  #FF6A1A is only ~2.5:1 and fails the WCAG 3:1
                  graphic-element bar for the monthly distance bars. */}
              <Bar dataKey="value" fill="#D44F00" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-[18px] md:grid-cols-2">
        <SurfaceBreakdownCard
          breakdown={breakdown}
          error={breakdownError}
          format={format}
        />
        <CurvinessMixCard
          breakdown={breakdown}
          error={breakdownError}
          format={format}
        />
      </div>

      {/* The card charts nothing but the killed dimension. Note this still
          matters after the `advanced_analytics` route gate (#1167): that locks
          the route for non-entitled riders, but an ENTITLED one would keep
          seeing a quality trend the operator had killed. */}
      {qualityOverlayEnabled ? (
        <QualityTrendCard points={qualityTrend} format={format} />
      ) : null}

      <Card padded={false} className="p-[22px]">
        <SectionHeading
          className="mb-[18px]"
          stamp={`${t("Calendar")} · ${heatmapLabel}`}
          title={t("Riding days")}
          caption={t("brighter = longer ride")}
        />
        <CalendarHeatmap days={calendar} label={heatmapLabel} format={format} />
      </Card>

      {yoyYears.length >= 2 && (
        <Card padded={false} className="p-[22px]">
          <SectionHeading
            className="mb-[18px]"
            stamp={t("Year-over-year")}
            title={t(
              "Monthly distance · {count, plural, one {last # year} other {last # years}}",
              { count: yoyYears.length },
            )}
            caption={t("{unit} / month", { unit: distanceUnit })}
          />
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={yoyDisplay}
                margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(14, 14, 16, 0.10)"
                />
                <XAxis
                  dataKey="monthLabel"
                  stroke="rgba(14, 14, 16, 0.42)"
                  fontSize={12}
                  tickLine={false}
                />
                <YAxis
                  stroke="rgba(14, 14, 16, 0.42)"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  tickFormatter={(value: number) => format.integer(value)}
                />
                <Tooltip
                  contentStyle={{
                    background: "#F5EFE6",
                    border: "1px solid rgba(14, 14, 16, 0.10)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#0E0E10" }}
                  formatter={distanceTooltip}
                />
                <Legend
                  wrapperStyle={{
                    fontSize: 12,
                    color: "rgba(14, 14, 16, 0.62)",
                  }}
                  iconType="circle"
                />
                {yoyYears.map((year, index) => (
                  <Line
                    key={year}
                    type="monotone"
                    dataKey={String(year)}
                    stroke={
                      YOY_COLORS[index % YOY_COLORS.length] ?? YOY_COLORS[0]
                    }
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {yearlyTotals.length > 0 && (
        <DataTable<YearlyTotal>
          ariaLabel={t("Distance by year")}
          showCaret={false}
          header={
            <SectionHeading
              className="px-5 pb-4 pt-5"
              stamp={t("Annual totals")}
              title={t("All years")}
            />
          }
          columns={yearColumns}
          rows={yearlyTotals.slice().reverse()}
          rowKey={(row) => String(row.year)}
        />
      )}
    </div>
  );
}
// Spec-aligned page header shared across every render branch
// (loading / error / empty / populated). Stamp + 18 px BarChart3
// glyph + 32 px `Statistics` title + sub copy match the v2
// design's `Statistics` chrome. Kept as a tiny local helper rather
// than going through `RidesScaffold` because the rides tab strip
// is intentionally hidden on the stats route (the wider `RIDES`
// sidebar item ships `Statistics` as a sibling top-level page,
// not a sub-section).
function StatsPageHeader() {
  const t = useTranslation();
  // The subtitle NAMES the trend card, so it goes with it — advertising
  // "road-quality trends" over a page that no longer has them is the same
  // mistake as leaving a map legend up for layers that were removed (#1201).
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  return (
    <PageHeader
      stamp={t("Statistics")}
      icon={<BarChart3 size={18} strokeWidth={2} />}
      title={t("Statistics")}
      sub={
        qualityOverlayEnabled
          ? t(
              "Yearly distance, road-quality trends, and ride breakdown by surface and curviness.",
            )
          : t("Yearly distance and ride breakdown by surface and curviness.")
      }
    />
  );
}

interface FilterBarProps {
  filters: RideFilters;
  onChange: (filters: RideFilters) => void;
}
const WINDOW_OPTIONS: { value: StatsWindow }[] = STATS_WINDOWS;
// Filters mirror the Ride History controls: a time-window pill group + a
// ride-type group, both the shared `SegmentedControl`.
function FilterBar({ filters, onChange }: FilterBarProps) {
  const t = useTranslation();
  // Space the two toggle groups apart on tablet/compact so they use the row
  // width; right-align them together at lg+ where there's room.
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 lg:justify-end">
      <SegmentedControl
        ariaLabel={t("Time window")}
        value={filters.window}
        onChange={(window) => onChange({ ...filters, window })}
        options={WINDOW_OPTIONS.map((opt) => ({
          ...opt,
          label: statsWindowLabel(opt.value, t),
        }))}
      />
      <SegmentedControl
        ariaLabel={t("Ride type filter")}
        value={filters.rideType}
        onChange={(next) =>
          onChange({
            ...filters,
            rideType: next === "all" ? "all" : (next as RideType),
          })
        }
        options={RIDE_TYPE_OPTIONS.map((opt) => ({
          ...opt,
          label: t(opt.label),
        }))}
      />
    </div>
  );
}
interface TotalsGridProps {
  totals: ReturnType<typeof computeAllTimeTotals>;
  /** Active window label (e.g. "all time") shown as the lead KPI's delta. */
  windowLabel: string;
  format: Formatters;
}
// KPI bricks (§12) — the shared `MetricTile`. Distance leads on an ink tile
// with the accent number; the remaining four use the default cream tile.
// Distance values are unit-aware (km/mi) so imperial users see honest numbers.
function TotalsGrid({ totals, windowLabel, format }: TotalsGridProps) {
  const t = useTranslation();
  const distance = format.splitDistanceKm(totals.totalDistanceKm);
  const avgPerRide = format.splitDistanceKm(totals.avgRideDistanceKm);
  const totalHours = format.splitUnit(totals.totalHours, "hour", {
    unitDisplay: "narrow",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const tiles: MetricTileProps[] = [
    {
      label: t("Total distance"),
      value: distance.value,
      unit: distance.unit,
      unitPosition: distance.unitPosition,
      variant: "ink",
      accentNumber: true,
      delta: windowLabel,
    },
    {
      label: t("Total rides"),
      value: totals.totalRides,
      formatValue: format.integer,
    },
    {
      label: t("Total hours"),
      value: totalHours.value,
      unit: totalHours.unit,
      unitPosition: totalHours.unitPosition,
    },
    {
      label: t("Riding days"),
      value: totals.ridingDays,
      formatValue: format.integer,
    },
    {
      label: t("Avg per ride"),
      value: totals.totalRides === 0 ? "0" : avgPerRide.value,
      unit: avgPerRide.unit,
      unitPosition: avgPerRide.unitPosition,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-[14px] md:grid-cols-5">
      {tiles.map((tile) => (
        <MetricTile key={tile.label} {...tile} />
      ))}
    </div>
  );
}
interface SectionHeadingProps {
  /** Mono uppercase eyebrow, e.g. "Year-over-year". */
  stamp: string;
  /** Big Space Grotesk title, e.g. "Monthly distance · last 3 years". */
  title: string;
  /** Optional right-aligned mono caption, e.g. "km / month". */
  caption?: React.ReactNode;
  className?: string;
}
// The single card-header pattern (§ design): mono stamp eyebrow → 20px bold
// title, with an optional right-aligned mono caption. Shared by the distance
// chart, calendar heatmap, year-over-year and all-years cards so every section
// reads with the same chrome.
function SectionHeading({
  stamp,
  title,
  caption,
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={`flex flex-wrap items-end justify-between gap-4 ${className ?? ""}`}
    >
      <div>
        <Stamp>{stamp}</Stamp>
        <div className="mt-1 text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
          {title}
        </div>
      </div>
      {caption && (
        <Mono className="shrink-0 text-[11px] text-fg-dim">{caption}</Mono>
      )}
    </div>
  );
}

// Surface swatches keyed by the canonical `SURFACE_TYPES`. Hex values match the
// v2 design's surface legend; kept inline (like the chart colours) so SSR and
// CSS render identically.
const SURFACE_COLORS: Record<string, string> = {
  asphalt: "#26262B",
  concrete: "#9A958C",
  cobblestone: "#A971D6",
  gravel: "#D2A06A",
  dirt: "#7E5A3C",
  unknown: "#C7C0B2",
};
const surfaceColor = (key: string) => SURFACE_COLORS[key] ?? "#C7C0B2";
// Light track behind the curviness/quality bars (paper-on-cream).
const TRACK_COLOR = "#E7DECF";

interface BreakdownBodyProps {
  breakdown: RideBreakdown | null;
  error: string | null;
  slices: RideBreakdownSlice[] | undefined;
  emptyLabel: string;
  children: (slices: RideBreakdownSlice[]) => React.ReactNode;
}
// Shared loading / error / empty gate for the two breakdown cards so each
// renders an honest state instead of an all-zero chart.
function BreakdownBody({
  breakdown,
  error,
  slices,
  emptyLabel,
  children,
}: BreakdownBodyProps) {
  const t = useTranslation();
  if (error) {
    return <p className="text-sm text-fg-dim">{error}</p>;
  }
  if (!breakdown) {
    return (
      <div className="flex items-center gap-2 text-sm text-fg-dim">
        <Loader2 size={14} className="animate-spin" />
        {t("Loading…")}
      </div>
    );
  }
  if (!slices || slices.length === 0) {
    return <p className="text-sm text-fg-dim">{emptyLabel}</p>;
  }
  return <>{children(slices)}</>;
}

interface BreakdownCardProps {
  breakdown: RideBreakdown | null;
  error: string | null;
  format: Formatters;
}
function SurfaceBreakdownCard({
  breakdown,
  error,
  format,
}: BreakdownCardProps) {
  const t = useTranslation();
  return (
    <Card padded={false} className="p-[22px]">
      <SectionHeading
        className="mb-[18px]"
        stamp={t("Surface breakdown")}
        title={t("By distance ridden")}
      />
      <BreakdownBody
        breakdown={breakdown}
        error={error}
        slices={breakdown?.surface}
        emptyLabel={t(
          "No road surfaces yet — needs rides matched to known roads.",
        )}
      >
        {(slices) => (
          <>
            <div className="flex h-3 overflow-hidden rounded-full">
              {slices.map((s) => (
                <div
                  key={s.key}
                  style={{
                    width: `${s.pct}%`,
                    backgroundColor: surfaceColor(s.key),
                  }}
                  title={t("{label} · {percent}", {
                    label: t(rideBreakdownLabel(s.key)),
                    percent: format.number(s.pct / 100, {
                      style: "percent",
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    }),
                  })}
                />
              ))}
            </div>
            <ul className="mt-4 space-y-2.5">
              {slices.map((s) => (
                <li
                  key={s.key}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="flex items-center gap-2.5">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: surfaceColor(s.key) }}
                    />
                    <span className="text-ink">
                      {t(rideBreakdownLabel(s.key))}
                    </span>
                  </span>
                  <Mono className="text-fg-dim">
                    {format.number(s.pct / 100, {
                      style: "percent",
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    })}
                  </Mono>
                </li>
              ))}
            </ul>
          </>
        )}
      </BreakdownBody>
    </Card>
  );
}

function CurvinessMixCard({ breakdown, error, format }: BreakdownCardProps) {
  const t = useTranslation();
  return (
    <Card padded={false} className="p-[22px]">
      <SectionHeading
        className="mb-[18px]"
        stamp={t("Curviness mix")}
        title={t("How twisty was your year")}
      />
      <BreakdownBody
        breakdown={breakdown}
        error={error}
        slices={breakdown?.curviness}
        emptyLabel={t(
          "No curviness data yet — needs rides matched to known roads.",
        )}
      >
        {(slices) => {
          // Accent the single dominant band; ties default to none so we never
          // light up two bars as "the" peak.
          const top = slices.reduce(
            (best, s) => (s.pct > best ? s.pct : best),
            0,
          );
          const peakCount = slices.filter((s) => s.pct === top).length;
          return (
            <div className="space-y-3">
              {slices.map((s) => {
                const isPeak = top > 0 && s.pct === top && peakCount === 1;
                return (
                  <div key={s.key}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-ink">
                        {t(rideBreakdownLabel(s.key))}
                      </span>
                      <Mono className="text-fg-dim">
                        {format.number(s.pct / 100, {
                          style: "percent",
                          minimumFractionDigits: 1,
                          maximumFractionDigits: 1,
                        })}
                      </Mono>
                    </div>
                    <div
                      className="mt-1.5 h-2 overflow-hidden rounded-full"
                      style={{ backgroundColor: TRACK_COLOR }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${s.pct}%`,
                          backgroundColor: isPeak ? "#D44F00" : "#26262B",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          );
        }}
      </BreakdownBody>
    </Card>
  );
}

function QualityTrendCard({
  points,
  format,
}: {
  points: QualityPoint[];
  format: Formatters;
}) {
  const t = useTranslation();
  const hasData = points.some((p) => p.avgQuality !== null);
  const byKey = new Map(points.map((p) => [p.key, p]));
  return (
    <Card padded={false} className="p-[22px]">
      <SectionHeading
        className="mb-[18px]"
        stamp={t(
          "Quality trend · {count, plural, one {# month} other {# months}}",
          { count: 12 },
        )}
        title={t("Average road quality")}
        caption={t("{min}–{max} scale", {
          min: format.integer(0),
          max: format.integer(5),
        })}
      />
      {hasData ? (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={points}
              margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(14, 14, 16, 0.10)"
              />
              <XAxis
                dataKey="key"
                stroke="rgba(14, 14, 16, 0.42)"
                fontSize={12}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={16}
                tickFormatter={(value: string) =>
                  byKey.get(value)?.axisLabel ?? value
                }
              />
              <YAxis
                stroke="rgba(14, 14, 16, 0.42)"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                width={32}
                domain={[0, 5]}
                ticks={[0, 1, 2, 3, 4, 5]}
                tickFormatter={(value: number) => format.integer(value)}
              />
              <Tooltip
                contentStyle={{
                  background: "#F5EFE6",
                  border: "1px solid rgba(14, 14, 16, 0.10)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#0E0E10" }}
                labelFormatter={(label) =>
                  byKey.get(String(label))?.tooltipLabel ?? String(label)
                }
                formatter={(value) => [
                  typeof value === "number" ? format.decimal(value, 2) : "—",
                  t("Avg quality"),
                ]}
              />
              <Line
                type="monotone"
                dataKey="avgQuality"
                stroke="#D44F00"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-sm text-fg-dim">
          {t(
            "No scored rides in the last {count, plural, one {# month} other {# months}}.",
            { count: 12 },
          )}
        </p>
      )}
    </Card>
  );
}
interface CalendarHeatmapProps {
  days: {
    date: string;
    distanceKm: number;
    rides: number;
  }[];
  /** Period shown (year or window label) — used only for the a11y label. */
  label: string;
  format: Formatters;
}
function CalendarHeatmap({ days, label, format }: CalendarHeatmapProps) {
  const t = useTranslation();
  // Find the max so cell intensity scales relative to this filtered view
  // rather than to a hard-coded ceiling that would wash out short rides.
  const maxDistance = days.reduce((acc, d) => Math.max(acc, d.distanceKm), 0);
  // Pad the start so the first column begins on Sunday (column = day of week).
  // Derive the weekday from the first day shown so the grid aligns for both the
  // calendar-year and rolling-window views.
  const firstDay = (() => {
    const first = days[0]?.date;
    if (!first) return 0;
    const [y, m, d] = first.split("-").map(Number);
    return new Date(y!, m! - 1, d!).getDay();
  })();
  type Cell = {
    date: string;
    distanceKm: number;
    rides: number;
  } | null;
  const cells: Cell[] = [
    ...Array.from<Cell>({ length: firstDay }).fill(null),
    ...days,
  ];
  // Flexible week columns (one per ~7 days) sized at `1fr` so the grid stretches
  // to the full card width instead of leaving the fixed-width strip + empty
  // gutter the old 12px columns produced. The container's aspect ratio keeps the
  // day cells square as they grow.
  const weeks = Math.ceil(cells.length / 7);
  return (
    <div className="space-y-3">
      <div
        className="grid gap-[3px]"
        style={{
          gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))`,
          gridTemplateRows: "repeat(7, 1fr)",
          gridAutoFlow: "column",
          aspectRatio: `${weeks} / 7`,
        }}
        role="img"
        aria-label={t("Riding calendar — {label}", { label })}
      >
        {cells.map((cell, index) => (
          <CalendarCell
            key={index}
            cell={cell}
            maxDistance={maxDistance}
            format={format}
          />
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 text-xs text-fg-dim">
        <span>{t("Less")}</span>
        {[0.05, 0.25, 0.5, 0.85].map((step) => (
          <span
            key={step}
            className="w-3 h-3 rounded-sm"
            style={{ backgroundColor: heatColor(step) }}
          />
        ))}
        <span>{t("More")}</span>
      </div>
    </div>
  );
}
interface CalendarCellProps {
  cell: {
    date: string;
    distanceKm: number;
    rides: number;
  } | null;
  maxDistance: number;
  format: Formatters;
}
function CalendarCell({ cell, maxDistance, format }: CalendarCellProps) {
  const t = useTranslation();
  if (!cell) return <span aria-hidden className="block" />;
  const intensity =
    maxDistance > 0 && cell.distanceKm > 0 ? cell.distanceKm / maxDistance : 0;
  // `cell.date` is a date-only "YYYY-MM-DD" string — `calendarDate` keeps it
  // UTC-pinned so the rendered day never shifts with the viewer's timezone.
  const dayLabel = format.calendarDate(cell.date);
  const title =
    cell.rides === 0
      ? t("{date}: no rides", { date: dayLabel })
      : t("{date}: {count, plural, one {# ride} other {# rides}}, {distance}", {
          date: dayLabel,
          count: cell.rides,
          distance: format.distanceKm(cell.distanceKm),
        });
  // Ridden cells get a 1px ink-line outline as a secondary cue alongside
  // the fill intensity. Empty cells stay borderless so they read as the
  // paper baseline against the surrounding cream card.
  const isRidden = cell.rides > 0;
  return (
    <span
      title={title}
      className={`block rounded-sm ${isRidden ? "border border-line" : ""}`}
      style={{ backgroundColor: heatColor(intensity) }}
    />
  );
}
function heatColor(intensity: number): string {
  // Empty cell: paper (visible as "no rides" against the surrounding
  // cream card; ridden cells layer a 1px ink-line outline on top of
  // the fill so the binary "any rides" cue doesn't depend on fill
  // contrast alone).
  if (intensity <= 0) return "#EDE6DA";
  // Brand-orange heat ramp tuned so every active stop clears WCAG 3:1
  // against bg-cream — the brightest low-activity cell is still
  // visibly distinct from the paper "no rides" baseline, even before
  // the outline cue kicks in. Ladder ascends from a clean orange
  // (~3:1) through orange-700 (~4.5:1) and deep brand orange (~7:1)
  // up to a near-brown peak (~10:1) for the highest-distance days.
  // Hex stops keep SSR + CSS identical and dodge cross-browser alpha
  // surprises.
  const stops: {
    stop: number;
    color: string;
  }[] = [
    { stop: 0.15, color: "#E08A4F" }, // light brand orange (~3.0:1)
    { stop: 0.4, color: "#B85A1C" }, // mid brand orange (~4.5:1)
    { stop: 0.7, color: "#7F3300" }, // deep brand orange (~7:1)
    { stop: 1, color: "#4A1E00" }, // very deep brown (~10:1)
  ];
  for (const s of stops) {
    if (intensity <= s.stop) return s.color;
  }
  return stops[stops.length - 1]!.color;
}
