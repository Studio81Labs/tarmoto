import { t } from "@/i18n";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Activity, CalendarDays, Plus, Sparkles } from "lucide-react";
import { Card, Stamp, MetricTile } from "@tarmoto/ui";
import { getServerFormatters } from "@/format/server";
import { RouteEmbedPanel } from "./_components/RouteEmbedPanel";
import {
  PublicShareFooter,
  PublicShareHeader,
  SharedRoutePreviewCard,
  SharePill,
  splitDuration,
} from "@/components/public-share";
import { buildRoutePreview } from "@/lib/ride-detail";
import { fetchSharedRide } from "@/lib/shared-rides";
import { siteUrl } from "@/lib/site";
import { formatRideType } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Shared ride — Tarmoto",
    description: "Public Tarmoto shared ride page.",
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
  const pageUrl = `${siteUrl()}/rides/shared/${token}`;
  const origin = new URL(pageUrl).origin;
  // 640-unit preview matches the design's coordinate space so the route casing,
  // shadow, accent strokes, and A/B markers scale to the same proportions.
  const preview = buildRoutePreview(ride.route_geometry, 640, 48);
  const rideLabel = `${ride.rider_name} · ${formatRideType(ride.ride_type)} ride`;

  const distance =
    ride.distance_km != null ? format.splitDistanceKm(ride.distance_km) : null;
  const duration = splitDuration(ride.duration_min, format);

  return (
    <div className="min-h-screen bg-cream text-ink">
      <PublicShareHeader breadcrumb={t("Shared ride")} />

      <main className="mx-auto max-w-[980px] px-7 pb-16 pt-8">
        {/* Hero */}
        <Card className="mb-6 p-[30px]">
          <Stamp tone="accent" as="div" className="mb-3">
            {t("Public route share")}
          </Stamp>
          <h1 className="font-sans text-[42px] font-extrabold leading-[1.04] tracking-[-0.5px] text-ink">
            {t("{riderName}'s {rideType} ride", {
              riderName: ride.rider_name,
              rideType: formatRideType(ride.ride_type).toLowerCase(),
            })}
          </h1>
          <p className="mt-3 max-w-[680px] text-[15px] leading-[1.55] text-fg-dim">
            {t(
              "Shared from Tarmoto for blogs, forums, and ride reports. Each page load counts as a view, and widget CTA clicks are tracked separately.",
            )}
          </p>
          <div className="mt-[18px] flex flex-wrap gap-2.5">
            <SharePill icon={<CalendarDays size={13} />}>
              {format.relativeTime(ride.started_at)}
            </SharePill>
            <SharePill icon={<Activity size={13} />}>
              {t("{count} views", { count: ride.view_count })}
            </SharePill>
            <SharePill icon={<Sparkles size={13} />}>
              {ride.embed_click_count === 1
                ? t("1 embed click")
                : t("{count} embed clicks", { count: ride.embed_click_count })}
            </SharePill>
          </div>
        </Card>

        {/* Route preview */}
        <SharedRoutePreviewCard
          preview={preview}
          label={`${ride.rider_name} route preview`}
          title={t("Route preview")}
          subtitle={t(
            "Snapshot of the shared route and its current ride metrics.",
          )}
          emptyText={t("Route preview unavailable for this shared ride.")}
        />

        {/* Stat tiles */}
        <div className="mb-6 grid grid-cols-2 gap-3.5 md:grid-cols-4">
          <MetricTile
            label={t("Distance")}
            value={distance ? distance.value : "—"}
            variant="ink"
            accentNumber
            {...(distance?.unit !== undefined ? { unit: distance.unit } : {})}
          />
          <MetricTile
            label={t("Duration")}
            value={duration.value}
            {...(duration.unit !== undefined ? { unit: duration.unit } : {})}
          />
          <MetricTile
            label={t("Quality")}
            value={
              ride.avg_road_quality != null
                ? format.decimal(ride.avg_road_quality, 1)
                : "—"
            }
            {...(ride.avg_road_quality != null ? { unit: "/5" } : {})}
          />
          <MetricTile
            label={t("Curviness")}
            value={
              ride.avg_curviness != null
                ? format.decimal(ride.avg_curviness, 1)
                : "—"
            }
          />
        </div>

        {/* Embed widget */}
        <RouteEmbedPanel
          origin={origin}
          token={token}
          rideLabel={rideLabel}
          views={ride.view_count}
          clicks={ride.embed_click_count}
        />
      </main>

      <PublicShareFooter
        cta={{
          href: "/register",
          label: t("Save to my Tarmoto"),
          icon: <Plus size={14} />,
        }}
        year={new Date().getFullYear()}
      />
    </div>
  );
}
