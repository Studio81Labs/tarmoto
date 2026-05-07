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
import { fetchAllRides } from "@/lib/rides-fetch";
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
const YOY_COLORS = [
  "#22d3ee",
  "#a78bfa",
  "#f472b6",
  "#facc15",
  "#34d399",
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
  useEffect(() => {
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
  }, []);
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
      <div className="p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">{t("Statistics")}</h1>
        <div className="flex items-center gap-2 text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading rides\u2026 ")}
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="p-6 max-w-6xl mx-auto animate-fade-in">
        <h1 className="text-2xl font-bold mb-6">{t("Statistics")}</h1>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-300">
          {loadError}
        </div>
      </div>
    );
  }
  if (rides.length === 0) {
    return (
      <div className="p-6 max-w-6xl mx-auto animate-fade-in">
        <h1 className="text-2xl font-bold mb-6">{t("Statistics")}</h1>
        <div className="rounded-2xl bg-slate-900 border border-slate-800 p-16 text-center">
          <BarChart3 size={48} className="mx-auto text-slate-600 mb-4" />
          <p className="text-slate-400 text-lg mb-2">
            {t("No rides recorded yet")}
          </p>
          <p className="text-slate-500 text-sm">
            {t(
              "Start riding with the Tarmoto mobile app to see your stats here. ",
            )}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in space-y-8">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t("Statistics")}</h1>
          <p className="text-sm text-slate-400 mt-1">
            {totals.totalRides === 0
              ? "No rides match the current filters."
              : `${totals.totalRides} ride${totals.totalRides === 1 ? "" : "s"} in view.`}
          </p>
        </div>
        <FilterBar filters={filters} years={years} onChange={setFilters} />
      </div>

      <TotalsGrid totals={totals} />

      <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
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
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="monthLabel"
                stroke="#64748b"
                fontSize={12}
                tickLine={false}
              />
              <YAxis
                stroke="#64748b"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(value: number) => `${Math.round(value)}`}
              />
              <Tooltip
                contentStyle={{
                  background: "#0f172a",
                  border: "1px solid #1e293b",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#e2e8f0" }}
                formatter={(value) => [
                  formatDistanceTooltipValue(value),
                  "Distance",
                ]}
              />
              <Bar dataKey="distanceKm" fill="#22d3ee" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
        <ChartHeader
          icon={<CalendarDays size={16} />}
          title={`Calendar heatmap — ${focusYear}`}
          subtitle="Each cell is one day. Brighter = longer ride."
        />
        <CalendarHeatmap days={calendar} year={focusYear} />
      </section>

      {yoyYears.length >= 2 && (
        <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
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
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="monthLabel"
                  stroke="#64748b"
                  fontSize={12}
                  tickLine={false}
                />
                <YAxis
                  stroke="#64748b"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  tickFormatter={(value: number) => `${Math.round(value)}`}
                />
                <Tooltip
                  contentStyle={{
                    background: "#0f172a",
                    border: "1px solid #1e293b",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#e2e8f0" }}
                  formatter={formatDistanceTooltipValue}
                />
                <Legend
                  wrapperStyle={{ fontSize: 12, color: "#94a3b8" }}
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
        <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
          <ChartHeader
            icon={<BarChart3 size={16} />}
            title={t("All years")}
            subtitle="Total distance per calendar year."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
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
              <tbody className="divide-y divide-slate-800">
                {yearlyTotals
                  .slice()
                  .reverse()
                  .map((row) => (
                    <tr key={row.year} className="text-slate-200">
                      <td className="py-2 pr-4 font-medium">{row.year}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.rides}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.distanceKm.toFixed(0)}
                        {t("km ")}
                      </td>
                      <td className="py-2 text-right tabular-nums text-slate-400">
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
          ...RIDE_TYPES.map((t) => ({ value: t, label: RIDE_TYPE_LABELS[t] })),
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
    <label className="flex items-center gap-2 text-xs text-slate-400">
      <span className="uppercase tracking-wider font-semibold">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-tarmoto-cyan"
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
          className="p-4 rounded-xl bg-slate-900 border border-slate-800"
        >
          <p className="text-xs text-slate-500 mb-1">{stat.label}</p>
          <p className="text-2xl font-bold text-white tabular-nums">
            {stat.value}
            {stat.unit && (
              <span className="text-sm font-normal text-slate-400 ml-1">
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
      <div className="flex items-center gap-2 text-white">
        <span className="text-tarmoto-cyan">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
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
      <div className="flex items-center justify-end gap-2 text-xs text-slate-500">
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
  return (
    <span
      title={title}
      className="block rounded-sm"
      style={{ backgroundColor: heatColor(intensity) }}
    />
  );
}
function heatColor(intensity: number): string {
  if (intensity <= 0) return "#1e293b";
  // Tarmoto cyan (#22d3ee) ramped from a near-empty grey via alpha-equivalent
  // mixing with the slate-900 backdrop. Done in hex so SSR + CSS match.
  const stops: {
    stop: number;
    color: string;
  }[] = [
    { stop: 0.15, color: "#0e3b4a" },
    { stop: 0.4, color: "#155e75" },
    { stop: 0.7, color: "#0891b2" },
    { stop: 1, color: "#22d3ee" },
  ];
  for (const s of stops) {
    if (intensity <= s.stop) return s.color;
  }
  return stops[stops.length - 1]!.color;
}
