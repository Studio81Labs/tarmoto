"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
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

interface SegmentTrendChartProps {
  segmentId: string;
  history: readonly QualityPoint[];
  regionalHistory?: readonly QualityPoint[];
  now?: Date;
}

const DEFAULT_RANGE: TrendRange = "1y";

export function SegmentTrendChart({
  segmentId,
  history,
  regionalHistory,
  now,
}: SegmentTrendChartProps) {
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

  const hasTrend = filteredHistory.length >= 2;
  // Only summarise when there are at least two points — a single reading
  // would otherwise render as "Stable (+0.00)", which is misleading when
  // the companion panel already shows a "not enough readings" message.
  const summary = useMemo(
    () => (hasTrend ? summariseTrend(filteredHistory) : null),
    [filteredHistory, hasTrend],
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        {hasTrend ? <TrendSummaryBadge summary={summary} /> : <span />}
        <RangeSelector
          segmentId={segmentId}
          range={range}
          onChange={setRange}
        />
      </div>

      {!hasTrend ? (
        <p className="text-slate-500">
          Not enough readings in this range to plot a trend yet.
        </p>
      ) : (
        <>
          <div
            className="h-48"
            data-testid={`segment-trend-chart-${segmentId}`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  stroke="#64748b"
                  fontSize={10}
                  tickLine={false}
                  tickFormatter={formatDateTick}
                  minTickGap={24}
                />
                <YAxis
                  domain={[1, 5]}
                  ticks={[1, 2, 3, 4, 5]}
                  stroke="#64748b"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  width={24}
                />
                <Tooltip
                  contentStyle={{
                    background: "#0f172a",
                    border: "1px solid #1e293b",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#e2e8f0" }}
                  labelFormatter={(value: string) => value}
                  formatter={(value, name) => {
                    const numeric =
                      typeof value === "number"
                        ? value
                        : Number.parseFloat(String(value));
                    const label = String(name);
                    if (!Number.isFinite(numeric)) return ["—", label];
                    return [numeric.toFixed(2), label];
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  dot={{ r: 2, fill: "#22d3ee" }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                  connectNulls
                  name="This segment"
                />
                {filteredRegional.length > 0 && (
                  <Line
                    type="monotone"
                    dataKey="regional"
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                    name="Regional avg"
                  />
                )}
                {events.map((event) => (
                  <ReferenceDot
                    key={`${event.kind}-${event.date}`}
                    x={event.date}
                    y={clampScore(event.score)}
                    r={5}
                    fill={event.kind === "repair" ? "#34d399" : "#f87171"}
                    stroke="#0f172a"
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
}: {
  segmentId: string;
  range: TrendRange;
  onChange: (range: TrendRange) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Trend date range"
      className="flex rounded-lg border border-slate-800 overflow-hidden text-[11px]"
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
                ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
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
}: {
  summary: ReturnType<typeof summariseTrend>;
}) {
  if (!summary) return <span />;
  const { delta, direction } = summary;
  const config = {
    improving: {
      icon: <TrendingUp size={12} />,
      color: "text-emerald-400",
      label: "Improving",
    },
    declining: {
      icon: <TrendingDown size={12} />,
      color: "text-rose-400",
      label: "Declining",
    },
    stable: {
      icon: <Minus size={12} />,
      color: "text-slate-400",
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
      <span className="tabular-nums text-slate-400 ml-0.5">
        ({sign}
        {delta.toFixed(2)})
      </span>
    </span>
  );
}

function ChartLegend({
  hasRegional,
  events,
}: {
  hasRegional: boolean;
  events: ReturnType<typeof detectChangeEvents>;
}) {
  const repairCount = events.filter((e) => e.kind === "repair").length;
  const detCount = events.filter((e) => e.kind === "deterioration").length;
  return (
    <ul className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
      <li className="flex items-center gap-1">
        <span className="w-2 h-2 rounded-full bg-tarmoto-cyan" />
        This segment
      </li>
      {hasRegional && (
        <li className="flex items-center gap-1">
          <span className="inline-block w-3 border-t border-dashed border-slate-400" />
          Regional avg
        </li>
      )}
      {repairCount > 0 && (
        <li className="flex items-center gap-1 text-emerald-400">
          <Wrench size={10} />
          {repairCount} repair{repairCount === 1 ? "" : "s"}
        </li>
      )}
      {detCount > 0 && (
        <li className="flex items-center gap-1 text-rose-400">
          <TrendingDown size={10} />
          {detCount} deterioration{detCount === 1 ? "" : "s"}
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
