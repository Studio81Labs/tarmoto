"use client";

import { useMemo, useState } from "react";
import { Mountain } from "lucide-react";
import { usePasses } from "@/hooks/usePasses";
import {
  MONTH_NAMES,
  STATUS_DISPLAY_ORDER,
  countByStatus,
  currentUtcMonth,
  monthLabel,
  partitionByStatus,
  type MountainPass,
  type PassStatus,
} from "@/lib/passes-summary";

interface PassesPanelProps {
  month?: number;
  onMonthChange?: (month: number) => void;
}

const STATUS_DOT_CLASS: Record<PassStatus, string> = {
  open: "bg-emerald-400",
  closed: "bg-rose-400",
  unknown: "bg-slate-400",
};

const STATUS_LABEL: Record<PassStatus, string> = {
  open: "Open",
  closed: "Closed",
  unknown: "Unknown",
};

const MAX_PASSES_PER_GROUP = 5;

/**
 * Seasonal passes panel for the trip planner sidebar (US-40).
 *
 * The planner map is still a placeholder (#79 will wire MapLibre); this
 * surfaces the backend's seasonal filter in its own section so riders can
 * already preview which passes are open/closed in a target month. Once the
 * map layer ships, the selector here drives the layer's status colouring.
 */
export function PassesPanel({
  month: controlledMonth,
  onMonthChange,
}: PassesPanelProps) {
  const [localMonth, setLocalMonth] = useState<number>(() => currentUtcMonth());
  const isControlled =
    controlledMonth !== undefined && onMonthChange !== undefined;
  const isReadOnlyControlled =
    controlledMonth !== undefined && onMonthChange === undefined;
  const month = isControlled
    ? controlledMonth
    : (controlledMonth ?? localMonth);
  const setMonth = (nextMonth: number) => {
    if (isControlled) onMonthChange(nextMonth);
    else setLocalMonth(nextMonth);
  };
  const { passes, loading, error } = usePasses(month);
  const counts = useMemo(() => countByStatus(passes), [passes]);
  const groups = useMemo(() => partitionByStatus(passes), [passes]);

  return (
    <div className="space-y-3 pt-2 border-t border-slate-800">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-300">
        <Mountain size={14} className="text-slate-500" />
        Seasonal passes
      </div>

      <div>
        <label
          htmlFor="passes-month"
          className="block text-xs text-slate-500 mb-1"
        >
          Travel month
        </label>
        <select
          id="passes-month"
          value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
          disabled={isReadOnlyControlled}
          className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
        >
          {MONTH_NAMES.map((name, idx) => (
            <option key={name} value={idx + 1}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <Legend />

      {error ? (
        <p className="text-xs text-rose-400">{error}</p>
      ) : loading ? (
        <p className="text-xs text-slate-500">Loading passes…</p>
      ) : counts.total === 0 ? (
        <p className="text-xs text-slate-500">No mountain passes seeded yet.</p>
      ) : (
        <>
          <p className="text-xs text-slate-400">
            In {monthLabel(month)}:{" "}
            <span className="text-rose-400">{counts.closed} closed</span>
            {" • "}
            <span className="text-slate-300">{counts.unknown} unknown</span>
            {" • "}
            <span className="text-emerald-400">{counts.open} open</span>
          </p>

          <ul className="space-y-1.5">
            {STATUS_DISPLAY_ORDER.flatMap((status) =>
              groups[status]
                .slice(0, MAX_PASSES_PER_GROUP)
                .map((p) => <PassRow key={p.id} pass={p} />),
            )}
          </ul>
        </>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div
      role="list"
      aria-label="Pass status legend"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400"
    >
      {STATUS_DISPLAY_ORDER.map((status) => (
        <span
          key={status}
          role="listitem"
          className="inline-flex items-center gap-1.5"
        >
          <span
            aria-hidden
            className={`inline-block w-2 h-2 rounded-full ${STATUS_DOT_CLASS[status]}`}
          />
          {STATUS_LABEL[status]}
        </span>
      ))}
    </div>
  );
}

function PassRow({ pass }: { pass: MountainPass }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        aria-hidden
        className={`mt-1 inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_DOT_CLASS[pass.status]}`}
      />
      <span className="flex-1 min-w-0">
        <span className="text-slate-200 truncate block">{pass.name}</span>
        <span className="text-slate-500">
          {pass.elevation_m.toLocaleString()} m
          {pass.region ? ` · ${pass.region}` : ""}
        </span>
      </span>
    </li>
  );
}
