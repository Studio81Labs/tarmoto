import { readLocale, t } from "@/i18n/server";
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
  ShareUnavailable,
  splitDuration,
} from "@/components/public-share";
import { serverKillSwitch } from "@/lib/serverFlags";
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
  // Before the fetch: a moderation kill has to stop this route reading the
  // shared trip at all, not just stop it rendering one.
  const [format, communityEnabled] = await Promise.all([
    getServerFormatters(),
    serverKillSwitch("community_access"),
  ]);
  // Independent of the `trip_planning` gate inside `SharedTripJoinCta`, which
  // removes only the JOIN action and deliberately leaves the preview up. This
  // one is about the published content itself, so the whole page goes.
  if (!communityEnabled) {
    return (
      <ShareUnavailable
        breadcrumb={t("Shared trip")}
        year={new Date().getFullYear()}
        t={t}
      />
    );
  }
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
      <PublicShareHeader breadcrumb={t("Shared trip")} t={t} />

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
              {t("{count, plural, one {{n} view} other {{n} views}}", {
                count: share.view_count,
                n: format.integer(share.view_count),
              })}
            </SharePill>
            {summary && (
              <SharePill icon={<CalendarDays size={13} />}>
                {t("{count, plural, one {# day} other {# days}}", {
                  count: summary.dayCount,
                })}
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
              label={t("{title} route preview", { title: share.title })}
              title={t("Route preview")}
              subtitle={t(
                "Simplified overview of the planned route across all days.",
              )}
              emptyText={t("Route preview unavailable for this shared trip.")}
              t={t}
            />

            {/* Stat tiles */}
            <div className="mb-6 grid grid-cols-2 gap-3.5 md:grid-cols-4">
              <MetricTile
                label={t("Distance")}
                value={distance ? distance.value : "—"}
                variant="ink"
                accentNumber
                unit={distance?.unit ?? ""}
                unitPosition={distance?.unitPosition ?? "after"}
              />
              <MetricTile
                label={t("Days")}
                value={summary.dayCount}
                formatValue={format.integer}
              />
              <MetricTile label={t("Est. time")} {...duration} />
              <MetricTile
                label={t("Stops")}
                value={stops.length}
                formatValue={format.integer}
              />
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
          // Killed planning makes this the page's one CTA a dead end.
          feature: "trip_planning",
        }}
        year={new Date().getFullYear()}
        t={t}
      />
    </div>
  );
}
