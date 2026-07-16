"use client";
import { t } from "@/i18n";
import Link from "next/link";
import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  DataTable,
  Mono,
  QualityBars,
  type DataTableColumn,
} from "@tarmoto/ui";
import { scoreToQualityTier } from "@/lib/utils";
import { useFormat } from "@/format/FormatProvider";
import type { Formatters } from "@tarmoto/shared";
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
 * Full-width Ride History table matching the v2 design. Renders a real
 * semantic `<table>` via the shared `DataTable`. Columns: DATE / RIDE / KM /
 * DURATION / AVG / LEAN / QUALITY / →. DATE, KM, DURATION, and QUALITY are
 * sortable (backed by `useRidesQuery`'s sort state); AVG (avg_speed) and LEAN
 * (max_lean_angle) have no backend sort field, so those headers are static.
 * Each row links to the ride detail page (`/rides/[rideId]`).
 */
function buildColumns(format: Formatters): DataTableColumn<RideSummary>[] {
  return [
    {
      key: "started_at",
      label: "DATE",
      size: "90px",
      sortable: true,
      render: (r) => (
        <Mono className="text-fg-dim">{format.shortDate(r.started_at)}</Mono>
      ),
    },
    {
      key: "ride",
      label: "RIDE",
      primary: true,
      // Honest data gaps (per the v2 plan): the per-ride region subtext and the
      // ⚠ hazard badge have no backing on the summary, so the RIDE cell shows
      // the ride type alone.
      render: (r) => (
        <div className="leading-tight">
          <span className="block truncate font-bold text-ink">
            {r.name ?? format.shortDate(r.started_at)}
          </span>
          <Mono className="text-[10px] uppercase text-fg-mute">
            {r.ride_type}
          </Mono>
        </div>
      ),
    },
    {
      key: "distance_km",
      label: "KM",
      size: "80px",
      sortable: true,
      render: (r) => (
        <Mono className="font-bold text-ink">
          {r.distance_km != null
            ? format.splitDistanceKm(r.distance_km).value
            : "—"}
        </Mono>
      ),
    },
    {
      key: "duration_min",
      label: "DURATION",
      size: "90px",
      sortable: true,
      render: (r) => (
        <Mono className="text-fg-dim">
          {r.duration_min != null
            ? format.durationCompact(r.duration_min)
            : "—"}
        </Mono>
      ),
    },
    {
      key: "avg",
      label: "AVG",
      size: "70px",
      render: (r) => (
        <Mono className="text-ink">
          {r.avg_speed != null ? Math.round(r.avg_speed) : "—"}
        </Mono>
      ),
    },
    {
      key: "lean",
      label: "LEAN",
      size: "70px",
      render: (r) => (
        <Mono className="text-ink">
          {r.max_lean_angle != null ? `${Math.round(r.max_lean_angle)}°` : "—"}
        </Mono>
      ),
    },
    {
      key: "avg_road_quality",
      label: "QUALITY",
      size: "110px",
      sortable: true,
      render: (r) => {
        const tier = scoreToQualityTier(r.avg_road_quality);
        return tier != null ? (
          <QualityBars q={tier} size={4} />
        ) : (
          <span className="text-fg-mute">—</span>
        );
      },
    },
  ];
}

export function RidesTable({
  state,
  rides,
  total,
  pageSize,
  loading,
  onSort,
  onPage,
}: Props) {
  const format = useFormat();
  const columns = useMemo(() => buildColumns(format), [format]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <DataTable<RideSummary>
      ariaLabel={t("Ride history")}
      columns={columns}
      rows={rides}
      rowKey={(r) => r.id}
      getRowHref={(r) => `/rides/${r.id}`}
      renderLink={({ href, className, children }) => (
        <Link href={href} className={className}>
          {children}
        </Link>
      )}
      sort={{ key: state.sort, direction: state.order }}
      onSort={(key) => onSort(key as SortField)}
      emptyState={
        loading ? t("Loading rides… ") : t("No rides match these filters. ")
      }
      // Pagination only when it earns its space — on a single page the arrows
      // are inert and the count already lives in the "All rides · N" tab badge,
      // so the last row sits flush to the card edge.
      footer={
        totalPages > 1 ? (
          <div className="flex items-center justify-between px-5 py-2.5 text-sm text-fg-dim">
            <span className="font-mono tabular-nums">
              {`${total} ride${total === 1 ? "" : "s"}`}
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
        ) : undefined
      }
    />
  );
}
