"use client";

import { useTranslation } from "@/i18n/I18nProvider";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, Loader2, X } from "lucide-react";
import { MetricTile, Stamp, type MetricTileProps } from "@tarmoto/ui";
import type { components } from "@tarmoto/openapi-client";
import { useFeature } from "@/hooks";
import { LockedStatTile } from "@/components/entitlements/LockedStatTile";
import { useFormat } from "@/format/FormatProvider";
import { rideTypeLabel as rideTypeMessage } from "@/lib/utils";

type RideDetail = components["schemas"]["RideDetailDto"];

export type RideDetailPanelState =
  | { status: "idle" }
  | { status: "loading"; rideId: string }
  | { status: "ready"; ride: RideDetail }
  | { status: "not-found"; rideId: string }
  | { status: "error"; rideId: string; message: string };

interface RideDetailSidebarProps {
  state: RideDetailPanelState;
  onClose: () => void;
  anchor?: "container" | "viewport";
}

/**
 * Right drawer for a "My rides" route clicked on the explorer. Mirrors the
 * segment/trip drawers' slide-in shell; content is the same ride-stat tiles the
 * rides/[id] page shows (distance · duration · speeds · lean · ascent).
 */
export function RideDetailSidebar({
  state,
  onClose,
  anchor = "container",
}: RideDetailSidebarProps) {
  const t = useTranslation();
  const open = state.status !== "idle";
  const [entered, setEntered] = useState(false);
  const [mounted, setMounted] = useState(open);
  const [snapshot, setSnapshot] = useState<RideDetailPanelState>(state);
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
      aria-label={t("Ride details")}
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
        <Stamp>{t("Ride")}</Stamp>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close ride details")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line-strong text-fg-dim transition hover:border-ink hover:text-ink"
        >
          <X size={15} />
        </button>
      </div>

      {snapshot.status === "loading" && (
        <StatusBlock
          icon={<Loader2 size={18} className="animate-spin" />}
          title={t("Loading ride")}
          body={t("Fetching the route and ride stats.")}
        />
      )}
      {snapshot.status === "not-found" && (
        <StatusBlock
          icon={<AlertTriangle size={18} />}
          title={t("Ride not found")}
          body={t("This ride may have been removed.")}
        />
      )}
      {snapshot.status === "error" && (
        <StatusBlock
          icon={<AlertTriangle size={18} />}
          title={t("Could not load this ride")}
          body={snapshot.message}
        />
      )}
      {snapshot.status === "ready" && <RideBody ride={snapshot.ride} />}
    </aside>
  );
}

function RideBody({ ride }: { ride: RideDetail }) {
  const t = useTranslation();
  const format = useFormat();
  const distance = format.splitDistanceKm(ride.distance_km ?? 0);
  const avgSpeed = format.splitSpeed(ride.avg_speed ?? 0);
  const topSpeed = format.splitSpeed(ride.max_speed ?? 0);
  const ascent = format.splitElevation(ride.elevation_gain ?? 0);
  const rideTypeLabel = t(rideTypeMessage(ride.ride_type));
  // Max lean + ascent (elevation gain) are `advanced_ride_stats` (Pro). Mirrors
  // the rides/[rideId] detail page precedence exactly: trust the last KNOWN
  // grant through a later refetch error — a cached ENABLED stays unlocked, a
  // cached DENIAL stays LOCKED (a revoked rider isn't re-exposed to stale
  // advanced fields on a refetch error). Only when no snapshot ever resolved AND
  // the lookup errored do we defer to the backend-gated payload; otherwise fail
  // closed. `dataUpdatedAt > 0` covers a retained snapshot, but a `/config/limits`
  // override `resetQueries` clears the cache AND `dataUpdatedAt`, so we also
  // latch the last RESOLVED grant in a ref (survives the reset on this mounted
  // component) and prefer it when the current snapshot carries none.
  const {
    enabled: advancedStatsEnabled,
    isError: advancedStatsError,
    isSuccess: advancedStatsResolved,
    dataUpdatedAt: advancedStatsDataUpdatedAt,
  } = useFeature("advanced_ride_stats");
  const lastResolvedEnabledRef = useRef<boolean | null>(null);
  if (advancedStatsResolved) {
    lastResolvedEnabledRef.current = advancedStatsEnabled;
  }
  const lastKnownEnabled =
    advancedStatsDataUpdatedAt > 0
      ? advancedStatsEnabled
      : lastResolvedEnabledRef.current;
  const advancedStatsLocked =
    lastKnownEnabled !== null
      ? !lastKnownEnabled
      : advancedStatsError
        ? false
        : true;

  const tiles: (MetricTileProps & { locked?: boolean })[] = [
    {
      label: t("Distance"),
      value: ride.distance_km != null ? distance.value : "—",
      unit: ride.distance_km != null ? distance.unit : "",
      unitPosition: distance.unitPosition,
      variant: "ink",
      accentNumber: true,
    },
    {
      label: t("Duration"),
      value:
        ride.duration_min != null ? format.duration(ride.duration_min) : "—",
    },
    {
      label: t("Avg speed"),
      value: ride.avg_speed != null ? avgSpeed.value : "—",
      unit: ride.avg_speed != null ? avgSpeed.unit : "",
      unitPosition: avgSpeed.unitPosition,
    },
    {
      label: t("Top speed"),
      value: ride.max_speed != null ? topSpeed.value : "—",
      unit: ride.max_speed != null ? topSpeed.unit : "",
      unitPosition: topSpeed.unitPosition,
    },
    {
      label: t("Max lean"),
      value:
        ride.max_lean_angle != null
          ? format.number(ride.max_lean_angle, {
              style: "unit",
              unit: "degree",
              unitDisplay: "narrow",
              maximumFractionDigits: 0,
            })
          : "—",
      locked: advancedStatsLocked,
    },
    {
      label: t("Ascent"),
      value: ride.elevation_gain != null ? ascent.value : "—",
      unit: ride.elevation_gain != null ? ascent.unit : "",
      unitPosition: ascent.unitPosition,
      accentNumber: true,
      locked: advancedStatsLocked,
    },
  ];

  return (
    <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
      <div>
        <h2 className="font-sans text-[19px] font-extrabold leading-tight tracking-[-0.4px] text-ink">
          {ride.name || format.date(ride.started_at)}
        </h2>
        <p className="mt-1 flex items-center gap-2 text-[12.5px] text-fg-dim">
          <span>{format.date(ride.started_at)}</span>
          <span className="rounded-full border border-line-strong px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[1px] text-fg-mute">
            {rideTypeLabel}
          </span>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {tiles.map((tile) =>
          tile.locked ? (
            <LockedStatTile key={tile.label} label={tile.label} />
          ) : (
            <MetricTile key={tile.label} {...tile} />
          ),
        )}
      </div>

      <Link
        href={`/rides/${ride.id}`}
        className="flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-ink px-3 py-2.5 text-[13px] font-bold text-cream transition hover:brightness-110"
      >
        {t("Open ride")}
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
