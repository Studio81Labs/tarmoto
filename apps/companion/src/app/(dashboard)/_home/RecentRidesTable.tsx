"use client";
import Link from "next/link";
import {
  DataTable,
  Mono,
  QualityBars,
  type DataTableColumn,
} from "@tarmoto/ui";
import type { UserRide } from "@/hooks/useUserRides";
import {
  formatDurationCompact,
  formatShortDate,
  scoreToQualityTier,
} from "@/lib/utils";

/**
 * Home "recent rides" table. Renders a real semantic `<table>` via the shared
 * `DataTable`; each row links to the ride detail page. Mirrors the Ride
 * History table's columns minus LEAN, sorting, and pagination.
 */
const COLUMNS: DataTableColumn<UserRide>[] = [
  {
    key: "date",
    label: "DATE",
    size: "90px",
    render: (r) => (
      <Mono className="text-fg-dim">{formatShortDate(r.started_at)}</Mono>
    ),
  },
  {
    key: "ride",
    label: "RIDE",
    primary: true,
    render: (r) => (
      <span className="block truncate font-bold text-ink">
        {r.name ?? formatShortDate(r.started_at)}
      </span>
    ),
  },
  {
    key: "km",
    label: "KM",
    size: "80px",
    render: (r) => (
      <Mono className="font-bold text-ink">
        {r.distance_km != null ? Math.round(r.distance_km) : "—"}
      </Mono>
    ),
  },
  {
    key: "duration",
    label: "DURATION",
    size: "90px",
    render: (r) => (
      <Mono className="text-fg-dim">
        {formatDurationCompact(r.duration_min)}
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
    key: "quality",
    label: "QUALITY",
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

export function RecentRidesTable({ rides }: { rides: UserRide[] }) {
  return (
    <DataTable<UserRide>
      ariaLabel="Recent rides"
      columns={COLUMNS}
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
