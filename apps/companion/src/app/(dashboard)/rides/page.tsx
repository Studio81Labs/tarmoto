"use client";
import { t } from "@/i18n";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Download,
  List as ListIcon,
  Loader2,
  Map as MapIcon,
  Scale,
} from "lucide-react";
import {
  downloadAllRidesExport,
  type RideExportFormat,
} from "@/lib/ride-export";
import { RidesFilters } from "./_components/RidesFilters";
import { RidesMap } from "./_components/RidesMap";
import { RidesTable } from "./_components/RidesTable";
import { PageHeader } from "@/components/PageHeader";
import {
  useRidesQuery,
  type RideSummary,
  type SortField,
} from "./_components/useRidesQuery";
export default function RidesPage() {
  // useSearchParams needs a Suspense boundary for Next.js static optimization.
  return (
    <Suspense fallback={null}>
      <RidesPageInner />
    </Suspense>
  );
}
function RidesPageInner() {
  const { state, list, tracks, update, reset, pageSize } = useRidesQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"map" | "list">("list");
  // Optimistic updates after rename — merge into the current list snapshot.
  // We let patches persist across refetches; the server ultimately ships the
  // renamed row, so the merge becomes a no-op naturally. Patches scoped to
  // rides no longer in `list.rides` just sit idle — cheap, and avoids
  // clobbering a rename completed during an unrelated refetch.
  //
  // If a name-search filter is active, we also re-evaluate the patched row
  // against `state.q` client-side — a rename that no longer matches the
  // search would otherwise stay visible until the next refetch.
  const [patched, setPatched] = useState<Record<string, RideSummary>>({});
  const qLower = state.q?.toLowerCase();
  const mergedRides = list.rides
    .map((r) => patched[r.id] ?? r)
    .filter((r) => !qLower || (r.name ?? "").toLowerCase().includes(qLower));
  // Adjust the server-reported total by the number of rides the rename
  // filter dropped on this page, so the table footer and `Page X of Y`
  // stay in sync with what's actually rendered.
  const adjustedTotal = Math.max(
    0,
    list.total - (list.rides.length - mergedRides.length),
  );
  function onSort(sort: SortField) {
    if (state.sort === sort) {
      update({ order: state.order === "asc" ? "desc" : "asc" });
    } else {
      update({ sort, order: "desc" });
    }
  }
  return (
    <div className="flex flex-col h-full min-h-0 p-4 md:p-6 max-w-page mx-auto w-full animate-fade-in">
      <PageHeader
        icon={Activity}
        title={t("Ride History")}
        subtitle={t(
          "Browse every recorded ride and review stats, conditions, and routes.",
        )}
        action={
          <div className="flex items-center gap-2">
            {list.rides.length > 0 && <BulkExportMenu />}
            {list.total >= 2 && (
              <Link
                href="/rides/compare"
                className="inline-flex items-center gap-1.5 px-3 py-[5px] rounded-full border border-line-strong bg-cream text-ink text-[11px] font-bold uppercase tracking-[0.2px] hover:bg-paper transition"
              >
                <Scale size={14} />
                {t("Compare rides ")}
              </Link>
            )}
          </div>
        }
      />

      <RidesFilters state={state} update={update} reset={reset} />

      {/* Mobile tab toggle */}
      <div className="flex md:hidden items-center rounded-lg bg-paper border border-line p-0.5 mb-3 w-fit">
        <button
          type="button"
          onClick={() => setMobileTab("map")}
          className={`flex items-center gap-1 px-3 py-1 rounded-md text-sm font-semibold transition ${
            mobileTab === "map"
              ? "bg-ink text-cream"
              : "text-fg-dim hover:text-ink"
          }`}
        >
          <MapIcon size={14} />
          {t("Map ")}
        </button>
        <button
          type="button"
          onClick={() => setMobileTab("list")}
          className={`flex items-center gap-1 px-3 py-1 rounded-md text-sm font-semibold transition ${
            mobileTab === "list"
              ? "bg-ink text-cream"
              : "text-fg-dim hover:text-ink"
          }`}
        >
          <ListIcon size={14} />
          {t("List ")}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 flex-1 min-h-0">
        <div
          className={`md:col-span-3 min-h-[360px] md:min-h-0 ${mobileTab === "map" ? "" : "hidden md:block"}`}
        >
          <RidesMap
            tracks={tracks.tracks}
            truncated={tracks.truncated}
            loading={tracks.loading}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
          />
        </div>
        <div
          className={`md:col-span-2 min-h-0 flex flex-col ${mobileTab === "list" ? "" : "hidden md:flex"}`}
        >
          <RidesTable
            state={state}
            rides={mergedRides}
            total={adjustedTotal}
            pageSize={pageSize}
            loading={list.loading}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            onSort={onSort}
            onPage={(page) => update({ page })}
            onRenamed={(next) =>
              setPatched((prev) => ({ ...prev, [next.id]: next }))
            }
          />
          {list.error && (
            <p className="text-xs text-red-400 mt-2">{list.error}</p>
          )}
        </div>
      </div>
    </div>
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
        className="inline-flex items-center gap-1.5 px-3 py-[5px] rounded-full border border-line-strong bg-cream text-ink text-[11px] font-bold uppercase tracking-[0.2px] hover:bg-paper disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Download size={14} />
        )}
        {t("Export all ")}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-44 rounded-lg bg-cream border border-line shadow-[0_12px_32px_rgba(14,14,16,0.14)] overflow-hidden z-10"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("csv")}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-paper disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {t("CSV (stats) ")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("gpx")}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-paper disabled:opacity-50 disabled:cursor-not-allowed transition border-t border-line"
          >
            {t("GPX (tracks) ")}
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="absolute right-0 top-full mt-2 text-xs text-red-400 whitespace-nowrap"
        >
          {t("Export failed: ")}
          {error}
        </p>
      )}
    </div>
  );
}
