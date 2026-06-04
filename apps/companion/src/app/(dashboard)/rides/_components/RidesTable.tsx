"use client";
import { t } from "@/i18n";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { Card } from "@tarmoto/ui";
import { RideRow } from "./RideRow";
import type { RideSummary, RidesQueryState, SortField } from "./useRidesQuery";

interface Props {
  state: RidesQueryState;
  rides: RideSummary[];
  total: number;
  pageSize: number;
  loading: boolean;
  onSort: (sort: SortField) => void;
  onPage: (page: number) => void;
}

/**
 * Full-width Ride History table matching the v2 design. Grid columns:
 * DATE / RIDE / KM / DURATION / AVG / LEAN / QUALITY / →. DATE, KM, DURATION,
 * and QUALITY are sortable (backed by `useRidesQuery`'s sort state); AVG
 * (avg_speed) and LEAN (max_lean_angle) have no backend sort field, so those
 * headers are static. Rows are links to the ride detail page (see `RideRow`).
 */
export const ROW_COLS =
  "grid grid-cols-[90px_1fr_80px_90px_70px_70px_110px_40px] items-center";

const COLUMNS: Array<{ key: SortField | null; label: string }> = [
  { key: "started_at", label: "DATE" },
  { key: null, label: "RIDE" },
  { key: "distance_km", label: "KM" },
  { key: "duration_min", label: "DURATION" },
  { key: null, label: "AVG" },
  { key: null, label: "LEAN" },
  { key: "avg_road_quality", label: "QUALITY" },
  { key: null, label: "" },
];

export function RidesTable({
  state,
  rides,
  total,
  pageSize,
  loading,
  onSort,
  onPage,
}: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <Card padded={false} className="overflow-hidden" role="table">
      <div
        role="row"
        className={`${ROW_COLS} border-b border-line bg-paper px-5 py-3 font-mono text-[10px] uppercase tracking-[1.2px] text-fg-mute`}
      >
        {COLUMNS.map((col) => {
          const active = col.key && state.sort === col.key;
          return (
            <span key={col.label || "open"} role="columnheader">
              {col.key ? (
                <button
                  type="button"
                  onClick={() => onSort(col.key as SortField)}
                  className="inline-flex items-center gap-1 uppercase tracking-[1.2px] transition hover:text-ink"
                >
                  {col.label}
                  {active &&
                    (state.order === "asc" ? (
                      <ArrowUp size={11} />
                    ) : (
                      <ArrowDown size={11} />
                    ))}
                </button>
              ) : (
                col.label
              )}
            </span>
          );
        })}
      </div>

      {loading && rides.length === 0 ? (
        Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className={`${ROW_COLS} animate-pulse px-5 py-3.5 ${
              i < 5 ? "border-b border-line" : ""
            }`}
          >
            <div className="col-span-8 h-5 rounded bg-paper-2" />
          </div>
        ))
      ) : rides.length === 0 ? (
        <div className="px-5 py-10 text-center text-[13px] text-fg-dim">
          {t("No rides match these filters. ")}
        </div>
      ) : (
        rides.map((r, i) => (
          <RideRow key={r.id} ride={r} last={i === rides.length - 1} />
        ))
      )}

      <div className="flex items-center justify-between border-t border-line px-5 py-2.5 text-sm text-fg-dim">
        <span className="font-mono tabular-nums">
          {total === 0 ? "0 rides" : `${total} ride${total === 1 ? "" : "s"}`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPage(state.page - 1)}
            disabled={state.page <= 1}
            aria-label={t("Previous page")}
            className="rounded p-1 transition hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="font-mono tabular-nums">
            {t("Page {currentPage} of {pageCount}", {
              currentPage: state.page,
              pageCount: totalPages,
            })}
          </span>
          <button
            type="button"
            onClick={() => onPage(state.page + 1)}
            disabled={state.page >= totalPages}
            aria-label={t("Next page")}
            className="rounded p-1 transition hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </Card>
  );
}
