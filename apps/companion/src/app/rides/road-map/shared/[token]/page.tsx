import type { SupportedLocale } from "@/i18n";
import { getServerLocale, readLocale, t } from "@/i18n/server";
import Link from "next/link";
import type { Metadata } from "next";

import { notFound } from "next/navigation";
import { ArrowUpRight, Eye, MapPin, Route as RouteIcon } from "lucide-react";
import { MetricTile, Mono, Stamp } from "@tarmoto/ui";
import type { Formatters } from "@tarmoto/shared";
import { getServerFormatters } from "@/format/server";
import { UserAvatar } from "@/components/UserAvatar";
import { fetchSharedMap } from "@/lib/map-share";
import {
  parseMapShareSnapshot,
  stripSegmentQuality,
  type MapShareSnapshot,
} from "@/lib/road-map-layer";
import { timePeriodLabel } from "@/lib/exploration";
import { SharedMap } from "./SharedMap.client";

/** Product wordmark; names are intentionally locale-independent. */
const WORDMARK = "TARMOTO";

import { serverKillSwitch } from "@/lib/serverFlags";

export const dynamic = "force-dynamic";

const DEFAULT_CENTER = { lat: 50.0755, lng: 14.4378, zoom: 7 };

export async function generateMetadata(): Promise<Metadata> {
  const locale = await readLocale();
  return {
    title: t("Shared road map — Tarmoto", undefined, locale),
    description: t("Public Tarmoto personal road map.", undefined, locale),
    // Token URLs aren't sensitive but indexing them would let bots scrape
    // every share ever generated. Match the trip-shares policy.
    robots: { index: false, follow: false },
  };
}

export default async function SharedRoadMapPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const format = await getServerFormatters();
  // Concurrently — independent reads, and this is a public page.
  const [share, qualityEnabled] = await Promise.all([
    fetchSharedMap(token),
    serverKillSwitch("road_quality_overlay"),
  ]);
  if (!share) notFound();
  // `t` here is the server-bound translator from `@/i18n/server`, so every
  // direct call below already defaults to the per-request `getServerLocale()`.
  // `SnapshotLegend` is a plain helper (not itself bound to the server `t`),
  // so `locale` is still resolved here and threaded to it as an explicit prop.
  const locale = getServerLocale();
  const snapshot = parseMapShareSnapshot(share.snapshot);
  // Strip AFTER the parse: `isRiddenSegment` requires `last_quality_score` to
  // be present, and these segments then cross into `SharedMap`, a client
  // component whose props are serialized into the RSC Flight payload embedded
  // in the HTML — so gating the popover in the browser would leave every
  // score readable in `view-source:` regardless.
  const segments =
    snapshot === null
      ? []
      : qualityEnabled
        ? snapshot.segments
        : stripSegmentQuality(snapshot.segments);
  const initialCenter = snapshot?.initial_center ?? DEFAULT_CENTER;
  const ownerName = share.owner_name || "";

  return (
    <div className="flex min-h-screen flex-col bg-cream text-ink">
      {/* sticky brand header */}
      <header className="sticky top-0 z-30 border-b border-line bg-cream/[0.86] backdrop-blur-md backdrop-saturate-150">
        <div className="mx-auto flex h-[60px] max-w-[980px] items-center justify-between gap-4 px-7">
          <Link href="/" className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-accent">
              <svg
                width="17"
                height="17"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path d="M 3 15 L 10 4 L 17 15 Z" fill="#0E0E10" />
              </svg>
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="text-[14px] font-extrabold tracking-[-0.2px]">
                {WORDMARK}
              </span>
              <span className="text-fg-mute">/</span>
              <Mono className="truncate text-[11px] text-fg-dim">
                {t("Shared road map")}
              </Mono>
            </span>
          </Link>
          <Link
            href="/"
            className="inline-flex shrink-0 items-center gap-2 rounded-[10px] border border-line-strong px-4 py-2.5 text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper"
          >
            <ArrowUpRight size={14} aria-hidden="true" />
            {t("Open in Tarmoto")}
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[980px] flex-1 px-7 pb-8 pt-8">
        {/* hero */}
        <section className="mb-6 rounded-[14px] border border-line bg-cream p-[30px]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <Stamp tone="accent">{t("Personal road map")}</Stamp>
              <h1 className="mt-2 font-sans text-[40px] font-extrabold leading-[1.04] tracking-[-0.5px] text-ink">
                {share.title}
              </h1>
            </div>
            {snapshot && (
              <span className="shrink-0 rounded-full bg-accent px-2.5 py-1.5 text-[11px] font-bold tracking-[0.2px] text-ink">
                {t("{percent} explored", {
                  percent: format.number(
                    snapshot.stats.percent_explored / 100,
                    {
                      style: "percent",
                      maximumFractionDigits: 0,
                    },
                  ),
                })}
              </span>
            )}
          </div>
          <div className="mt-[18px] flex flex-wrap gap-2.5">
            {ownerName && (
              <MetaChip>
                <UserAvatar name={ownerName} size={18} fontSize={9} />
                {ownerName}
              </MetaChip>
            )}
            <MetaChip>
              <Eye size={13} className="text-fg-mute" aria-hidden="true" />
              {t("{count, plural, one {{n} view} other {{n} views}}", {
                count: share.view_count,
                n: format.integer(share.view_count),
              })}
            </MetaChip>
            {snapshot && (
              <>
                <MetaChip>
                  <MapPin
                    size={13}
                    className="text-fg-mute"
                    aria-hidden="true"
                  />
                  {format.integer(snapshot.segments.length)}{" "}
                  {t("segments highlighted")}
                </MetaChip>
                <MetaChip>
                  <RouteIcon
                    size={13}
                    className="text-fg-mute"
                    aria-hidden="true"
                  />
                  {format.distanceKm(snapshot.stats.total_distance_km)}{" "}
                  {/* `total_distance_km` is a lifetime total even on a period
                      share, so flag the scope next to the period-filtered
                      "segments highlighted" chip. */}
                  {snapshot.period === "all"
                    ? t("ridden")
                    : t("ridden all-time")}
                </MetaChip>
              </>
            )}
          </div>
        </section>

        {snapshot ? (
          <>
            {/* map */}
            <div className="relative mb-6 h-[540px] overflow-hidden rounded-[14px] border border-line">
              <SharedMap
                initialCenter={initialCenter}
                segments={segments}
                // The server already CONFIRMED the kill. `useFeatureKillSwitch`
                // inside fails safe, so on its own it reports enabled until its
                // browser request settles — and stays that way if that request
                // fails.
                qualityOverlayKilled={!qualityEnabled}
              />
              {/* The legend labels the two map layers ("Ridden" / "Unridden"),
                  both of which are hidden under the kill — leaving it up
                  describes overlays that are not on the page. */}
              {qualityEnabled ? (
                <SnapshotLegend
                  snapshot={snapshot}
                  format={format}
                  locale={locale}
                />
              ) : null}
            </div>

            {/* stats — no region field in the snapshot, so 3 tiles. On a
                period share the segment count is period-filtered (matches the
                map) while distance/coverage stay lifetime totals, so each tile
                carries a scope label to explain the mix. */}
            <section className="mb-[30px] grid grid-cols-1 gap-3.5 sm:grid-cols-3">
              <MetricTile
                variant="ink"
                accentNumber
                formatValue={format.integer}
                label={t("Segments ridden")}
                // The highlighted (period-filtered) count, matching the map,
                // legend, and the "segments highlighted" hero chip.
                value={snapshot.segments.length}
                delta={
                  snapshot.period === "all"
                    ? undefined
                    : timePeriodLabel(snapshot.period, t)
                }
              />
              <MetricTile
                label={t("Distance ridden")}
                value={format.distanceKm(snapshot.stats.total_distance_km)}
                delta={snapshot.period === "all" ? undefined : t("All-time")}
              />
              <MetricTile
                label={t("Coverage")}
                value={format.number(snapshot.stats.percent_explored / 100, {
                  style: "percent",
                  maximumFractionDigits: 0,
                })}
                delta={snapshot.period === "all" ? undefined : t("All-time")}
              />
            </section>
          </>
        ) : (
          <div className="mb-6 rounded-[14px] border border-dashed border-line bg-cream p-8 text-center text-sm text-fg-dim">
            {t(
              "This shared road map's snapshot is in an unexpected format — the owner may have generated it with a newer version of the companion. Ask them to regenerate the share link.",
            )}
          </div>
        )}

        {/* conversion banner */}
        <div className="flex flex-wrap items-center justify-between gap-5 rounded-[14px] bg-ink p-[26px] text-cream">
          <div className="min-w-0">
            {/* Brand coral (#E05A3C). `Stamp`'s tones don't include coral, and
                the only coral token is the quality scale's `q1` (flagged
                "avoid" for non-quality use), so spell the stamp out here. */}
            <span className="font-mono text-[11px] font-bold uppercase leading-none tracking-[1.6px] text-[#E05A3C]">
              {t("Every road you ride")}
            </span>
            <div className="mt-1.5 text-[20px] font-extrabold">
              {t("Start your own road map")}
            </div>
            <p className="mt-1 max-w-xl text-[13px] text-cream/70">
              {t(
                "Tarmoto layers every ride onto a regional map so you can see — and chase — the roads you haven't ridden yet.",
              )}
            </p>
          </div>
          <Link
            href="/"
            className="inline-flex shrink-0 items-center gap-2 rounded-[10px] border border-accent bg-accent px-4 py-2.5 text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
          >
            {t("Get Tarmoto")}
          </Link>
        </div>
      </main>

      {/* footer */}
      <footer className="border-t border-line bg-paper">
        <div className="mx-auto flex max-w-[980px] flex-wrap items-center justify-between gap-4 px-7 py-[22px]">
          <Mono className="text-[11px] tracking-[0.5px] text-fg-mute">
            {t("TARMOTO · SHARED VIA PUBLIC LINK · {year}", {
              year: new Date().getUTCFullYear(),
            })}
          </Mono>
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-[10px] border border-line-strong px-4 py-2.5 text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper"
          >
            {t("Build your road map")}
          </Link>
        </div>
      </footer>
    </div>
  );
}

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[7px] whitespace-nowrap rounded-full border border-line-strong bg-cream px-[13px] py-[7px] text-[12.5px] font-semibold text-fg-dim">
      {children}
    </span>
  );
}

function SnapshotLegend({
  snapshot,
  format,
  locale,
}: {
  snapshot: MapShareSnapshot;
  format: Formatters;
  locale: SupportedLocale;
}) {
  return (
    <div className="pointer-events-none absolute left-4 top-4 z-10 space-y-1.5 rounded-[10px] border border-line-strong bg-cream px-3.5 py-3 text-[12px] font-semibold text-ink shadow-[0_6px_16px_rgba(14,14,16,0.08)]">
      <div className="flex items-center gap-2">
        <span className="inline-block h-1 w-[22px] rounded-sm bg-accent" />
        {t(
          "{count, plural, one {Ridden ({n} segment)} other {Ridden ({n} segments)}}",
          {
            count: snapshot.segments.length,
            n: format.integer(snapshot.segments.length),
          },
          locale,
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-block h-1 w-[22px] rounded-sm bg-[#C4BBA8]" />
        {t("Unridden", undefined, locale)}
      </div>
    </div>
  );
}
