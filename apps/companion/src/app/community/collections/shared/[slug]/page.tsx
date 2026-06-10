import { t } from "@/i18n";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  ArrowUpRight,
  Calendar,
  Route as RouteIcon,
  Shuffle,
} from "lucide-react";
import { Mono, QualityBars, Stamp } from "@tarmoto/ui";
import {
  fetchSharedCollection,
  fetchSharedCollectionPreview,
} from "@/lib/route-collection-share";
import { RouteCollectionVisibilityPill } from "@/components/RouteCollectionVisibilityPill";
import { RouteCollectionFollowCta } from "@/components/RouteCollectionFollowCta";
import {
  RouteThumb,
  StatusPill,
} from "@/components/community/collection-route-atoms";
import { formatRelativeTime } from "@/lib/utils";
import type { RouteCollectionPreviewItem } from "@/lib/api";
import { CollectionPreviewMap } from "./_components/CollectionPreviewMap";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const detail = await fetchSharedCollection(slug);
  if (!detail) {
    return {
      title: "Collection — Tarmoto",
      robots: { index: false, follow: false },
    };
  }
  return {
    title: `${detail.title} — Tarmoto collection`,
    description:
      detail.description ??
      `${detail.item_count} curated route${detail.item_count === 1 ? "" : "s"} shared by ${detail.owner_name || "a Tarmoto rider"}`,
    // Public collections are indexable; unlisted ones must stay out of the
    // index. We branch on the resolved visibility.
    robots:
      detail.visibility === "public"
        ? { index: true, follow: true }
        : { index: false, follow: false },
  };
}

/** Two-letter initials for the owner avatar. Empty string → no avatar. */
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export default async function SharedCollectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [detail, preview] = await Promise.all([
    fetchSharedCollection(slug),
    fetchSharedCollectionPreview(slug),
  ]);
  if (!detail) notFound();

  // Preview carries the per-item summaries (#689), one entry per item; keep
  // collection (position) order. `preview === null` means the preview fetch
  // itself failed (the detail fetch is the source of truth for not-found), so
  // we distinguish that from a genuinely empty collection below.
  const previewFailed = preview === null && detail.item_count > 0;
  const routes = preview
    ? [...preview.routes].sort((a, b) => a.position - b.position)
    : [];
  const ownerName = detail.owner_name || "";
  const ownerInitials = initials(ownerName) || "T";
  const totalKm = routes.reduce((sum, r) => sum + (r.distance_km ?? 0), 0);
  // Riding days = trip day counts; a recorded ride (`num_days: null`) counts as
  // one day, matching the per-row "1 day" label so a ride-only collection
  // doesn't report "0 RIDING DAYS".
  const ridingDays = routes.reduce(
    (sum, r) => sum + (r.num_days ?? (r.kind === "ride" ? 1 : 0)),
    0,
  );

  return (
    <div className="min-h-screen bg-cream text-ink">
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

      <main className="mx-auto max-w-[980px] px-7 pb-16 pt-8">
        {/* hero */}
        <section className="mb-[26px] rounded-[14px] border border-line bg-cream p-[30px]">
          <div className="mb-2.5 flex items-center gap-3">
            <Stamp>{t("Route collection")}</Stamp>
            <RouteCollectionVisibilityPill visibility={detail.visibility} />
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
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accent text-[9px] font-extrabold text-ink">
                  {ownerInitials}
                </span>
                {ownerName}
              </MetaChip>
            )}
            <MetaChip>
              <Shuffle size={13} className="text-fg-mute" aria-hidden="true" />
              {detail.item_count}{" "}
              {detail.item_count === 1 ? t("route") : t("routes")}
            </MetaChip>
            <MetaChip>
              <Calendar size={13} className="text-fg-mute" aria-hidden="true" />
              {t("Updated")} {formatRelativeTime(detail.updated_at)}
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
              {Math.round(totalKm).toLocaleString()} {t("KM")} · {ridingDays}{" "}
              {t("RIDING DAYS")}
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
              <SharedRouteRow
                key={route.item_id}
                route={route}
                index={idx + 1}
                author={ownerName}
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
            {t("Open in Tarmoto")}
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

/**
 * One read-only route row on the public shared page. Not a link — a public
 * viewer can't open the owner's auth-gated trip/ride detail; the header CTA
 * is the conversion path. Author is the collection owner (every item belongs
 * to them — see the per-item summaries backend note).
 */
function SharedRouteRow({
  route,
  index,
  author,
}: {
  route: RouteCollectionPreviewItem;
  index: number;
  author: string;
}) {
  const isRide = route.kind === "ride";
  const daysLabel =
    route.num_days != null
      ? route.num_days === 1
        ? t("1 day")
        : t("{count} days", { count: route.num_days })
      : isRide
        ? t("1 day")
        : null;
  const metaParts = [daysLabel, author || null].filter(Boolean);
  return (
    <li className="grid grid-cols-[32px_64px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] border border-line bg-cream p-3.5 sm:grid-cols-[32px_64px_minmax(0,1fr)_82px_96px_auto] sm:gap-3.5">
      <Mono className="text-center text-[16px] font-extrabold text-fg-mute">
        {index}
      </Mono>
      <RouteThumb
        lines={route.lines}
        label={route.title ?? t("Route")}
        className="h-[42px] w-16 shrink-0 overflow-hidden rounded-lg border border-line bg-paper"
      />
      <div className="min-w-0">
        <div className="truncate text-[15px] font-bold text-ink">
          {route.title ?? t("Untitled route")}
        </div>
        {metaParts.length > 0 && (
          <Mono className="mt-0.5 block truncate text-[10.5px] uppercase text-fg-mute">
            {metaParts.join(" · ")}
          </Mono>
        )}
      </div>
      <div className="text-right max-sm:hidden">
        {route.distance_km != null && (
          <>
            <Mono className="text-[14px] font-bold text-ink">
              {Math.round(route.distance_km)}
            </Mono>
            <Mono className="block text-[10px] text-fg-mute">{t("KM")}</Mono>
          </>
        )}
      </div>
      <div className="justify-self-start max-sm:hidden">
        {route.status && <StatusPill status={route.status} />}
      </div>
      <div className="justify-self-end">
        {route.quality_avg != null && (
          <QualityBars q={route.quality_avg} size={5} />
        )}
      </div>
    </li>
  );
}
