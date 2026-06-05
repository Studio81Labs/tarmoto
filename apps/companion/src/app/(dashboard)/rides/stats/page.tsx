"use client";
import { t } from "@/i18n";
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
import { BarChart3, CalendarDays, Loader2, TrendingUp } from "lucide-react";
import {
  Card,
  DataTable,
  MetricTile,
  Mono,
  PageHeader,
  SegmentedControl,
  Stamp,
  type DataTableColumn,
  type MetricTileProps,
  type SegmentedOption,
} from "@tarmoto/ui";
import { RidesEmptyState } from "../_RidesEmptyState";
import { fetchAllRides } from "@/lib/rides-fetch";
import { useAuthStore } from "@/stores/auth";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { usePreferencesStore } from "@/stores/preferences";
import { splitFormattedDistance } from "@/lib/utils";
import {
  availableYears,
  computeAllTimeTotals,
  computeCalendarHeatmap,
  computeRollingMonthly,
  computeYearOverYear,
  computeYearlyTotals,
  DEFAULT_RIDE_FILTERS,
  filterRides,
  STATS_WINDOWS,
  type RideForStats,
  type RideFilters,
  type RideType,
  type StatsWindow,
  type YearlyTotal,
} from "@/lib/ride-stats";
const RIDE_TYPE_OPTIONS: SegmentedOption<string>[] = [
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
function formatDistanceTooltipValue(value: TooltipValueType | undefined) {
  const numeric =
    typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(numeric) ? `${numeric.toFixed(0)} km` : "—";
}
export default function StatsPage() {
  const [rides, setRides] = useState<RideForStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<RideFilters>(DEFAULT_RIDE_FILTERS);
  const { format } = useNumberFormat();
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
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
      .catch((err: Error) => {
        if (cancelled) return;
        setLoadError(err.message || "Could not load ride history");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady]);
  const years = useMemo(() => availableYears(rides), [rides]);
  const filtered = useMemo(() => filterRides(rides, filters), [rides, filters]);
  const totals = useMemo(() => computeAllTimeTotals(filtered), [filtered]);
  // The rolling distance chart shows the last 12 calendar months of the
  // filtered rides. The heatmap still needs one concrete year: anchor on the
  // current year for windowed filters, or the latest year with data for "all".
  const focusYear =
    filters.window === "all"
      ? (years[0] ?? new Date().getFullYear())
      : new Date().getFullYear();
  const monthly = useMemo(() => computeRollingMonthly(filtered), [filtered]);
  const calendar = useMemo(
    () => computeCalendarHeatmap(filtered, focusYear),
    [filtered, focusYear],
  );
  const yoyYears = useMemo(() => years.slice(0, 3), [years]);
  // YoY and the "All years" table compare across years, so they ignore the
  // time window — otherwise a windowed filter would collapse both to a single
  // data point. Ride-type still applies.
  const ridesAcrossYears = useMemo(
    () => filterRides(rides, { ...filters, window: "all" }),
    [rides, filters],
  );
  const yearlyTotals = useMemo(
    () => computeYearlyTotals(ridesAcrossYears),
    [ridesAcrossYears],
  );
  const yoy = useMemo(
    () => computeYearOverYear(ridesAcrossYears, yoyYears),
    [ridesAcrossYears, yoyYears],
  );
  if (loading) {
    return (
      <div className="mx-auto w-full max-w-page p-7">
        <StatsPageHeader />
        <div className="flex items-center gap-2 text-fg-dim">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading rides\u2026 ")}
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-7">
        <StatsPageHeader />
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
          {loadError}
        </div>
      </div>
    );
  }
  if (rides.length === 0) {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-7">
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
  const windowLabel =
    STATS_WINDOWS.find((w) => w.value === filters.window)?.label ?? "All time";
  const monthlyTitle =
    filters.window === "all" ? "Last 12 months" : windowLabel;
  const totalDistance = splitFormattedDistance(
    totals.totalDistanceKm,
    unitSystem,
  );
  const formatDistance = (km: number) => {
    const d = splitFormattedDistance(km, unitSystem);
    return `${format(d.value)} ${d.unit.toLowerCase()}`;
  };
  const yearColumns: DataTableColumn<YearlyTotal>[] = [
    {
      key: "year",
      label: t("Year"),
      primary: true,
      render: (row) => <span className="font-bold text-ink">{row.year}</span>,
    },
    {
      key: "rides",
      label: t("Rides"),
      align: "right",
      numeric: true,
      render: (row) => format(row.rides),
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
      <StatsPageHeader
        right={<FilterBar filters={filters} onChange={setFilters} />}
      />

      <TotalsGrid
        totals={totals}
        windowLabel={windowLabel.toLowerCase()}
        unitSystem={unitSystem}
        format={format}
      />

      <Card padded={false} className="p-[22px]">
        <div className="mb-[18px] flex items-end justify-between gap-4">
          <div>
            <Stamp>{t("Distance by month")}</Stamp>
            <div className="mt-1 text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
              {monthlyTitle}
            </div>
          </div>
          <Mono className="text-[11px] text-fg-dim">
            {format(totalDistance.value)} {totalDistance.unit.toLowerCase()}{" "}
            {t("total")}
          </Mono>
        </div>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={monthly}
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
                tickFormatter={(value: number) => `${Math.round(value)}`}
              />
              <Tooltip
                contentStyle={{
                  background: "#F5EFE6",
                  border: "1px solid rgba(14, 14, 16, 0.10)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#0E0E10" }}
                formatter={(value) => [
                  formatDistanceTooltipValue(value),
                  "Distance",
                ]}
              />
              {/* Dark brand-orange #D44F00 ≈ 4.3:1 on cream; canonical
                  #FF6A1A is only ~2.5:1 and fails the WCAG 3:1
                  graphic-element bar for the monthly distance bars. */}
              <Bar dataKey="distanceKm" fill="#D44F00" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card padded={false} className="p-5">
        <ChartHeader
          icon={<CalendarDays size={16} />}
          title={`Calendar heatmap — ${focusYear}`}
          subtitle="Each cell is one day. Brighter = longer ride."
        />
        <CalendarHeatmap days={calendar} year={focusYear} />
      </Card>

      {yoyYears.length >= 2 && (
        <Card padded={false} className="p-5">
          <ChartHeader
            icon={<TrendingUp size={16} />}
            title={t("Year-over-year")}
            subtitle={`Monthly distance, last ${yoyYears.length} years.`}
          />
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={yoy}
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
                  tickFormatter={(value: number) => `${Math.round(value)}`}
                />
                <Tooltip
                  contentStyle={{
                    background: "#F5EFE6",
                    border: "1px solid rgba(14, 14, 16, 0.10)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#0E0E10" }}
                  formatter={formatDistanceTooltipValue}
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
                    stroke={YOY_COLORS[index % YOY_COLORS.length]}
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
            <div className="px-5 pt-5">
              <ChartHeader
                icon={<BarChart3 size={16} />}
                title={t("All years")}
                subtitle={t("Total distance per calendar year.")}
              />
            </div>
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
function StatsPageHeader({ right }: { right?: React.ReactNode }) {
  return (
    <PageHeader
      stamp={t("Statistics")}
      icon={<BarChart3 size={18} strokeWidth={2} />}
      title={t("Statistics")}
      sub={t(
        "Yearly distance, road-quality trends, and ride breakdown by surface and curviness.",
      )}
      right={right}
    />
  );
}

interface FilterBarProps {
  filters: RideFilters;
  onChange: (filters: RideFilters) => void;
}
const WINDOW_OPTIONS: SegmentedOption<StatsWindow>[] = STATS_WINDOWS.map(
  (w) => ({
    value: w.value,
    label: w.label,
  }),
);
// Filters mirror the Ride History controls: a time-window pill group + a
// ride-type group, both the shared `SegmentedControl`.
function FilterBar({ filters, onChange }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <SegmentedControl
        ariaLabel={t("Time window")}
        value={filters.window}
        onChange={(window) => onChange({ ...filters, window })}
        options={WINDOW_OPTIONS}
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
        options={RIDE_TYPE_OPTIONS}
      />
    </div>
  );
}
interface TotalsGridProps {
  totals: ReturnType<typeof computeAllTimeTotals>;
  /** Active window label (e.g. "all time") shown as the lead KPI's delta. */
  windowLabel: string;
  unitSystem: Parameters<typeof splitFormattedDistance>[1];
  format: (value: number) => string;
}
// KPI bricks (§12) — the shared `MetricTile`. Distance leads on an ink tile
// with the accent number; the remaining four use the default cream tile.
// Distance values are unit-aware (km/mi) so imperial users see honest numbers.
function TotalsGrid({
  totals,
  windowLabel,
  unitSystem,
  format,
}: TotalsGridProps) {
  const distance = splitFormattedDistance(totals.totalDistanceKm, unitSystem);
  const avgPerRide = splitFormattedDistance(
    totals.avgRideDistanceKm,
    unitSystem,
  );
  const tiles: MetricTileProps[] = [
    {
      label: t("Total distance"),
      value: distance.value,
      unit: distance.unit,
      formatValue: format,
      variant: "ink",
      accentNumber: true,
      delta: windowLabel,
    },
    {
      label: t("Total rides"),
      value: totals.totalRides,
      formatValue: format,
    },
    {
      label: t("Total hours"),
      value: totals.totalHours.toFixed(1),
      unit: "h",
    },
    {
      label: t("Riding days"),
      value: totals.ridingDays,
      formatValue: format,
    },
    {
      label: t("Avg per ride"),
      value: totals.totalRides === 0 ? "0" : avgPerRide.value,
      unit: avgPerRide.unit,
      formatValue: format,
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
interface ChartHeaderProps {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}
function ChartHeader({ icon, title, subtitle }: ChartHeaderProps) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 text-ink">
        <span className="text-accent">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {subtitle && <p className="mt-0.5 text-xs text-fg-dim">{subtitle}</p>}
    </div>
  );
}
interface CalendarHeatmapProps {
  days: {
    date: string;
    distanceKm: number;
    rides: number;
  }[];
  year: number;
}
function CalendarHeatmap({ days, year }: CalendarHeatmapProps) {
  // Find the max so cell intensity scales relative to this filtered view
  // rather than to a hard-coded ceiling that would wash out short rides.
  const maxDistance = days.reduce((acc, d) => Math.max(acc, d.distanceKm), 0);
  // Pad the start so the first column begins on Sunday (column = day of week).
  const firstDay = new Date(year, 0, 1).getDay();
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
        aria-label={`Riding calendar for ${year}`}
      >
        {cells.map((cell, index) => (
          <CalendarCell key={index} cell={cell} maxDistance={maxDistance} />
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
}
function CalendarCell({ cell, maxDistance }: CalendarCellProps) {
  if (!cell) return <span aria-hidden className="block" />;
  const intensity =
    maxDistance > 0 && cell.distanceKm > 0 ? cell.distanceKm / maxDistance : 0;
  const title =
    cell.rides === 0
      ? `${cell.date}: no rides`
      : `${cell.date}: ${cell.rides} ride${cell.rides === 1 ? "" : "s"}, ${cell.distanceKm.toFixed(0)} km`;
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
