import { t } from "@/i18n";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowUpRight, Eye, MapPin, Route as RouteIcon } from "lucide-react";
import { MetricTile, Mono, Stamp } from "@tarmoto/ui";
import { fetchSharedMap } from "@/lib/map-share";
import {
  parseMapShareSnapshot,
  type MapShareSnapshot,
} from "@/lib/road-map-layer";
import { TIME_PERIOD_LABELS } from "@/lib/exploration";
import { formatDistance } from "@/lib/utils";
import { SharedMap } from "./SharedMap.client";

export const dynamic = "force-dynamic";

const DEFAULT_CENTER = { lat: 50.0755, lng: 14.4378, zoom: 7 };

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Shared road map — Tarmoto",
    description: "Public Tarmoto personal road map.",
    // Token URLs aren't sensitive but indexing them would let bots scrape
    // every share ever generated. Match the trip-shares policy.
    robots: { index: false, follow: false },
  };
}

/** Two-letter initials for the owner avatar. */
function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "T"
  );
}

export default async function SharedRoadMapPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const share = await fetchSharedMap(token);
  if (!share) notFound();
  const snapshot = parseMapShareSnapshot(share.snapshot);
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
                TARMOTO
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
                {snapshot.stats.percent_explored}
                {t("% explored")}
              </span>
            )}
          </div>
          <div className="mt-[18px] flex flex-wrap gap-2.5">
            {ownerName && (
              <MetaChip>
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accent text-[9px] font-extrabold text-ink">
                  {initials(ownerName)}
                </span>
                {ownerName}
              </MetaChip>
            )}
            <MetaChip>
              <Eye size={13} className="text-fg-mute" aria-hidden="true" />
              {share.view_count === 1
                ? t("1 view")
                : t("{count} views", { count: share.view_count })}
            </MetaChip>
            {snapshot && (
              <>
                <MetaChip>
                  <MapPin
                    size={13}
                    className="text-fg-mute"
                    aria-hidden="true"
                  />
                  {snapshot.segments.length.toLocaleString()}{" "}
                  {t("segments highlighted")}
                </MetaChip>
                <MetaChip>
                  <RouteIcon
                    size={13}
                    className="text-fg-mute"
                    aria-hidden="true"
                  />
                  {formatDistance(snapshot.stats.total_distance_km)}{" "}
                  {t("ridden")}
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
                segments={snapshot.segments}
              />
              <SnapshotLegend snapshot={snapshot} />
            </div>

            {/* stats — no region field in the snapshot, so 3 tiles. On a
                period share the segment count is period-filtered (matches the
                map) while distance/coverage stay lifetime totals, so each tile
                carries a scope label to explain the mix. */}
            <section className="mb-[30px] grid grid-cols-1 gap-3.5 sm:grid-cols-3">
              <MetricTile
                variant="ink"
                accentNumber
                label={t("Segments ridden")}
                // The highlighted (period-filtered) count, matching the map,
                // legend, and the "segments highlighted" hero chip.
                value={snapshot.segments.length}
                delta={
                  snapshot.period === "all"
                    ? undefined
                    : TIME_PERIOD_LABELS[snapshot.period]
                }
              />
              <MetricTile
                label={t("Distance ridden")}
                value={formatDistance(snapshot.stats.total_distance_km)}
                delta={snapshot.period === "all" ? undefined : t("All-time")}
              />
              <MetricTile
                label={t("Coverage")}
                value={`${snapshot.stats.percent_explored}%`}
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
            {t("TARMOTO · SHARED VIA PUBLIC LINK ·")}{" "}
            {new Date().getUTCFullYear()}
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

function SnapshotLegend({ snapshot }: { snapshot: MapShareSnapshot }) {
  return (
    <div className="pointer-events-none absolute left-4 top-4 z-10 space-y-1.5 rounded-[10px] border border-line-strong bg-cream px-3.5 py-3 text-[12px] font-semibold text-ink shadow-[0_6px_16px_rgba(14,14,16,0.08)]">
      <div className="flex items-center gap-2">
        <span className="inline-block h-1 w-[22px] rounded-sm bg-accent" />
        {t("Ridden ({count} segments)", {
          count: snapshot.segments.length.toLocaleString(),
        })}
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-block h-1 w-[22px] rounded-sm bg-[#C4BBA8]" />
        {t("Unridden")}
      </div>
    </div>
  );
}
