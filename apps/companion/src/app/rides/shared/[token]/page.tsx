import { t } from "@/i18n";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  ArrowUpRight,
  Activity,
  CalendarDays,
  Plus,
  Sparkles,
} from "lucide-react";
import { Card, Mono, Stamp, MetricTile, TarmotoMark } from "@tarmoto/ui";
import { RouteEmbedPanel } from "./_components/RouteEmbedPanel";
import { buildRoutePreview } from "@/lib/ride-detail";
import { fetchSharedRide } from "@/lib/shared-rides";
import { siteUrl } from "@/lib/site";
import {
  formatDurationCompact,
  formatRelativeTime,
  formatRideType,
  splitFormattedDistance,
} from "@/lib/utils";

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
  const ride = await fetchSharedRide(token);
  if (!ride) notFound();
  const pageUrl = `${siteUrl()}/rides/shared/${token}`;
  const origin = new URL(pageUrl).origin;
  // 640-unit preview matches the design's coordinate space so the route casing,
  // shadow, accent strokes, and A/B markers scale to the same proportions.
  const preview = buildRoutePreview(ride.route_geometry, 640, 48);
  const rideLabel = `${ride.rider_name} · ${formatRideType(ride.ride_type)} ride`;

  const distance =
    ride.distance_km != null
      ? splitFormattedDistance(ride.distance_km, "metric")
      : null;
  const duration = splitDuration(ride.duration_min);

  return (
    <div className="min-h-screen bg-cream text-ink">
      {/* Sticky public header — logo + breadcrumb + an entry point back into
          the app, mirroring the in-app ride detail chrome. */}
      <header className="sticky top-0 z-30 border-b border-line bg-cream/[0.86] backdrop-blur-[12px] backdrop-saturate-[1.4]">
        <div className="mx-auto flex h-[60px] max-w-[980px] items-center justify-between gap-4 px-7">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-lg bg-accent">
              <TarmotoMark size={17} />
            </span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-sm font-extrabold tracking-tight">
                {t("TARMOTO")}
              </span>
              <span className="text-ink/40">/</span>
              <Mono className="truncate text-[11px] text-fg-dim">
                {t("Shared ride")}
              </Mono>
            </div>
          </div>
          <CtaLink
            href="/login"
            variant="outline"
            icon={<ArrowUpRight size={14} />}
          >
            {t("Open in Tarmoto")}
          </CtaLink>
        </div>
      </header>

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
            <Pill icon={<CalendarDays size={13} />}>
              {formatRelativeTime(ride.started_at)}
            </Pill>
            <Pill icon={<Activity size={13} />}>
              {t("{count} views", { count: ride.view_count })}
            </Pill>
            <Pill icon={<Sparkles size={13} />}>
              {ride.embed_click_count === 1
                ? t("1 embed click")
                : t("{count} embed clicks", { count: ride.embed_click_count })}
            </Pill>
          </div>
        </Card>

        {/* Route preview */}
        <Card className="mb-6 p-6">
          <div className="text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
            {t("Route preview")}
          </div>
          <p className="mt-1 text-[13.5px] text-fg-dim">
            {t("Snapshot of the shared route and its current ride metrics.")}
          </p>
          <div className="relative mt-[18px] overflow-hidden rounded-xl border border-line">
            {preview ? (
              <>
                <RoutePreviewSvg
                  path={preview.path}
                  viewBox={preview.viewBox}
                  width={preview.width}
                  height={preview.height}
                  label={`${ride.rider_name} route preview`}
                />
                <div className="absolute bottom-4 left-4 flex gap-4 rounded-[10px] border border-line-strong bg-cream px-3 py-2.5 shadow-[0_6px_16px_rgba(14,14,16,0.08)]">
                  <LegendDot label={t("Start")} ink />
                  <LegendDot label={t("Finish")} />
                </div>
              </>
            ) : (
              <div className="flex h-[280px] items-center justify-center bg-paper-2 text-sm text-fg-dim">
                {t("Route preview unavailable for this shared ride.")}
              </div>
            )}
          </div>
        </Card>

        {/* Stat tiles */}
        <div className="mb-6 grid grid-cols-2 gap-3.5 md:grid-cols-4">
          <MetricTile
            label={t("Distance")}
            value={distance ? distance.value : "—"}
            unit={distance?.unit}
            variant="ink"
            accentNumber
          />
          <MetricTile
            label={t("Duration")}
            value={duration.value}
            unit={duration.unit}
          />
          <MetricTile
            label={t("Quality")}
            value={
              ride.avg_road_quality != null
                ? ride.avg_road_quality.toFixed(1)
                : "—"
            }
            unit={ride.avg_road_quality != null ? "/5" : undefined}
          />
          <MetricTile
            label={t("Curviness")}
            value={
              ride.avg_curviness != null ? ride.avg_curviness.toFixed(1) : "—"
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

      {/* Footer */}
      <footer className="border-t border-line bg-paper-2">
        <div className="mx-auto flex max-w-[980px] flex-wrap items-center justify-between gap-4 px-7 py-[22px]">
          <Mono className="text-[11px] tracking-[0.5px] text-fg-mute">
            {t("TARMOTO · SHARED VIA PUBLIC LINK · {year}", {
              year: new Date().getFullYear(),
            })}
          </Mono>
          <CtaLink href="/register" variant="ink" icon={<Plus size={14} />}>
            {t("Save to my Tarmoto")}
          </CtaLink>
        </div>
      </footer>
    </div>
  );
}

/**
 * Cream route preview built from the shared ride's geometry. Three stacked
 * strokes (casing → ink shadow → accent) plus A/B endpoint markers, matching
 * the in-app ride-detail route styling. Stroke and marker sizes scale with the
 * fitted viewBox so narrow or square routes stay legible.
 */
function RoutePreviewSvg({
  path,
  viewBox,
  width,
  height,
  label,
}: {
  path: string;
  viewBox: string;
  width: number;
  height: number;
  label: string;
}) {
  const dim = Math.max(width, height);
  const casingW = dim * 0.014;
  const shadowW = dim * 0.0094;
  const accentW = dim * 0.007;
  const markerR = dim * 0.02;
  const markerFont = dim * 0.019;
  const ends = previewEndpoints(path);
  return (
    <svg
      viewBox={viewBox}
      role="img"
      aria-label={label}
      preserveAspectRatio="xMidYMid meet"
      className="block h-auto max-h-[460px] w-full bg-paper-2"
    >
      <path
        d={path}
        fill="none"
        stroke="#C4BBA8"
        strokeWidth={casingW}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={path}
        fill="none"
        stroke="#0E0E10"
        strokeWidth={shadowW}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.18}
      />
      <path
        d={path}
        fill="none"
        stroke="#FF6A1A"
        strokeWidth={accentW}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {ends && (
        <g>
          <circle
            cx={ends.start.x}
            cy={ends.start.y}
            r={markerR}
            fill="#0E0E10"
            stroke="#F5EFE6"
            strokeWidth={markerR * 0.19}
          />
          <text
            x={ends.start.x}
            y={ends.start.y + markerFont * 0.34}
            textAnchor="middle"
            fill="#F5EFE6"
            fontFamily="var(--font-jetbrains, monospace)"
            fontSize={markerFont}
            fontWeight={800}
          >
            A
          </text>
          <circle
            cx={ends.end.x}
            cy={ends.end.y}
            r={markerR}
            fill="#FF6A1A"
            stroke="#0E0E10"
            strokeWidth={markerR * 0.15}
          />
          <text
            x={ends.end.x}
            y={ends.end.y + markerFont * 0.34}
            textAnchor="middle"
            fill="#0E0E10"
            fontFamily="var(--font-jetbrains, monospace)"
            fontSize={markerFont}
            fontWeight={800}
          >
            B
          </text>
        </g>
      )}
    </svg>
  );
}

/** First and last projected point of the SVG path (the route endpoints). */
function previewEndpoints(
  path: string,
): { start: { x: number; y: number }; end: { x: number; y: number } } | null {
  const nums = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (!nums || nums.length < 4) return null;
  return {
    start: { x: nums[0]!, y: nums[1]! },
    end: { x: nums[nums.length - 2]!, y: nums[nums.length - 1]! },
  };
}

function LegendDot({ label, ink = false }: { label: string; ink?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`grid h-4 w-4 place-items-center rounded-full ${
          ink ? "bg-ink text-cream" : "bg-accent text-ink"
        }`}
      >
        <span className="font-mono text-[9px] font-extrabold">
          {ink ? "A" : "B"}
        </span>
      </span>
      <span className="text-[11px] font-semibold text-ink">{label}</span>
    </div>
  );
}

function Pill({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line-strong bg-cream px-[13px] py-[7px] text-[12.5px] font-semibold text-fg-dim">
      <span className="flex text-fg-mute">{icon}</span>
      {children}
    </span>
  );
}

/**
 * Public-page CTA. Plain styled `<Link>` (not the `Button` atom) so the page
 * stays a server component with no client island just for navigation.
 */
function CtaLink({
  href,
  children,
  icon,
  variant,
}: {
  href: string;
  children: ReactNode;
  icon: ReactNode;
  variant: "outline" | "ink";
}) {
  return (
    <Link
      href={href}
      className={`inline-flex flex-shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] transition ${
        variant === "ink"
          ? "border border-ink bg-ink text-cream hover:bg-ink/90"
          : "border border-line-strong bg-transparent text-ink hover:bg-paper-2"
      }`}
    >
      {icon}
      {children}
    </Link>
  );
}

/** Duration split into a big value + small unit for the MetricTile. */
function splitDuration(min: number | null): { value: string; unit?: string } {
  if (min == null) return { value: "—" };
  const compact = formatDurationCompact(min); // "4h 12m" or "52m"
  const space = compact.indexOf(" ");
  if (space < 0) return { value: compact };
  return { value: compact.slice(0, space), unit: compact.slice(space + 1) };
}
