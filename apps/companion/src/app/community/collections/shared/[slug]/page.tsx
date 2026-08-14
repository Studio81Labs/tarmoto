import { readLocale, t } from "@/i18n/server";
import Link from "next/link";
import type { Metadata } from "next";

import { notFound } from "next/navigation";
import {
  ArrowUpRight,
  Calendar,
  Route as RouteIcon,
  Shuffle,
} from "lucide-react";
import { Mono, Stamp } from "@tarmoto/ui";
import {
  fetchSharedCollection,
  fetchSharedCollectionPreview,
  stripCollectionQuality,
} from "@/lib/route-collection-share";
import { RouteCollectionVisibilityPill } from "@/components/RouteCollectionVisibilityPill";
import { UserAvatar } from "@/components/UserAvatar";
import { RouteCollectionFollowCta } from "@/components/RouteCollectionFollowCta";
import { CollectionRouteRow } from "@/components/community/collection-route-atoms";
import { getServerFormatters, readFormatPrefs } from "@/format/server";
import { CollectionPreviewMap } from "@/components/community/CollectionPreviewMap";
import { serverKillSwitch } from "@/lib/serverFlags";
import { formatRelativeTimeLabel } from "@tarmoto/shared";

/** Product wordmark; names are intentionally locale-independent. */
const WORDMARK = "TARMOTO";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const [detail, locale] = await Promise.all([
    fetchSharedCollection(slug),
    readLocale(),
    // t() reads the request-scoped number locale synchronously. Metadata has
    // no FormatProvider, so initialize that ref before rendering ICU `#`.
    readFormatPrefs(),
  ]);
  if (!detail) {
    return {
      title: t("Collection — Tarmoto", undefined, locale),
      robots: { index: false, follow: false },
    };
  }
  return {
    title: t("{title} — Tarmoto collection", { title: detail.title }, locale),
    description:
      detail.description ??
      t(
        "{count, plural, one {# curated route} other {# curated routes}} shared by {owner}",
        {
          count: detail.item_count,
          owner: detail.owner_name || t("a Tarmoto rider", undefined, locale),
        },
        locale,
      ),
    // Public collections are indexable; unlisted ones must stay out of the
    // index. We branch on the resolved visibility.
    robots:
      detail.visibility === "public"
        ? { index: true, follow: true }
        : { index: false, follow: false },
  };
}

export default async function SharedCollectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [locale, format, detail, preview, qualityEnabled] = await Promise.all([
    readLocale(),
    getServerFormatters(),
    fetchSharedCollection(slug),
    fetchSharedCollectionPreview(slug),
    serverKillSwitch("road_quality_overlay"),
  ]);
  if (!detail) notFound();

  // Preview carries the per-item summaries (#689), one entry per item; keep
  // collection (position) order. `preview === null` means the preview fetch
  // itself failed (the detail fetch is the source of truth for not-found), so
  // we distinguish that from a genuinely empty collection below.
  const previewFailed = preview === null && detail.item_count > 0;
  // Sanitize server-side, not in the row: these items are handed to
  // `CollectionPreviewMap`, a `"use client"` component whose props Next
  // serializes into the RSC Flight payload embedded in the HTML — so hiding
  // the quality bar in the browser would leave every score in `view-source:`
  // on a public share page.
  const sortedRoutes = preview
    ? [...preview.routes].sort((a, b) => a.position - b.position)
    : [];
  const routes = qualityEnabled
    ? sortedRoutes
    : stripCollectionQuality(sortedRoutes);
  const ownerName = detail.owner_name || "";
  const totalKm = routes.reduce((sum, r) => sum + (r.distance_km ?? 0), 0);
  // Value + unit from the SAME split call — pairing a unit-preference-aware
  // value with a hardcoded "KM" label would mislabel a miles figure for an
  // imperial viewer (this anonymous share page has no unit toggle of its
  // own, but the viewer's resolved unit preference still applies).

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
                {t("Shared collection")}
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

      <main className="mx-auto w-full max-w-[980px] flex-1 px-7 pb-16 pt-8">
        {/* hero */}
        <section className="mb-[26px] rounded-[14px] border border-line bg-cream p-[30px]">
          <div className="mb-2.5 flex items-center gap-3">
            <Stamp>{t("Route collection")}</Stamp>
            <RouteCollectionVisibilityPill
              visibility={detail.visibility}
              label={
                detail.visibility === "public"
                  ? t("Public", undefined, locale)
                  : detail.visibility === "unlisted"
                    ? t("Unlisted", undefined, locale)
                    : t("Private", undefined, locale)
              }
            />
          </div>
          <h1 className="font-sans text-[42px] font-extrabold leading-[1.04] tracking-[-0.5px] text-ink">
            {detail.title}
          </h1>
          {detail.description && (
            <p className="mt-3 max-w-2xl whitespace-pre-line text-[15px] text-fg-dim">
              {detail.description}
            </p>
          )}
          <div className="mt-[18px] flex flex-wrap gap-2.5">
            {ownerName && (
              <MetaChip>
                <UserAvatar name={ownerName} size={18} fontSize={9} />
                {ownerName}
              </MetaChip>
            )}
            <MetaChip>
              <Shuffle size={13} className="text-fg-mute" aria-hidden="true" />
              {t("{count, plural, one {# route} other {# routes}}", {
                count: detail.item_count,
              })}
            </MetaChip>
            <MetaChip>
              <Calendar size={13} className="text-fg-mute" aria-hidden="true" />
              {t("Updated {time}", {
                time: formatRelativeTimeLabel(detail.updated_at, { format }, t),
              })}
            </MetaChip>
          </div>
        </section>

        {/* map preview */}
        <Stamp className="mb-2.5 block">{t("Map preview")}</Stamp>
        <div className="mb-[30px]">
          <CollectionPreviewMap routes={routes} />
        </div>

        {/* routes */}
        <div className="mb-3 flex items-baseline justify-between">
          <Stamp>{t("Routes")}</Stamp>
          {routes.length > 0 && (
            <Mono className="text-[11px] text-fg-mute">
              {format.distanceKm(totalKm)}
            </Mono>
          )}
        </div>
        {previewFailed ? (
          <div
            role="alert"
            className="rounded-[14px] border border-quality-q1/30 bg-quality-q1/10 p-6 text-center text-sm text-quality-q1"
          >
            {t(
              "Couldn't load the routes in this collection right now. Try refreshing in a moment.",
            )}
          </div>
        ) : routes.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-line bg-cream p-10 text-center text-sm text-fg-dim">
            <RouteIcon
              size={36}
              className="mx-auto mb-2 text-fg-mute"
              aria-hidden="true"
            />
            {t("The owner hasn't added any routes to this collection yet.")}
          </div>
        ) : (
          <ul className="mb-[30px] flex flex-col gap-2.5">
            {routes.map((route, idx) => (
              <CollectionRouteRow
                key={route.item_id}
                route={route}
                index={idx + 1}
                author={ownerName}
                format={format}
                t={t}
              />
            ))}
          </ul>
        )}

        {/* owner notice / follow CTA */}
        <RouteCollectionFollowCta
          collectionId={detail.id}
          slug={detail.slug}
          ownerName={ownerName}
        />
      </main>

      {/* footer — brand line only. The header carries the public "Open in
          Tarmoto" entry and the auth-aware CTA block above the footer gives the
          owner a "manage from dashboard" link, so a second footer CTA would
          either duplicate the header or (when pointed at the protected
          dashboard) send anonymous share recipients to a login wall. */}
      <footer className="border-t border-line bg-paper">
        <div className="mx-auto flex max-w-[980px] items-center px-7 py-[22px]">
          <Mono className="text-[11px] tracking-[0.5px] text-fg-mute">
            {t("TARMOTO · SHARED VIA PUBLIC LINK · {year}", {
              year: new Date().getUTCFullYear(),
            })}
          </Mono>
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
