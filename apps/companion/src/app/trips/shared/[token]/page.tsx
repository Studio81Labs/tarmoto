import { t } from "@/i18n";
import { getServerLocale, readLocale } from "@/i18n/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  Activity,
  CalendarDays,
  MapPin,
  Route as RouteIcon,
} from "lucide-react";
import { Card, Stamp, MetricTile } from "@tarmoto/ui";
import { getServerFormatters } from "@/format/server";
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
import { SharedTripJoinCta } from "./SharedTripJoinCta";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await readLocale();
  return {
    title: t("Shared trip — Tarmoto", undefined, locale),
    description: t("Public Tarmoto shared trip page.", undefined, locale),
    robots: { index: false, follow: false },
  };
}

export default async function SharedTripPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const format = await getServerFormatters();
  const share = await fetchSharedTrip(token);
  if (!share) notFound();
  // This server component awaits before rendering, so resolve the request
  // locale from the per-request store and thread it explicitly into every
  // t() call below — the module-global t() default can be stomped by a
  // concurrent request at the await/Suspense boundary (see i18n/server.ts).
  const locale = getServerLocale();
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
    summary != null ? format.splitDistanceKm(summary.totalDistanceKm) : null;
  // A trip is a plan, so its time is an estimate: prefer the snapshot's
  // per-day durations, and fall back to a 55 km/h heuristic with a 30-minute
  // floor (matching the backend GPX/from-share import) when the planner didn't
  // record any, so a short legacy share doesn't underreport at e.g. "11m".
  const estMinutes =
    summary == null
      ? null
      : summary.totalDurationMin > 0
        ? summary.totalDurationMin
        : summary.totalDistanceKm > 0
          ? Math.max(30, Math.round((summary.totalDistanceKm / 55) * 60))
          : null;
  const duration = splitDuration(estMinutes, format);

  return (
    <div className="min-h-screen bg-cream text-ink">
      <PublicShareHeader breadcrumb={t("Shared trip", undefined, locale)} />

      <main className="mx-auto max-w-[980px] px-7 pb-16 pt-8">
        {/* Hero */}
        <Card className="mb-6 p-[30px]">
          <Stamp tone="accent" as="div" className="mb-3">
            {t("Public trip share", undefined, locale)}
          </Stamp>
          <h1 className="font-sans text-[42px] font-extrabold leading-[1.04] tracking-[-0.5px] text-ink">
            {share.title}
          </h1>
          <p className="mt-3 max-w-[680px] text-[15px] leading-[1.55] text-fg-dim">
            {share.trip_id
              ? t(
                  "A planned Tarmoto trip. Sign in to join the group plan, suggest route changes, and vote with the riders.",
                  undefined,
                  locale,
                )
              : t(
                  "A read-only preview of a planned Tarmoto trip. You can view the route without an account.",
                  undefined,
                  locale,
                )}
          </p>
          <div className="mt-[18px] flex flex-wrap gap-2.5">
            <SharePill icon={<RouteIcon size={13} />}>
              {share.owner_name}
            </SharePill>
            <SharePill icon={<Activity size={13} />}>
              {t(
                "{count, plural, one {{n} view} other {{n} views}}",
                {
                  count: share.view_count,
                  n: format.integer(share.view_count),
                },
                locale,
              )}
            </SharePill>
            {summary && (
              <SharePill icon={<CalendarDays size={13} />}>
                {t(
                  "{count, plural, one {# day} other {# days}}",
                  {
                    count: summary.dayCount,
                  },
                  locale,
                )}
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
              label={t("{title} route preview", { title: share.title }, locale)}
              title={t("Route preview", undefined, locale)}
              subtitle={t(
                "Simplified overview of the planned route across all days.",
                undefined,
                locale,
              )}
              emptyText={t(
                "Route preview unavailable for this shared trip.",
                undefined,
                locale,
              )}
            />

            {/* Stat tiles */}
            <div className="mb-6 grid grid-cols-2 gap-3.5 md:grid-cols-4">
              <MetricTile
                label={t("Distance", undefined, locale)}
                value={distance ? distance.value : "—"}
                variant="ink"
                accentNumber
                {...(distance?.unit !== undefined
                  ? { unit: distance.unit }
                  : {})}
              />
              <MetricTile
                label={t("Days", undefined, locale)}
                value={summary.dayCount}
              />
              <MetricTile
                label={t("Est. time", undefined, locale)}
                value={duration.value}
                {...(duration.unit !== undefined
                  ? { unit: duration.unit }
                  : {})}
              />
              <MetricTile
                label={t("Stops", undefined, locale)}
                value={stops.length}
              />
            </div>
          </>
        ) : (
          <Card className="mb-6 p-6 text-sm text-fg-dim">
            {t(
              "This shared trip's snapshot is in an unexpected format — the owner may have saved it with a newer version of the planner. Ask them to regenerate the share link.",
              undefined,
              locale,
            )}
          </Card>
        )}
      </main>

      <PublicShareFooter
        cta={{
          href: "/trips/planner",
          label: t("Plan your own trip", undefined, locale),
          icon: <MapPin size={14} />,
        }}
        year={new Date().getFullYear()}
      />
    </div>
  );
}
