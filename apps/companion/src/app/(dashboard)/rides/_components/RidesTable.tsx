"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import type { Translate } from "@/i18n";
import Link from "next/link";
import { useMemo } from "react";
import {
  DataTable,
  Mono,
  QualityBars,
  type DataTableColumn,
} from "@tarmoto/ui";
import { rideTypeLabel, scoreToQualityTier } from "@/lib/utils";
import { Pagination } from "@/components/Pagination";
import { useFormat } from "@/format/FormatProvider";
import type { Formatters } from "@tarmoto/shared";
import type { RideSummary, RidesQueryState, SortField } from "./useRidesQuery";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";

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
 * semantic `<table>` via the shared `DataTable`. Columns: DATE / RIDE /
 * KM-or-MI / DURATION / AVG / LEAN / QUALITY / →. DATE, the distance column,
 * DURATION, and QUALITY are sortable (backed by `useRidesQuery`'s sort
 * state); AVG (avg_speed) and LEAN (max_lean_angle) have no backend sort
 * field, so those headers are static. Each row links to the ride detail page
 * (`/rides/[rideId]`).
 */
function buildColumns(
  qualityEnabled: boolean,
  format: Formatters,
  t: Translate,
): DataTableColumn<RideSummary>[] {
  // The cell value converts to the rider's unit preference via
  // `splitDistanceKm`, so the header must too — a static "KM" would lie to
  // imperial riders. The magnitude passed here is arbitrary (unit short-forms
  // don't vary with it); this just reads off the same formatter the cells use.
  const distanceUnitLabel = format.unitLabel("distance");
  return [
    {
      key: "started_at",
      label: t("DATE"),
      size: "90px",
      sortable: true,
      render: (r) => (
        <Mono className="text-fg-dim">{format.shortDate(r.started_at)}</Mono>
      ),
    },
    {
      key: "ride",
      label: t("RIDE"),
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
            {t(rideTypeLabel(r.ride_type))}
          </Mono>
        </div>
      ),
    },
    {
      key: "distance_km",
      label: distanceUnitLabel,
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
      label: t("DURATION"),
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
      // Header carries the converting unit ("AVG KM/H" / "AVG MPH") so the
      // bare cell numbers can't be read in the wrong speed system.
      label: t("AVG {unit}", {
        unit: format.unitLabel("speed"),
      }),
      size: "84px",
      render: (r) => (
        <Mono className="text-ink">
          {r.avg_speed != null ? format.splitSpeed(r.avg_speed).value : "—"}
        </Mono>
      ),
    },
    {
      key: "lean",
      label: t("LEAN"),
      size: "70px",
      render: (r) => (
        <Mono className="text-ink">
          {r.max_lean_angle != null
            ? format.number(r.max_lean_angle, {
                style: "unit",
                unit: "degree",
                unitDisplay: "narrow",
                maximumFractionDigits: 0,
              })
            : "—"}
        </Mono>
      ),
    },
    ...(qualityEnabled
      ? [
          {
            // The whole column, not just its cells: it is `sortable`, so
            // leaving the header would keep a sort control for an axis the
            // operator has killed. `useRidesQuery` already refuses the
            // corresponding `sort=avg_road_quality`.
            key: "avg_road_quality" as const,
            label: t("QUALITY"),
            size: "110px",
            sortable: true,
            render: (r: RideSummary) => {
              const tier = scoreToQualityTier(r.avg_road_quality);
              return tier != null ? (
                <QualityBars q={tier} size={4} />
              ) : (
                <span className="text-fg-mute">—</span>
              );
            },
          },
        ]
      : []),
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
  const t = useTranslation();
  const format = useFormat();
  const { enabled: qualityEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const columns = useMemo(
    () => buildColumns(qualityEnabled, format, t),
    [qualityEnabled, format, t],
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Debounced: fast (re)fetches keep the table steady, no loading-text flash.
  const showLoading = useDelayedLoading(loading);
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
        // While a fast (re)fetch runs the empty row stays blank — "No rides
        // match" would flash a wrong message, and the loading text would
        // flash on every warm response.
        loading
          ? showLoading
            ? t("Loading rides…")
            : " "
          : t("No rides match these filters.")
      }
      // Pagination only when it earns its space — on a single page the arrows
      // are inert and the count already lives in the "All rides · N" tab badge,
      // so the last row sits flush to the card edge.
      footer={
        totalPages > 1 ? (
          <Pagination
            className="px-5 py-3"
            currentPage={state.page}
            pageCount={totalPages}
            onPrevious={() => onPage(state.page - 1)}
            onNext={() => onPage(state.page + 1)}
          />
        ) : undefined
      }
    />
  );
}
