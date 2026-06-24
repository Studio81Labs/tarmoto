"use client";
import { t } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Mountain } from "lucide-react";
import { MetricTile, Mono, QualityBars, Stamp } from "@tarmoto/ui";
import {
  ApiError,
  communityTripsApi,
  type PublicTripDetailResponse,
  type RouteCollectionPreviewItem,
} from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { UserAvatar } from "@/components/UserAvatar";
import { CollectionPreviewMap } from "@/components/community/CollectionPreviewMap";
import { StatusPill } from "@/components/community/collection-route-atoms";
import { formatDistance, formatDuration } from "@/lib/utils";

type TripDay = PublicTripDetailResponse["days"][number];

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; trip: PublicTripDetailResponse }
  | { phase: "not-found" }
  | { phase: "error"; message: string };

/**
 * Read-only community trip detail (#713 follow-up). Opened from a collection's
 * route rows on the discover view; the backend (`GET /community/trips/:id`)
 * serves a non-member only when the trip is exposed through a discoverable
 * collection, and masks the invite code + member roster. Mirrors the cream
 * collection-detail layout (header + metric tiles + map + day rows) rather than
 * the owner's editable planner.
 */
export default function CommunityTripDetailPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    // Gate on the token hydrating so the first fetch is authenticated — a
    // member reaching their own trip from a private collection relies on the
    // caller id, and the optional-auth endpoint reads it from the bearer.
    if (!tripId || !authReady) return;
    let cancelled = false;
    setLoad({ phase: "loading" });
    communityTripsApi
      .getPublic(tripId)
      .then(({ data }) => {
        if (cancelled) return;
        setLoad({ phase: "ready", trip: data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setLoad({ phase: "not-found" });
          return;
        }
        setLoad({
          phase: "error",
          message: err instanceof Error ? err.message : "Failed to load trip",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [tripId, authReady]);

  if (load.phase === "loading") {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <div className="h-8 w-48 animate-pulse rounded bg-paper" />
        <div className="mt-4 h-[140px] animate-pulse rounded-[14px] bg-paper" />
      </div>
    );
  }
  if (load.phase === "not-found") {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <BackLink />
        <p className="mt-8 text-center text-sm text-fg-dim">
          {t("This trip is private or no longer available.")}
        </p>
      </div>
    );
  }
  if (load.phase === "error") {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <BackLink />
        <p role="alert" className="mt-8 text-center text-sm text-quality-q1">
          {t("Couldn't load this trip right now.")}
        </p>
      </div>
    );
  }

  return <TripDetail trip={load.trip} />;
}

function TripDetail({ trip }: { trip: PublicTripDetailResponse }) {
  const days = useMemo(() => trip.days ?? [], [trip.days]);
  const totalKm =
    trip.distance_km ?? days.reduce((s, d) => s + d.distance_km, 0);
  const totalMinutes = days.reduce((s, d) => s + d.estimated_time_min, 0);

  // Reuse the collection preview map by projecting each day's polyline into the
  // preview-item shape it renders ([lng, lat] pairs, one item per day).
  const mapRoutes = useMemo<RouteCollectionPreviewItem[]>(
    () =>
      days.map((d, i) => ({
        item_id: d.id,
        position: i,
        kind: "trip" as const,
        target_id: trip.id,
        lines: [d.route_geometry.map((p) => [p.lng, p.lat])],
        title: d.title,
        num_days: null,
        distance_km: d.distance_km,
        status: trip.status,
        quality_avg: d.avg_quality,
      })),
    [days, trip.id, trip.status],
  );

  return (
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      <BackLink />

      <header className="mb-5">
        <h1 className="break-words font-sans text-[32px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
          {trip.title}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-fg-dim">
          <StatusPill status={trip.status} />
          {trip.region && (
            <>
              <span className="text-fg-mute">·</span>
              <span>{trip.region}</span>
            </>
          )}
          {trip.owner_name && (
            <>
              <span className="text-fg-mute">·</span>
              {trip.owner_id ? (
                <Link
                  href={`/community/${encodeURIComponent(trip.owner_id)}`}
                  className="inline-flex items-center gap-1.5 transition hover:text-ink"
                >
                  <UserAvatar name={trip.owner_name} size={20} fontSize={10} />
                  {trip.owner_name}
                </Link>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <UserAvatar name={trip.owner_name} size={20} fontSize={10} />
                  {trip.owner_name}
                </span>
              )}
            </>
          )}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        <MetricTile
          variant="ink"
          accentNumber
          label={t("Riding days")}
          value={trip.num_days}
        />
        <MetricTile
          label={t("Total distance")}
          value={formatDistance(totalKm)}
        />
        <MetricTile
          label={t("Est. time")}
          value={formatDuration(totalMinutes)}
        />
        <MetricTile
          label={t("Avg quality")}
          value={trip.quality_avg != null ? trip.quality_avg.toFixed(1) : "—"}
        />
      </section>

      <Stamp className="mb-2.5 mt-6 block">{t("Map preview")}</Stamp>
      <CollectionPreviewMap routes={mapRoutes} />

      <div className="mb-3 mt-[30px] flex items-baseline justify-between">
        <Stamp>{t("Itinerary")}</Stamp>
        {days.length > 0 && (
          <Mono className="text-[11px] text-fg-mute">
            {Math.round(totalKm).toLocaleString()} {t("KM")}
          </Mono>
        )}
      </div>
      {days.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-line bg-cream p-10 text-center text-sm text-fg-dim">
          {t("This trip has no planned days yet.")}
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {days.map((day) => (
            <DayRow key={day.id} day={day} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DayRow({ day }: { day: TripDay }) {
  return (
    <li className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] border border-line bg-cream p-3.5 sm:gap-3.5">
      <Mono className="text-center text-[16px] font-extrabold text-fg-mute">
        {day.day_number}
      </Mono>
      <div className="min-w-0">
        <div className="truncate text-[15px] font-bold text-ink">
          {day.title?.trim() || t("Day {n}", { n: day.day_number })}
        </div>
        <Mono className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] uppercase text-fg-mute">
          <span>
            {Math.round(day.distance_km)} {t("KM")}
          </span>
          {day.estimated_time_min > 0 && (
            <>
              <span>·</span>
              <span>{formatDuration(day.estimated_time_min)}</span>
            </>
          )}
          {day.elevation_gain > 0 && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-0.5">
                <Mountain size={11} aria-hidden="true" />
                {Math.round(day.elevation_gain)} m
              </span>
            </>
          )}
        </Mono>
      </div>
      <div className="justify-self-end">
        {day.avg_quality > 0 && <QualityBars q={day.avg_quality} size={5} />}
      </div>
    </li>
  );
}

function BackLink() {
  return (
    <Link
      href="/community/collections"
      className="mb-4 inline-flex items-center gap-1 text-sm text-fg-dim transition hover:text-ink"
    >
      <ArrowLeft size={16} />
      {t("Collections")}
    </Link>
  );
}
