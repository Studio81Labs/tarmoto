"use client";
import { t } from "@/i18n";
import { Suspense, useMemo } from "react";
import { Activity } from "lucide-react";
import { downloadAllRidesExport } from "@/lib/ride-export";
import { useRideStats } from "@/hooks/useRideStats";
import { RidesFilters } from "./_components/RidesFilters";
import { RidesTable } from "./_components/RidesTable";
import { RideKpiCards } from "./_components/RideKpiCards";
import { RidesScaffold } from "./_RidesScaffold";
import { RidesEmptyState } from "./_RidesEmptyState";
import { RideExportMenu } from "./_components/RideExportMenu";
import { Mono } from "@tarmoto/ui";
import {
  toFilterParams,
  useRidesQuery,
  type SortField,
} from "./_components/useRidesQuery";
import { useTimeWindow } from "./_components/TimeWindowPills";
export default function RidesPage() {
  // useSearchParams needs a Suspense boundary for Next.js static optimization.
  return (
    <Suspense fallback={null}>
      <RidesPageInner />
    </Suspense>
  );
}
function RidesPageInner() {
  const { state, list, update, reset, pageSize } = useRidesQuery();
  const window = useTimeWindow();

  function onSort(sort: SortField) {
    if (state.sort === sort) {
      update({ order: state.order === "asc" ? "desc" : "asc" });
    } else {
      update({ sort, order: "desc" });
    }
  }

  // The KPI cards must reflect the EXACT same window the table renders.
  // `toFilterParams` already folds the shared `?window=` pill into
  // `started_from` (via `state.effectiveFrom`), so the cards and list stay in
  // lockstep automatically. Memoized so the stats query key is stable.
  const statsParams = useMemo(() => toFilterParams(state), [state]);
  const { stats, error: statsError } = useRideStats(statsParams);

  // Distinguish a truly pristine account (no rides ever) from a
  // filtered / errored zero result. `list.total` reflects the
  // currently-filtered count, so we'd otherwise hide `RidesFilters`
  // (+ Reset button), the table's own filtered-empty messaging, and
  // any `list.error` whenever a filter returns 0 matches or the API
  // call failed — leaving riders stuck with no way to clear filters
  // or retry.
  const hasActiveFilter =
    Boolean(
      state.q ||
      state.type ||
      state.from ||
      state.to ||
      state.minDistance !== undefined ||
      state.maxDistance !== undefined ||
      state.minQuality !== undefined ||
      state.maxQuality !== undefined ||
      state.nearLat !== undefined ||
      window !== "all",
    ) || state.page > 1;
  const isPristineEmpty =
    !list.loading && !list.error && !hasActiveFilter && list.total === 0;
  return (
    <RidesScaffold
      allRidesBadge={
        list.loading ? null : <Mono className="text-[11px]">{list.total}</Mono>
      }
      headerRight={
        // The export menu hides only on the truly-empty account state.
        // With filters active and 0 results, the rider's unfiltered ride
        // set may still be non-empty — they should keep access to Export.
        isPristineEmpty ? null : (
          <RideExportMenu onExport={downloadAllRidesExport} />
        )
      }
    >
      {isPristineEmpty ? (
        <RidesEmptyState
          icon={<Activity size={18} strokeWidth={2} />}
          title={t("No rides recorded yet")}
          body={t(
            "Start a ride from the Tarmoto mobile app — it will appear here within seconds of finishing.",
          )}
        />
      ) : (
        <>
          <RideKpiCards stats={stats} error={statsError} />
          <RidesFilters state={state} update={update} reset={reset} />
          <RidesTable
            state={state}
            rides={list.rides}
            total={list.total}
            pageSize={pageSize}
            loading={list.loading}
            onSort={onSort}
            onPage={(page) => update({ page })}
          />
          {list.error && (
            <p className="mt-2 text-xs text-red-400">{list.error}</p>
          )}
        </>
      )}
    </RidesScaffold>
  );
}
