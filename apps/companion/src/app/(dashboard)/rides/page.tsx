"use client";
import { t } from "@/i18n";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Activity, ArrowUpRight, Loader2, Share2 } from "lucide-react";
import {
  downloadAllRidesExport,
  type RideExportFormat,
} from "@/lib/ride-export";
import { useRideStats } from "@/hooks/useRideStats";
import { RidesFilters } from "./_components/RidesFilters";
import { RidesTable } from "./_components/RidesTable";
import { RideKpiCards } from "./_components/RideKpiCards";
import { RidesScaffold } from "./_RidesScaffold";
import { RidesEmptyState } from "./_RidesEmptyState";
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
  const { stats } = useRideStats(statsParams);

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
        // CTAs hide only on the truly-empty account state. With
        // filters active and 0 results, the rider's unfiltered
        // ride set may still be non-empty — they should keep
        // access to Export CSV / Share map.
        isPristineEmpty ? null : (
          <div className="flex items-center gap-2">
            <Link
              href="/rides/road-map"
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-line-strong bg-transparent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper"
            >
              <Share2 size={14} />
              {t("Share map")}
            </Link>
            <BulkExportMenu />
          </div>
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
          <RideKpiCards stats={stats} />
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
function BulkExportMenu() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<RideExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent) {
      if (!containerRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  async function handleExport(format: RideExportFormat) {
    if (busy) return;
    setBusy(format);
    setError(null);
    try {
      await downloadAllRidesExport(format);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-ink bg-ink px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-cream transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <ArrowUpRight size={14} />
        )}
        {t("Export CSV")}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 w-44 overflow-hidden rounded-lg border border-line bg-cream shadow-[0_12px_32px_rgba(14,14,16,0.14)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("csv")}
            disabled={busy !== null}
            className="w-full px-3 py-2 text-left text-sm text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("CSV (stats) ")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("gpx")}
            disabled={busy !== null}
            className="w-full border-t border-line px-3 py-2 text-left text-sm text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("GPX (tracks) ")}
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="absolute right-0 top-full mt-2 whitespace-nowrap text-xs text-red-400"
        >
          {t("Export failed: ")}
          {error}
        </p>
      )}
    </div>
  );
}
