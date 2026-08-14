import { readLocale, t } from "@/i18n/server";
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
import { serverKillSwitch } from "@/lib/serverFlags";
import { formatRelativeTimeLabel } from "@tarmoto/shared";

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
  // Concurrently: the two reads are independent, so awaiting them in sequence
  // would add the flags round trip to a page whose ride had already arrived.
  const [ride, qualityEnabled] = await Promise.all([
    fetchSharedRide(token),
    serverKillSwitch("road_quality_overlay"),
  ]);
  if (!ride) notFound();
  // 640-unit preview matches the design's coordinate space so the route casing,
  // shadow, accent strokes, and A/B markers scale to the same proportions.
  const preview = buildRoutePreview(ride.route_geometry, 640, 48);

  const distance =
    ride.distance_km != null ? format.splitDistanceKm(ride.distance_km) : null;
  const duration = splitDuration(ride.duration_min, format);

  return (
    <div className="min-h-screen bg-cream text-ink">
      <PublicShareHeader breadcrumb={t("Shared ride")} t={t} />

      <main className="mx-auto max-w-[980px] px-7 pb-16 pt-8">
        {/* Hero */}
        <Card className="mb-6 p-[30px]">
          <Stamp tone="accent" as="div" className="mb-3">
            {t("Public route share")}
          </Stamp>
          <h1 className="font-sans text-[42px] font-extrabold leading-[1.04] tracking-[-0.5px] text-ink">
            {t(
              "{rideType, select, free {{riderName}'s free ride} commute {{riderName}'s commute ride} trip {{riderName}'s trip ride} tracked {{riderName}'s tracked ride} other {{riderName}'s ride}}",
              {
                riderName: ride.rider_name,
                rideType: ride.ride_type,
              },
            )}
          </h1>
          <p className="mt-3 max-w-[680px] text-[15px] leading-[1.55] text-fg-dim">
            {t(
              "Shared from Tarmoto for blogs, forums, and ride reports. Each page load counts as a view.",
            )}
          </p>
          <div className="mt-[18px] flex flex-wrap gap-2.5">
            <SharePill icon={<CalendarDays size={13} />}>
              {formatRelativeTimeLabel(ride.started_at, { format }, t)}
            </SharePill>
            <SharePill icon={<Activity size={13} />}>
              {t("{count, plural, one {{n} view} other {{n} views}}", {
                count: ride.view_count,
                n: format.integer(ride.view_count),
              })}
            </SharePill>
          </div>
        </Card>

        {/* Route preview */}
        <SharedRoutePreviewCard
          preview={preview}
          label={t("{label} route preview", { label: ride.rider_name })}
          title={t("Route preview")}
          subtitle={t(
            "Snapshot of the shared route and its current ride metrics.",
          )}
          emptyText={t("Route preview unavailable for this shared ride.")}
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
          <MetricTile label={t("Duration")} {...duration} />
          {/* Omit the tile outright when the operator has killed the overlay.
              An em dash in its place still tells a visitor the figure exists
              and is being withheld — and this is a public page, so the value
              would otherwise be rendered straight into the HTML. The grid
              reflows to three tiles. */}
          {qualityEnabled ? (
            <MetricTile
              label={t("Quality")}
              value={
                ride.avg_road_quality != null
                  ? t("{score} / {max}", {
                      score: format.decimal(ride.avg_road_quality, 1),
                      max: format.integer(5),
                    })
                  : "—"
              }
            />
          ) : null}
          <MetricTile
            label={t("Curviness")}
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
          label: t("Save to my Tarmoto"),
          icon: <Plus size={14} />,
        }}
        year={new Date().getFullYear()}
        t={t}
      />
    </div>
  );
}
