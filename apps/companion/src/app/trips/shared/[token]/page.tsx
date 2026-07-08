import { t } from "@/i18n";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  Activity,
  CalendarDays,
  MapPin,
  Route as RouteIcon,
} from "lucide-react";
import { Card, Stamp, MetricTile } from "@tarmoto/ui";
import {
  PublicShareFooter,
  PublicShareHeader,
  SharedRoutePreviewCard,
  SharePill,
  splitDuration,
} from "@/components/public-share";
import { buildRoutePreviewFromLines } from "@/lib/ride-detail";
import {
  fetchSharedTrip,
  parseTripSnapshot,
  tripRouteLines,
  tripStops,
  tripSummary,
} from "@/lib/trip-share";
import { splitFormattedDistance } from "@/lib/utils";
import { SharedTripJoinCta } from "./SharedTripJoinCta";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Shared trip — Tarmoto",
    description: "Public Tarmoto shared trip page.",
    robots: { index: false, follow: false },
  };
}

export default async function SharedTripPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const share = await fetchSharedTrip(token);
  if (!share) notFound();
  const trip = parseTripSnapshot(share.snapshot);
  const summary = trip ? tripSummary(trip) : null;
  const stops = trip ? tripStops(trip) : [];
  // 640-unit space + per-day lines so the preview matches the ride page's
  // proportions and multi-day trips don't get artificial day-to-day connectors.
  // Stop waypoints are dotted onto the same preview.
  const preview = trip
    ? buildRoutePreviewFromLines(tripRouteLines(trip), 640, 48, stops)
    : null;

  const distance =
    summary != null
      ? splitFormattedDistance(summary.totalDistanceKm, "metric")
      : null;
  // A trip is a plan, so its time is an estimate: prefer the snapshot's
  // per-day durations, and fall back to a 55 km/h heuristic (matching the
  // backend) when the planner didn't record any.
  const estMinutes =
    summary == null
      ? null
      : summary.totalDurationMin > 0
        ? summary.totalDurationMin
        : summary.totalDistanceKm > 0
          ? Math.round((summary.totalDistanceKm / 55) * 60)
          : null;
  const duration = splitDuration(estMinutes);

  return (
    <div className="min-h-screen bg-cream text-ink">
      <PublicShareHeader breadcrumb={t("Shared trip")} />

      <main className="mx-auto max-w-[980px] px-7 pb-16 pt-8">
        {/* Hero */}
        <Card className="mb-6 p-[30px]">
          <Stamp tone="accent" as="div" className="mb-3">
            {t("Public trip share")}
          </Stamp>
          <h1 className="font-sans text-[42px] font-extrabold leading-[1.04] tracking-[-0.5px] text-ink">
            {share.title}
          </h1>
          <p className="mt-3 max-w-[680px] text-[15px] leading-[1.55] text-fg-dim">
            {share.trip_id
              ? t(
                  "A planned Tarmoto trip. Sign in to join the group plan, suggest route changes, and vote with the riders.",
                )
              : t(
                  "A read-only preview of a planned Tarmoto trip. You can view the route without an account.",
                )}
          </p>
          <div className="mt-[18px] flex flex-wrap gap-2.5">
            <SharePill icon={<RouteIcon size={13} />}>
              {share.owner_name}
            </SharePill>
            <SharePill icon={<Activity size={13} />}>
              {t("{count} views", { count: share.view_count })}
            </SharePill>
            {summary && (
              <SharePill icon={<CalendarDays size={13} />}>
                {summary.dayCount === 1
                  ? t("1 day")
                  : t("{count} days", { count: summary.dayCount })}
              </SharePill>
            )}
          </div>
        </Card>

        {/* Join */}
        <SharedTripJoinCta
          token={share.share_token}
          title={share.title}
          tripId={share.trip_id}
        />

        {trip && summary ? (
          <>
            {/* Route preview */}
            <SharedRoutePreviewCard
              preview={preview}
              label={`${share.title} route preview`}
              title={t("Route preview")}
              subtitle={t(
                "Simplified overview of the planned route across all days.",
              )}
              emptyText={t("Route preview unavailable for this shared trip.")}
            />

            {/* Stat tiles */}
            <div className="mb-6 grid grid-cols-2 gap-3.5 md:grid-cols-4">
              <MetricTile
                label={t("Distance")}
                value={distance ? distance.value : "—"}
                variant="ink"
                accentNumber
                {...(distance?.unit !== undefined
                  ? { unit: distance.unit }
                  : {})}
              />
              <MetricTile label={t("Days")} value={summary.dayCount} />
              <MetricTile
                label={t("Est. time")}
                value={duration.value}
                {...(duration.unit !== undefined
                  ? { unit: duration.unit }
                  : {})}
              />
              <MetricTile label={t("Stops")} value={summary.waypointCount} />
            </div>
          </>
        ) : (
          <Card className="mb-6 p-6 text-sm text-fg-dim">
            {t(
              "This shared trip's snapshot is in an unexpected format — the owner may have saved it with a newer version of the planner. Ask them to regenerate the share link.",
            )}
          </Card>
        )}
      </main>

      <PublicShareFooter
        cta={{
          href: "/trips/planner",
          label: t("Plan your own trip"),
          icon: <MapPin size={14} />,
        }}
        year={new Date().getFullYear()}
      />
    </div>
  );
}
