"use client";
import { t } from "@/i18n";
import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  type TooltipValueType,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Minus, TrendingDown, TrendingUp, Wrench } from "lucide-react";
import {
  TREND_RANGES,
  TREND_RANGE_LABEL,
  clampScore,
  type QualityPoint,
  type TrendRange,
  buildChartPoints,
  detectChangeEvents,
  filterByRange,
  summariseTrend,
} from "@/lib/segment-trend";
/**
 * Road quality trend graph (US-45). Rendered inside the expanded
 * RoadPreviewCard in the trip planner sidebar. All derivation lives in
 * `lib/segment-trend.ts`; this component is pure presentation + interaction.
 */
type TrendTone = "dark" | "cream";

interface SegmentTrendChartProps {
  segmentId: string;
  history: readonly QualityPoint[];
  regionalHistory?: readonly QualityPoint[];
  now?: Date;
  /** Colour theme — `dark` (default) for the trip planner, `cream` for explore. */
  tone?: TrendTone;
}
const DEFAULT_RANGE: TrendRange = "1y";

/** Recharts takes concrete colour strings, so the theme lives here. */
function trendChartPalette(tone: TrendTone) {
  return tone === "cream"
    ? {
        grid: "rgba(14,14,16,0.10)",
        axis: "rgba(14,14,16,0.45)",
        tooltipBg: "#f5efe6",
        tooltipBorder: "rgba(14,14,16,0.18)",
        tooltipLabel: "#0e0e10",
        line: "#ff6a1a",
        regional: "rgba(14,14,16,0.35)",
        refStroke: "#f5efe6",
      }
    : {
        grid: "#1e293b",
        axis: "#64748b",
        tooltipBg: "#0f172a",
        tooltipBorder: "#1e293b",
        tooltipLabel: "#e2e8f0",
        line: "#22d3ee",
        regional: "#94a3b8",
        refStroke: "#0f172a",
      };
}
function formatTrendTooltipLabel(value: React.ReactNode) {
  return typeof value === "string" || typeof value === "number" ? value : "";
}
function formatTrendTooltipValue(
  value: TooltipValueType | undefined,
  name: React.ReactNode,
) {
  const numeric =
    typeof value === "number" ? value : Number.parseFloat(String(value));
  const label =
    typeof name === "string" || typeof name === "number" ? String(name) : "";
  if (!Number.isFinite(numeric)) return ["—", label] as const;
  return [numeric.toFixed(2), label] as const;
}
export function SegmentTrendChart({
  segmentId,
  history,
  regionalHistory,
  now,
  tone = "dark",
}: SegmentTrendChartProps) {
  const cream = tone === "cream";
  const palette = trendChartPalette(tone);
  const [range, setRange] = useState<TrendRange>(DEFAULT_RANGE);
  const filteredHistory = useMemo(
    () => filterByRange(history, range, now),
    [history, range, now],
  );
  const filteredRegional = useMemo(
    () => filterByRange(regionalHistory ?? [], range, now),
    [regionalHistory, range, now],
  );
  const events = useMemo(
    () => detectChangeEvents(filteredHistory),
    [filteredHistory],
  );
  const data = useMemo(
    () => buildChartPoints(filteredHistory, filteredRegional, events),
    [filteredHistory, filteredRegional, events],
  );
  // `buildChartPoints` collapses same-date readings to a single x-point, so
  // we gate on the count of distinct dates rather than raw reading count —
  // otherwise two readings on the same day would flip the trend UI on
  // without actually plotting a second point.
  const uniqueDateCount = useMemo(
    () => new Set(filteredHistory.map((p) => p.date)).size,
    [filteredHistory],
  );
  const hasTrend = uniqueDateCount >= 2;
  const summary = useMemo(
    () => (hasTrend ? summariseTrend(filteredHistory) : null),
    [filteredHistory, hasTrend],
  );
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        {hasTrend ? (
          <TrendSummaryBadge summary={summary} cream={cream} />
        ) : (
          <span />
        )}
        <RangeSelector
          segmentId={segmentId}
          range={range}
          onChange={setRange}
          cream={cream}
        />
      </div>

      {!hasTrend ? (
        <p className={cream ? "text-fg-mute" : "text-slate-500"}>
          {t("Not enough readings in this range to plot a trend yet. ")}
        </p>
      ) : (
        <>
          <div
            className="h-48 w-full min-w-0"
            data-testid={`segment-trend-chart-${segmentId}`}
          >
            <ResponsiveContainer
              width="100%"
              height="100%"
              minWidth={1}
              minHeight={1}
              initialDimension={{ width: 320, height: 192 }}
            >
              <LineChart
                data={data}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} />
                <XAxis
                  dataKey="date"
                  stroke={palette.axis}
                  fontSize={10}
                  tickLine={false}
                  tickFormatter={formatDateTick}
                  minTickGap={24}
                />
                <YAxis
                  domain={[1, 5]}
                  ticks={[1, 2, 3, 4, 5]}
                  stroke={palette.axis}
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  width={24}
                />
                <Tooltip
                  contentStyle={{
                    background: palette.tooltipBg,
                    border: `1px solid ${palette.tooltipBorder}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: palette.tooltipLabel }}
                  labelFormatter={formatTrendTooltipLabel}
                  formatter={formatTrendTooltipValue}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke={palette.line}
                  strokeWidth={2}
                  dot={{ r: 2, fill: palette.line }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                  name="This segment"
                />
                {filteredRegional.length > 0 && (
                  <Line
                    type="monotone"
                    dataKey="regional"
                    stroke={palette.regional}
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                    isAnimationActive={false}
                    name="Regional avg"
                  />
                )}
                {events.map((event) => (
                  <ReferenceDot
                    key={`${event.kind}-${event.date}`}
                    x={event.date}
                    y={clampScore(event.score)}
                    r={5}
                    fill={event.kind === "repair" ? "#1f8a5b" : "#d2483a"}
                    stroke={palette.refStroke}
                    strokeWidth={2}
                    ifOverflow="extendDomain"
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <ChartLegend
            hasRegional={filteredRegional.length > 0}
            events={events}
            cream={cream}
          />
        </>
      )}
    </div>
  );
}
function RangeSelector({
  segmentId,
  range,
  onChange,
  cream,
}: {
  segmentId: string;
  range: TrendRange;
  onChange: (range: TrendRange) => void;
  cream: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={t("Trend date range")}
      className={`flex overflow-hidden rounded-lg border text-[11px] ${
        cream ? "border-line" : "border-slate-800"
      }`}
    >
      {TREND_RANGES.map((option) => {
        const active = option === range;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={TREND_RANGE_LABEL[option]}
            onClick={() => onChange(option)}
            data-testid={`trend-range-${segmentId}-${option}`}
            className={`px-2 py-1 transition ${
              active
                ? "bg-accent/10 text-accent"
                : cream
                  ? "text-fg-mute hover:bg-paper hover:text-ink"
                  : "text-slate-400 hover:text-white hover:bg-slate-800"
            }`}
          >
            {option === "all" ? "All" : option.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
function TrendSummaryBadge({
  summary,
  cream,
}: {
  summary: ReturnType<typeof summariseTrend>;
  cream: boolean;
}) {
  if (!summary) return <span />;
  const { delta, direction } = summary;
  const config = {
    improving: {
      icon: <TrendingUp size={12} />,
      color: cream ? "text-emerald-600" : "text-emerald-400",
      label: "Improving",
    },
    declining: {
      icon: <TrendingDown size={12} />,
      color: cream ? "text-rose-600" : "text-rose-400",
      label: "Declining",
    },
    stable: {
      icon: <Minus size={12} />,
      color: cream ? "text-fg-mute" : "text-slate-400",
      label: "Stable",
    },
  }[direction];
  const sign = delta > 0 ? "+" : "";
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium ${config.color}`}
      title={`${summary.firstScore.toFixed(2)} → ${summary.latestScore.toFixed(2)}`}
    >
      {config.icon}
      {config.label}
      <span
        className={`ml-0.5 tabular-nums ${cream ? "text-fg-mute" : "text-slate-400"}`}
      >
        ({sign}
        {delta.toFixed(2)})
      </span>
    </span>
  );
}
function ChartLegend({
  hasRegional,
  events,
  cream,
}: {
  hasRegional: boolean;
  events: ReturnType<typeof detectChangeEvents>;
  cream: boolean;
}) {
  const repairCount = events.filter((e) => e.kind === "repair").length;
  const detCount = events.filter((e) => e.kind === "deterioration").length;
  return (
    <ul
      className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] ${
        cream ? "text-fg-mute" : "text-slate-500"
      }`}
    >
      <li className="flex items-center gap-1">
        <span className="w-2 h-2 rounded-full bg-accent" />
        {t("This segment ")}
      </li>
      {hasRegional && (
        <li className="flex items-center gap-1">
          <span
            className={`inline-block w-3 border-t border-dashed ${
              cream ? "border-fg-mute" : "border-slate-400"
            }`}
          />
          {t("Regional avg ")}
        </li>
      )}
      {repairCount > 0 && (
        <li
          className={`flex items-center gap-1 ${
            cream ? "text-emerald-600" : "text-emerald-400"
          }`}
        >
          <Wrench size={10} />
          {t(repairCount === 1 ? "{count} repair" : "{count} repairs", {
            count: repairCount,
          })}
        </li>
      )}
      {detCount > 0 && (
        <li
          className={`flex items-center gap-1 ${
            cream ? "text-rose-600" : "text-rose-400"
          }`}
        >
          <TrendingDown size={10} />
          {t(
            detCount === 1 ? "{count} deterioration" : "{count} deteriorations",
            { count: detCount },
          )}
        </li>
      )}
    </ul>
  );
}
function formatDateTick(value: string): string {
  // Compact MMM YY labels keep the axis readable at sidebar widths.
  const [year, month] = value.split("-");
  if (!year || !month) return value;
  const monthIndex = Number(month) - 1;
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const name = names[monthIndex] ?? month;
  return `${name} ${year.slice(2)}`;
}
