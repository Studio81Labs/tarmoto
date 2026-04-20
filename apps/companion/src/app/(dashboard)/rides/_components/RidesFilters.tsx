"use client";

import { useEffect, useState } from "react";
import { RotateCcw, Search } from "lucide-react";
import type { RidesQueryState } from "./useRidesQuery";

const RIDE_TYPES = ["free", "commute", "trip", "tracked"] as const;

interface Props {
  state: RidesQueryState;
  update: (patch: Partial<RidesQueryState>) => void;
  reset: () => void;
}

export function RidesFilters({ state, update, reset }: Props) {
  // Local state for the search box — debounced before writing to URL.
  const [searchLocal, setSearchLocal] = useState(state.q ?? "");
  useEffect(() => {
    setSearchLocal(state.q ?? "");
  }, [state.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if ((state.q ?? "") !== searchLocal) {
        update({ q: searchLocal || undefined });
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchLocal]);

  const hasAny = Boolean(
    state.from ||
    state.to ||
    state.minDistance != null ||
    state.maxDistance != null ||
    state.minQuality != null ||
    state.maxQuality != null ||
    state.q ||
    state.type,
  );

  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 mb-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <label className="text-xs text-slate-400 flex flex-col gap-1">
          From
          <input
            type="date"
            value={state.from ?? ""}
            onChange={(e) => update({ from: e.target.value || undefined })}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 flex flex-col gap-1">
          To
          <input
            type="date"
            value={state.to ?? ""}
            onChange={(e) => update({ to: e.target.value || undefined })}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 flex flex-col gap-1">
          Min km
          <input
            type="number"
            min={0}
            value={state.minDistance ?? ""}
            onChange={(e) =>
              update({
                minDistance:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 flex flex-col gap-1">
          Max km
          <input
            type="number"
            min={0}
            value={state.maxDistance ?? ""}
            onChange={(e) =>
              update({
                maxDistance:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3 mt-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Quality (min → max)</span>
          <div className="flex items-center gap-2">
            <select
              value={state.minQuality ?? ""}
              onChange={(e) =>
                update({
                  minQuality:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="">Any</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="text-slate-500">–</span>
            <select
              value={state.maxQuality ?? ""}
              onChange={(e) =>
                update({
                  maxQuality:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="">Any</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Type</span>
          <div className="flex flex-wrap gap-1">
            <TypeChip
              label="All"
              active={!state.type}
              onClick={() => update({ type: undefined })}
            />
            {RIDE_TYPES.map((t) => (
              <TypeChip
                key={t}
                label={t}
                active={state.type === t}
                onClick={() => update({ type: t })}
              />
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1 flex-1 min-w-[180px]">
          <span className="text-xs text-slate-400">Search name</span>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <input
              type="search"
              value={searchLocal}
              onChange={(e) => setSearchLocal(e.target.value)}
              placeholder="Sunday…"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-7 pr-2 py-1.5 text-sm text-slate-100"
            />
          </div>
        </label>

        {hasAny && (
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition"
          >
            <RotateCcw size={14} /> Reset
          </button>
        )}
      </div>
    </div>
  );
}

function TypeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs transition ${
        active
          ? "bg-tarmoto-cyan text-slate-900"
          : "bg-slate-800 text-slate-300 hover:bg-slate-700"
      }`}
    >
      {label}
    </button>
  );
}
