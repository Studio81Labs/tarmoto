"use client";

import { t } from "@/i18n";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, Loader2, MapPin, X } from "lucide-react";
import { MetricTile, Stamp, type MetricTileProps } from "@tarmoto/ui";
import type { TripDetail, Waypoint } from "@/lib/types";
import { useFormat } from "@/format/FormatProvider";
import type { EnglishMessageKey } from "@/i18n";

export type TripDetailPanelState =
  | { status: "idle" }
  | { status: "loading"; tripId: string }
  | { status: "ready"; trip: TripDetail }
  | { status: "error"; tripId: string; message: string };

interface TripDetailSidebarProps {
  state: TripDetailPanelState;
  onClose: () => void;
  /** See SegmentDetailSidebar — "viewport" is the full-window right drawer. */
  anchor?: "container" | "viewport";
}

const STATUS_LABEL: Record<TripDetail["status"], EnglishMessageKey> = {
  draft: "Draft",
  planned: "Planned",
  active: "Active",
  completed: "Completed",
};

// Partial — "via" (the majority of stops) renders through the position-based
// start/finish/via branches below instead, never through this map.
const WAYPOINT_ROLE: Partial<Record<Waypoint["type"], EnglishMessageKey>> = {
  start: "Start",
  end: "Finish",
  fuel: "Fuel",
  rest: "Rest",
  photo: "Photo",
  accommodation: "Stay",
};

/**
 * Right drawer for a "My trips" route clicked on the explorer. Mirrors
 * SegmentDetailSidebar's slide-in shell; content is the planner-style summary
 * (distance · ride time · days · elevation) plus the trip's stops.
 */
export function TripDetailSidebar({
  state,
  onClose,
  anchor = "container",
}: TripDetailSidebarProps) {
  const open = state.status !== "idle";
  const [entered, setEntered] = useState(false);
  const [mounted, setMounted] = useState(open);
  const [snapshot, setSnapshot] = useState<TripDetailPanelState>(state);
  useEffect(() => {
    if (open) {
      setSnapshot(state);
      setMounted(true);
    }
  }, [state, open]);
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!mounted || snapshot.status === "idle") return null;

  return (
    <aside
      role="dialog"
      aria-label={t("Trip details")}
      onTransitionEnd={(e) => {
        if (
          !open &&
          e.target === e.currentTarget &&
          e.propertyName === "transform"
        ) {
          setMounted(false);
        }
      }}
      className={`${
        anchor === "viewport" ? "fixed z-50" : "absolute z-20"
      } inset-x-0 bottom-0 flex max-h-[85%] flex-col border-t border-line bg-cream shadow-2xl transition-transform duration-200 ease-out md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[430px] md:border-l md:border-t-0 ${
        entered
          ? "translate-y-0 md:translate-x-0"
          : "translate-y-full md:translate-y-0 md:translate-x-full"
      }`}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 pb-3.5 pt-[18px]">
        <Stamp>{t("Trip")}</Stamp>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close trip details")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line-strong text-fg-dim transition hover:border-ink hover:text-ink"
        >
          <X size={15} />
        </button>
      </div>

      {snapshot.status === "loading" && (
        <StatusBlock
          icon={<Loader2 size={18} className="animate-spin" />}
          title={t("Loading trip")}
          body={t("Fetching the route, distance and stops. ")}
        />
      )}
      {snapshot.status === "error" && (
        <StatusBlock
          icon={<AlertTriangle size={18} />}
          title={t("Could not load this trip")}
          body={snapshot.message}
        />
      )}
      {snapshot.status === "ready" && <TripBody trip={snapshot.trip} />}
    </aside>
  );
}

function TripBody({ trip }: { trip: TripDetail }) {
  const format = useFormat();
  const distanceKm =
    trip.distance_km ??
    trip.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  const durationMin = trip.days.reduce(
    (sum, day) => sum + (day.durationMinutes ?? 0),
    0,
  );
  const elevationM = trip.days.reduce(
    (sum, day) => sum + (day.elevationGain ?? 0),
    0,
  );
  const waypoints = trip.days.flatMap((day) => day.waypoints);
  const elevation = format.splitElevation(elevationM);

  const tiles: MetricTileProps[] = [
    {
      label: t("Distance"),
      value: distanceKm > 0 ? format.distanceKm(distanceKm) : "—",
      variant: "ink",
      accentNumber: true,
    },
    {
      label: t("Ride time"),
      value: durationMin > 0 ? format.duration(durationMin) : "—",
    },
    { label: t("Days"), value: String(trip.days.length || trip.num_days) },
    {
      label: t("Elevation"),
      value: elevationM > 0 ? elevation.value : "—",
      ...(elevationM > 0 ? { unit: elevation.unit } : {}),
      accentNumber: true,
    },
  ];

  return (
    <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
      <div>
        <h2 className="font-sans text-[19px] font-extrabold leading-tight tracking-[-0.4px] text-ink">
          {trip.name}
        </h2>
        <p className="mt-1 flex items-center gap-2 text-[12.5px] text-fg-dim">
          {trip.region ? <span>{trip.region}</span> : null}
          <span className="rounded-full border border-line-strong px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[1px] text-fg-mute">
            {t(STATUS_LABEL[trip.status])}
          </span>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {tiles.map((tile) => (
          <MetricTile key={tile.label} {...tile} />
        ))}
      </div>

      {waypoints.length > 0 && (
        <div>
          <Stamp as="h3" className="mb-2 block">
            {t("Stops")}
          </Stamp>
          <ul className="space-y-1.5">
            {waypoints.map((wp, index) => {
              const role =
                index === 0
                  ? t("Start")
                  : index === waypoints.length - 1
                    ? t("Finish")
                    : t(WAYPOINT_ROLE[wp.type] ?? "Via");
              return (
                <li
                  key={wp.id}
                  className="flex items-center gap-2.5 rounded-[10px] border border-line bg-paper px-3 py-2"
                >
                  <MapPin size={13} className="shrink-0 text-fg-mute" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {wp.name ?? role}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] font-bold uppercase tracking-[1px] text-fg-mute">
                    {role}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Link
        href={`/trips/${trip.id}`}
        className="flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-ink px-3 py-2.5 text-[13px] font-bold text-cream transition hover:brightness-110"
      >
        {t("Open in planner")}
        <ArrowUpRight size={15} strokeWidth={2.5} />
      </Link>
    </div>
  );
}

function StatusBlock({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="text-fg-dim">{icon}</span>
      <p className="text-[14px] font-bold text-ink">{title}</p>
      <p className="max-w-[280px] text-[12.5px] text-fg-dim">{body}</p>
    </div>
  );
}
