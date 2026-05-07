"use client";
import { t } from "@/i18n";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { RideRow } from "./RideRow";
import type { RideSummary, RidesQueryState, SortField } from "./useRidesQuery";
interface Props {
  state: RidesQueryState;
  rides: RideSummary[];
  total: number;
  pageSize: number;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSort: (sort: SortField) => void;
  onPage: (page: number) => void;
  onRenamed: (next: RideSummary) => void;
}
const COLUMNS: Array<{
  key: SortField | null;
  label: string;
}> = [
  { key: null, label: "Name" },
  { key: "started_at", label: "Date" },
  { key: "distance_km", label: "Distance" },
  { key: "duration_min", label: "Duration" },
  { key: "avg_road_quality", label: "Avg quality" },
  { key: null, label: "" }, // open-detail column
];
export function RidesTable({
  state,
  rides,
  total,
  pageSize,
  loading,
  selectedId,
  onSelect,
  onSort,
  onPage,
  onRenamed,
}: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden flex flex-col min-h-0">
      <div className="overflow-auto flex-1">
        <table className="w-full text-sm">
          <thead className="bg-slate-950/60 text-slate-400 text-xs uppercase tracking-wide sticky top-0">
            <tr>
              {COLUMNS.map((col) => {
                const active = col.key && state.sort === col.key;
                return (
                  <th
                    key={col.label}
                    className="px-3 py-2 text-left font-medium"
                  >
                    {col.key ? (
                      <button
                        type="button"
                        onClick={() => onSort(col.key as SortField)}
                        className="inline-flex items-center gap-1 hover:text-slate-200"
                      >
                        {col.label}
                        {active &&
                          (state.order === "asc" ? (
                            <ArrowUp size={12} />
                          ) : (
                            <ArrowDown size={12} />
                          ))}
                      </button>
                    ) : (
                      col.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && rides.length === 0 ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  <td colSpan={6} className="px-3 py-3">
                    <div className="h-5 bg-slate-800 rounded" />
                  </td>
                </tr>
              ))
            ) : rides.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-10 text-center text-slate-500"
                >
                  {t("No rides match these filters. ")}
                </td>
              </tr>
            ) : (
              rides.map((r) => (
                <RideRow
                  key={r.id}
                  ride={r}
                  selected={selectedId === r.id}
                  onSelect={() => onSelect(r.id)}
                  onRenamed={onRenamed}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between px-3 py-2 border-t border-slate-800 text-sm text-slate-400">
        <span>
          {total === 0 ? "0 rides" : `${total} ride${total === 1 ? "" : "s"}`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPage(state.page - 1)}
            disabled={state.page <= 1}
            aria-label={t("Previous page")}
            className="p-1 rounded hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {t("Page ")}
            {state.page}
            {t("of ")}
            {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPage(state.page + 1)}
            disabled={state.page >= totalPages}
            aria-label={t("Next page")}
            className="p-1 rounded hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
