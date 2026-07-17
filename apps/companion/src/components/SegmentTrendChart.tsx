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
import type { Formatters } from "@tarmoto/shared";
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
import { useFormat } from "@/format/FormatProvider";
/**
 * Road quality trend graph (US-45). Rendered inside the expanded
 * RoadPreviewCard in the trip planner sidebar. All derivation lives in
 * `lib/segment-trend.ts`; this component is pure presentation + interaction.
 */
type TrendTone = "dark" | "cream";

interface SegmentTrendChartProps {
  segmentId: string;
  history: readonly QualityPoint[];
  regionalHistory?: readonly QualityPoint[] | undefined;
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
function formatTrendTooltipLabel(
  value: React.ReactNode,
  format: Formatters,
): React.ReactNode {
  // `value` is a trend point's `date` key, which is always a month bucket in
  // production: it's populated verbatim from `TrendPointDto.month` (backend
  // `SegmentDetailSidebar.tsx`'s `trendPoints()`), and the backend derives
  // that column via `DATE_TRUNC('month', recorded_at)` — it can never carry
  // a day component on the wire. Some unit-test fixtures use "YYYY-MM-DD"
  // shorthand for readability, but that's test convenience, not a real data
  // shape this component needs to support. Route through the same
  // instant-based `monthYear`/`monthBucketAnchor` pair the axis ticks use
  // (below) so the tooltip can't render a fabricated day-of-month (e.g. "Jul
  // 1, 2026" via `calendarDate`) for what is only ever a month.
  return typeof value === "string" || typeof value === "number"
    ? format.monthYear(monthBucketAnchor(String(value)))
    : "";
}
function formatTrendTooltipValue(
  value: TooltipValueType | undefined,
  name: React.ReactNode,
  format: Formatters,
) {
  const numeric =
    typeof value === "number" ? value : Number.parseFloat(String(value));
  const label =
    typeof name === "string" || typeof name === "number" ? String(name) : "";
  if (!Number.isFinite(numeric)) return ["—", label] as const;
  return [format.decimal(numeric, 2), label] as const;
}
/**
 * Parses a trend point's date-only string ("YYYY-MM" in production per
 * `TrendPointDto.month`, "YYYY-MM-DD" in some test fixtures — only the
 * year/month are used either way) into a UTC-noon anchor for the axis ticks
 * AND the tooltip label (`formatTrendTooltipLabel` above). `format.monthYear`
 * is an instant (viewer-timezone) formatter, so handing it the raw string —
 * which parses as UTC MIDNIGHT on day 1 — can roll into the previous month
 * for any viewer behind UTC (verified: a "2026-01" string renders "Dec 2025"
 * at UTC-12). Noon UTC is >12h clear of every real IANA offset (-12..+14) in
 * both directions, so the month can never shift. Mirrors `monthAnchor` in
 * `lib/ride-stats.ts`.
 */
function monthBucketAnchor(dateStr: string): Date {
  const [year, month] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1, 12));
}
export function SegmentTrendChart({
  segmentId,
  history,
  regionalHistory,
  now,
  tone = "dark",
}: SegmentTrendChartProps) {
  const format = useFormat();
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
          <TrendSummaryBadge summary={summary} cream={cream} format={format} />
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
                  // Compact "Jan 26" ticks — full monthYear crowds or gets
                  // minTickGap-suppressed on the 320px sidebar; the tooltip
                  // (formatTrendTooltipLabel) keeps the full month + year.
                  tickFormatter={(value: string) =>
                    format.monthYearCompact(monthBucketAnchor(value))
                  }
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
                  labelFormatter={(value: React.ReactNode) =>
                    formatTrendTooltipLabel(value, format)
                  }
                  formatter={(
                    value: TooltipValueType | undefined,
                    name: React.ReactNode,
                  ) => formatTrendTooltipValue(value, name, format)}
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
  format,
}: {
  summary: ReturnType<typeof summariseTrend>;
  cream: boolean;
  format: Formatters;
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
      title={`${format.decimal(summary.firstScore, 2)} → ${format.decimal(summary.latestScore, 2)}`}
    >
      {config.icon}
      {config.label}
      <span
        className={`ml-0.5 tabular-nums ${cream ? "text-fg-mute" : "text-slate-400"}`}
      >
        ({sign}
        {format.decimal(delta, 2)})
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
          {t("{count, plural, one {# repair} other {# repairs}}", {
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
            "{count, plural, one {# deterioration} other {# deteriorations}}",
            {
              count: detCount,
            },
          )}
        </li>
      )}
    </ul>
  );
}
