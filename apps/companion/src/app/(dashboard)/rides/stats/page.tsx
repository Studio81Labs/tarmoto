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
import { PageHeader } from "@/components/PageHeader";
import { fetchAllRides } from "@/lib/rides-fetch";
import { useAuthStore } from "@/stores/auth";
import {
  availableYears,
  computeAllTimeTotals,
  computeCalendarHeatmap,
  computeMonthlyDistance,
  computeYearOverYear,
  computeYearlyTotals,
  DEFAULT_RIDE_FILTERS,
  filterRides,
  isRideType,
  RIDE_TYPES,
  type RideForStats,
  type RideFilters,
  type RideType,
} from "@/lib/ride-stats";
const RIDE_TYPE_LABELS: Record<RideType, string> = {
  free: "Free ride",
  commute: "Commute",
  trip: "Trip",
  tracked: "Tracked",
};
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
  // The monthly + heatmap charts always need a single concrete year. When the
  // year filter is "all" we anchor on the latest year that has data so the
  // charts stay populated instead of going blank.
  const focusYear =
    filters.year !== "all"
      ? filters.year
      : (years[0] ?? new Date().getFullYear());
  const monthly = useMemo(
    () => computeMonthlyDistance(filtered, focusYear),
    [filtered, focusYear],
  );
  const calendar = useMemo(
    () => computeCalendarHeatmap(filtered, focusYear),
    [filtered, focusYear],
  );
  const yoyYears = useMemo(() => years.slice(0, 3), [years]);
  // YoY and the "All years" table compare across years, so they ignore the
  // year filter — otherwise selecting a single year would collapse both to a
  // single data point.
  const ridesAcrossYears = useMemo(
    () => filterRides(rides, { ...filters, year: "all" }),
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
      <div className="p-6 max-w-page mx-auto">
        <PageHeader
          icon={BarChart3}
          title={t("Statistics")}
          subtitle={t(
            "Yearly distance, road-quality trends, and ride breakdown by surface and curviness.",
          )}
        />
        <div className="flex items-center gap-2 text-fg-dim">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading rides\u2026 ")}
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="p-6 max-w-page mx-auto animate-fade-in">
        <PageHeader
          icon={BarChart3}
          title={t("Statistics")}
          subtitle={t(
            "Yearly distance, road-quality trends, and ride breakdown by surface and curviness.",
          )}
        />
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
          {loadError}
        </div>
      </div>
    );
  }
  if (rides.length === 0) {
    return (
      <div className="p-6 max-w-page mx-auto animate-fade-in">
        <PageHeader
          icon={BarChart3}
          title={t("Statistics")}
          subtitle={t(
            "Yearly distance, road-quality trends, and ride breakdown by surface and curviness.",
          )}
        />
        <div className="rounded-2xl bg-cream border border-line p-16 text-center">
          <BarChart3 size={48} className="mx-auto text-fg-mute mb-4" />
          <p className="text-fg-dim text-lg mb-2">
            {t("No rides recorded yet")}
          </p>
          <p className="text-fg-dim text-sm">
            {t(
              "Start riding with the Tarmoto mobile app to see your stats here. ",
            )}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="p-6 max-w-page mx-auto animate-fade-in space-y-8">
      <PageHeader
        icon={BarChart3}
        title={t("Statistics")}
        subtitle={t(
          "Yearly distance, road-quality trends, and ride breakdown by surface and curviness.",
        )}
        action={
          <FilterBar filters={filters} years={years} onChange={setFilters} />
        }
      />

      <TotalsGrid totals={totals} />

      <section className="rounded-2xl bg-cream border border-line p-5">
        <ChartHeader
          icon={<BarChart3 size={16} />}
          title={`Monthly distance — ${focusYear}`}
          subtitle="Distance ridden each month."
        />
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
      </section>

      <section className="rounded-2xl bg-cream border border-line p-5">
        <ChartHeader
          icon={<CalendarDays size={16} />}
          title={`Calendar heatmap — ${focusYear}`}
          subtitle="Each cell is one day. Brighter = longer ride."
        />
        <CalendarHeatmap days={calendar} year={focusYear} />
      </section>

      {yoyYears.length >= 2 && (
        <section className="rounded-2xl bg-cream border border-line p-5">
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
        </section>
      )}

      {yearlyTotals.length > 0 && (
        <section className="rounded-2xl bg-cream border border-line p-5">
          <ChartHeader
            icon={<BarChart3 size={16} />}
            title={t("All years")}
            subtitle="Total distance per calendar year."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-fg-dim">
                  <th className="py-2 pr-4 font-semibold">{t("Year")}</th>
                  <th className="py-2 pr-4 font-semibold text-right">
                    {t("Rides")}
                  </th>
                  <th className="py-2 pr-4 font-semibold text-right">
                    {t("Distance ")}
                  </th>
                  <th className="py-2 font-semibold text-right">
                    {t("Avg / ride")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {yearlyTotals
                  .slice()
                  .reverse()
                  .map((row) => (
                    <tr key={row.year} className="text-ink">
                      <td className="py-2 pr-4 font-medium">{row.year}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.rides}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.distanceKm.toFixed(0)}
                        {t("km ")}
                      </td>
                      <td className="py-2 text-right tabular-nums text-fg-dim">
                        {row.rides > 0
                          ? `${(row.distanceKm / row.rides).toFixed(0)} km`
                          : "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
interface FilterBarProps {
  filters: RideFilters;
  years: number[];
  onChange: (filters: RideFilters) => void;
}
function FilterBar({ filters, years, onChange }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSelect
        label="Year"
        value={filters.year === "all" ? "all" : String(filters.year)}
        onChange={(value) =>
          onChange({
            ...filters,
            year: value === "all" ? "all" : Number(value),
          })
        }
        options={[
          { value: "all", label: "All years" },
          ...years.map((y) => ({ value: String(y), label: String(y) })),
        ]}
      />
      <FilterSelect
        label="Ride type"
        value={filters.rideType}
        onChange={(value) =>
          onChange({
            ...filters,
            rideType: value === "all" || !isRideType(value) ? "all" : value,
          })
        }
        options={[
          { value: "all", label: "All types" },
          ...RIDE_TYPES.map((rideType) => ({
            value: rideType,
            label: RIDE_TYPE_LABELS[rideType],
          })),
        ]}
      />
    </div>
  );
}
interface FilterSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: {
    value: string;
    label: string;
  }[];
}
function FilterSelect({ label, value, onChange, options }: FilterSelectProps) {
  return (
    <label className="flex items-center gap-2 text-xs text-fg-dim">
      <span className="uppercase tracking-wider font-semibold">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-paper border border-line-strong rounded-lg px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:border-ink"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
interface TotalsGridProps {
  totals: ReturnType<typeof computeAllTimeTotals>;
}
function TotalsGrid({ totals }: TotalsGridProps) {
  const cards = [
    {
      label: "Total distance",
      value: totals.totalDistanceKm.toFixed(0),
      unit: "km",
    },
    { label: "Total rides", value: String(totals.totalRides), unit: "" },
    {
      label: "Total hours",
      value: totals.totalHours.toFixed(1),
      unit: "h",
    },
    {
      label: "Riding days",
      value: String(totals.ridingDays),
      unit: "",
    },
    {
      label: "Avg per ride",
      value:
        totals.totalRides === 0 ? "0" : totals.avgRideDistanceKm.toFixed(0),
      unit: "km",
    },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      {cards.map((stat) => (
        <div
          key={stat.label}
          className="p-4 rounded-xl bg-cream border border-line"
        >
          <p className="text-xs text-fg-dim mb-1">{stat.label}</p>
          <p className="text-2xl font-bold text-ink tabular-nums">
            {stat.value}
            {stat.unit && (
              <span className="text-sm font-normal text-fg-dim ml-1">
                {stat.unit}
              </span>
            )}
          </p>
        </div>
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
      {subtitle && <p className="text-xs text-fg-dim mt-0.5">{subtitle}</p>}
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
  return (
    <div className="space-y-3">
      <div
        className="grid gap-[3px] overflow-x-auto"
        style={{
          gridTemplateRows: "repeat(7, 12px)",
          gridAutoFlow: "column",
          gridAutoColumns: "12px",
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
