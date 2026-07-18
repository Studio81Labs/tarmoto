"use client";
import { t } from "@/i18n";
import Link from "next/link";
import { useMemo } from "react";
import {
  DataTable,
  Mono,
  QualityBars,
  type DataTableColumn,
} from "@tarmoto/ui";
import type { UserRide } from "@/hooks/useUserRides";
import { scoreToQualityTier } from "@/lib/utils";
import { useFormat } from "@/format/FormatProvider";
import type { Formatters } from "@tarmoto/shared";

/**
 * Home "recent rides" table. Renders a real semantic `<table>` via the shared
 * `DataTable`; each row links to the ride detail page. Mirrors the Ride
 * History table's columns minus LEAN, sorting, and pagination.
 */
function buildColumns(format: Formatters): DataTableColumn<UserRide>[] {
  return [
    {
      key: "date",
      label: t("DATE"),
      size: "90px",
      render: (r) => (
        <Mono className="text-fg-dim">{format.shortDate(r.started_at)}</Mono>
      ),
    },
    {
      key: "ride",
      label: t("RIDE"),
      primary: true,
      render: (r) => (
        <span className="block truncate font-bold text-ink">
          {r.name ?? format.shortDate(r.started_at)}
        </span>
      ),
    },
    {
      key: "km",
      // Header speaks the same unit as the converting cells below —
      // same derivation as the ride-history table.
      label: format.splitDistanceKm(1).unit.toUpperCase(),
      size: "80px",
      render: (r) => (
        <Mono className="font-bold text-ink">
          {r.distance_km != null
            ? format.splitDistanceKm(r.distance_km).value
            : "—"}
        </Mono>
      ),
    },
    {
      key: "duration",
      label: t("DURATION"),
      size: "90px",
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
      // Header carries the converting unit so the bare cell numbers can't
      // be read in the wrong speed system — same as the ride-history table.
      label: t("AVG {unit}", { unit: format.splitSpeed(1).unit.toUpperCase() }),
      size: "84px",
      render: (r) => (
        <Mono className="text-ink">
          {r.avg_speed != null ? format.splitSpeed(r.avg_speed).value : "—"}
        </Mono>
      ),
    },
    {
      key: "quality",
      label: t("QUALITY"),
      size: "90px",
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

export function RecentRidesTable({ rides }: { rides: UserRide[] }) {
  const format = useFormat();
  const columns = useMemo(() => buildColumns(format), [format]);
  return (
    <DataTable<UserRide>
      ariaLabel={t("Recent rides")}
      columns={columns}
      rows={rides}
      rowKey={(r) => r.id}
      getRowHref={(r) => `/rides/${r.id}`}
      renderLink={({ href, className, children }) => (
        <Link href={href} className={className}>
          {children}
        </Link>
      )}
    />
  );
}
