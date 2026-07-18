import { t } from "@/i18n";
import { getServerLocale, readLocale } from "@/i18n/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Activity, CalendarDays, Plus } from "lucide-react";
import { Card, Stamp, MetricTile } from "@tarmoto/ui";
import { getServerFormatters } from "@/format/server";
import {
  PublicShareFooter,
  PublicShareHeader,
  SharedRoutePreviewCard,
  SharePill,
  splitDuration,
} from "@/components/public-share";
import { buildRoutePreview } from "@/lib/ride-detail";
import { fetchSharedRide } from "@/lib/shared-rides";
import { formatRideType } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await readLocale();
  return {
    title: t("Shared ride — Tarmoto", undefined, locale),
    description: t("Public Tarmoto shared ride page.", undefined, locale),
    robots: { index: false, follow: false },
  };
}

export default async function SharedRidePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const format = await getServerFormatters();
  const ride = await fetchSharedRide(token);
  if (!ride) notFound();
  // This server component awaits before rendering, so resolve the request
  // locale from the per-request store and thread it explicitly into every
  // t() call below — the module-global t() default can be stomped by a
  // concurrent request at the await/Suspense boundary (see i18n/server.ts).
  const locale = getServerLocale();
  // 640-unit preview matches the design's coordinate space so the route casing,
  // shadow, accent strokes, and A/B markers scale to the same proportions.
  const preview = buildRoutePreview(ride.route_geometry, 640, 48);

  const distance =
    ride.distance_km != null ? format.splitDistanceKm(ride.distance_km) : null;
  const duration = splitDuration(ride.duration_min, format);

  return (
    <div className="min-h-screen bg-cream text-ink">
      <PublicShareHeader breadcrumb={t("Shared ride", undefined, locale)} />

      <main className="mx-auto max-w-[980px] px-7 pb-16 pt-8">
        {/* Hero */}
        <Card className="mb-6 p-[30px]">
          <Stamp tone="accent" as="div" className="mb-3">
            {t("Public route share", undefined, locale)}
          </Stamp>
          <h1 className="font-sans text-[42px] font-extrabold leading-[1.04] tracking-[-0.5px] text-ink">
            {t(
              "{riderName}'s {rideType} ride",
              {
                riderName: ride.rider_name,
                rideType: formatRideType(ride.ride_type).toLowerCase(),
              },
              locale,
            )}
          </h1>
          <p className="mt-3 max-w-[680px] text-[15px] leading-[1.55] text-fg-dim">
            {t(
              "Shared from Tarmoto for blogs, forums, and ride reports. Each page load counts as a view.",
              undefined,
              locale,
            )}
          </p>
          <div className="mt-[18px] flex flex-wrap gap-2.5">
            <SharePill icon={<CalendarDays size={13} />}>
              {format.relativeTime(ride.started_at)}
            </SharePill>
            <SharePill icon={<Activity size={13} />}>
              {t(
                "{count, plural, one {{n} view} other {{n} views}}",
                {
                  count: ride.view_count,
                  n: format.integer(ride.view_count),
                },
                locale,
              )}
            </SharePill>
          </div>
        </Card>

        {/* Route preview */}
        <SharedRoutePreviewCard
          preview={preview}
          label={t("{label} route preview", { label: ride.rider_name }, locale)}
          title={t("Route preview", undefined, locale)}
          subtitle={t(
            "Snapshot of the shared route and its current ride metrics.",
            undefined,
            locale,
          )}
          emptyText={t(
            "Route preview unavailable for this shared ride.",
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
            {...(distance?.unit !== undefined ? { unit: distance.unit } : {})}
          />
          <MetricTile
            label={t("Duration", undefined, locale)}
            value={duration.value}
            {...(duration.unit !== undefined ? { unit: duration.unit } : {})}
          />
          <MetricTile
            label={t("Quality", undefined, locale)}
            value={
              ride.avg_road_quality != null
                ? format.decimal(ride.avg_road_quality, 1)
                : "—"
            }
            {...(ride.avg_road_quality != null ? { unit: "/5" } : {})}
          />
          <MetricTile
            label={t("Curviness", undefined, locale)}
            value={
              ride.avg_curviness != null
                ? format.decimal(ride.avg_curviness, 1)
                : "—"
            }
          />
        </div>
      </main>

      <PublicShareFooter
        cta={{
          href: "/register",
          label: t("Save to my Tarmoto", undefined, locale),
          icon: <Plus size={14} />,
        }}
        year={new Date().getFullYear()}
      />
    </div>
  );
}
