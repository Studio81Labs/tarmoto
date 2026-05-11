import { t } from "@/i18n";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Eye, MapPin, Route as RouteIcon, User } from "lucide-react";
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
    // The owner's exploration data isn't sensitive, but indexing token URLs
    // would let search bots scrape every share that's ever been generated.
    // Match the trip-shares policy.
    robots: { index: false, follow: false },
  };
}
export default async function SharedRoadMapPage({
  params,
}: {
  params: Promise<{
    token: string;
  }>;
}) {
  const { token } = await params;
  const share = await fetchSharedMap(token);
  if (!share) notFound();
  const snapshot = parseMapShareSnapshot(share.snapshot);
  const initialCenter = snapshot?.initial_center ?? DEFAULT_CENTER;
  return (
    <main className="tarmoto-no-cream min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-4">
        <nav className="mb-2 text-xs text-slate-500">
          <Link href="/" className="hover:text-slate-300">
            {t("Tarmoto ")}
          </Link>
          <span className="mx-2">/</span>
          <span>{t("Shared road map")}</span>
        </nav>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-tarmoto-cyan">
              {t("Personal road map ")}
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight">
              {share.title}
            </h1>
          </div>
          {snapshot && (
            <div className="px-3 py-1.5 rounded-xl bg-tarmoto-cyan/10 text-tarmoto-cyan font-semibold text-sm tabular-nums">
              {t("{percent}% explored", {
                percent: snapshot.stats.percent_explored,
              })}
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-sm text-slate-300">
          <Pill icon={<User size={14} />}>{share.owner_name}</Pill>
          <Pill icon={<Eye size={14} />}>
            {t("{count} views", { count: share.view_count })}
          </Pill>
          {snapshot && (
            <>
              <Pill icon={<MapPin size={14} />}>
                {t("{count} segments highlighted", {
                  count: snapshot.segments.length.toLocaleString(),
                })}
              </Pill>
              <Pill icon={<RouteIcon size={14} />}>
                {t("{distance} ridden", {
                  distance: formatDistance(snapshot.stats.total_distance_km),
                })}
              </Pill>
              <Pill>{TIME_PERIOD_LABELS[snapshot.period]}</Pill>
            </>
          )}
        </div>
      </header>

      {snapshot ? (
        <section className="relative" style={{ height: "calc(100vh - 140px)" }}>
          <SharedMap
            initialCenter={initialCenter}
            segments={snapshot.segments}
          />
          <SnapshotLegend snapshot={snapshot} />
        </section>
      ) : (
        <section className="px-6 py-10">
          <div className="mx-auto max-w-md rounded-2xl border border-slate-800 bg-slate-900/70 p-5 text-sm text-slate-400">
            {t(
              "This shared road map's snapshot is in an unexpected format \u2014 the owner may have generated it with a newer version of the companion. Ask them to regenerate the share link. ",
            )}
          </div>
        </section>
      )}

      <footer className="border-t border-slate-800 px-6 py-4 text-center text-xs text-slate-500">
        {t("Shared via Tarmoto \u00B7")}{" "}
        <Link href="/rides/road-map" className="hover:text-slate-300">
          {t("Build your own road map ")}
        </Link>
      </footer>
    </main>
  );
}
function SnapshotLegend({ snapshot }: { snapshot: MapShareSnapshot }) {
  return (
    <div className="absolute top-4 left-4 z-10 rounded-xl bg-slate-950/80 border border-slate-800 backdrop-blur px-4 py-3 text-xs text-slate-300 space-y-2 pointer-events-none">
      <div className="flex items-center gap-2">
        <span className="h-1 w-6 rounded-full bg-tarmoto-cyan" />
        {t("Ridden ({count} segments)", {
          count: snapshot.segments.length.toLocaleString(),
        })}
      </div>
      <div className="flex items-center gap-2">
        <span className="h-1 w-6 rounded-full bg-slate-600" />
        {t("Unridden ")}
      </div>
    </div>
  );
}
function Pill({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-950/60 px-2.5 py-1">
      {icon}
      {children}
    </span>
  );
}
