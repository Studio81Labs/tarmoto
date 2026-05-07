import { t } from "@/i18n";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  Calendar,
  Gauge,
  MapPin,
  Route as RouteIcon,
  User,
} from "lucide-react";
import { fetchSharedCollection } from "@/lib/route-collection-share";
import { RouteCollectionVisibilityPill } from "@/components/RouteCollectionVisibilityPill";
import { RouteCollectionFollowCta } from "@/components/RouteCollectionFollowCta";
import { formatRelativeTime } from "@/lib/utils";
import { CollectionPreviewMap } from "./_components/CollectionPreviewMap";
export const dynamic = "force-dynamic";
export async function generateMetadata({
  params,
}: {
  params: Promise<{
    slug: string;
  }>;
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
    // Public collections may surface on the discover page later; unlisted
    // ones must stay out of the index. We don't know which is which from
    // metadata generation in advance of the fetch, so we set robots based on
    // the resolved visibility — public is indexable, unlisted is not.
    robots:
      detail.visibility === "public"
        ? { index: true, follow: true }
        : { index: false, follow: false },
  };
}
export default async function SharedCollectionPage({
  params,
}: {
  params: Promise<{
    slug: string;
  }>;
}) {
  const { slug } = await params;
  const detail = await fetchSharedCollection(slug);
  if (!detail) notFound();
  return (
    <main className="mx-auto max-w-4xl px-6 py-10 text-slate-100">
      <nav className="mb-4 text-sm text-slate-400">
        <Link href="/" className="hover:text-white">
          {t("Tarmoto ")}
        </Link>
        <span className="mx-2">/</span>
        <span>{t("Shared collection")}</span>
      </nav>

      <header className="mb-8 rounded-3xl border border-slate-800 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.14),_transparent_42%),linear-gradient(135deg,_rgba(15,23,42,0.98),_rgba(2,6,23,0.98))] p-8">
        <div className="flex items-center gap-2 mb-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-tarmoto-cyan">
            {t("Route collection ")}
          </p>
          <RouteCollectionVisibilityPill visibility={detail.visibility} />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">{detail.title}</h1>
        {detail.description && (
          <p className="mt-3 max-w-3xl text-slate-300 whitespace-pre-line">
            {detail.description}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2 text-sm text-slate-300">
          <Pill icon={<User size={14} />}>
            {detail.owner_name || "Tarmoto rider"}
          </Pill>
          <Pill icon={<RouteIcon size={14} />}>
            {detail.item_count}
            {t("route")}
            {detail.item_count === 1 ? "" : "s"}
          </Pill>
          <Pill icon={<Calendar size={14} />}>
            {t("Updated ")}
            {formatRelativeTime(detail.updated_at)}
          </Pill>
        </div>
      </header>

      <section className="mb-8">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          {t("Map preview ")}
        </h2>
        <CollectionPreviewMap
          slug={detail.slug}
          itemCount={detail.item_count}
        />
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          {t("Routes ")}
        </h2>
        {detail.items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/50 p-10 text-center text-sm text-slate-500">
            <RouteIcon
              size={36}
              className="mx-auto text-slate-600 mb-2"
              aria-hidden="true"
            />
            {t("The owner hasn't added any routes to this collection yet. ")}
          </div>
        ) : (
          <ul className="space-y-3">
            {detail.items.map((item, idx) => {
              const isRide = item.ride_id != null;
              const kindLabel = isRide ? "Recorded ride" : "Planner trip";
              const KindIcon = isRide ? Gauge : RouteIcon;
              return (
                <li
                  key={item.id}
                  className="rounded-2xl border border-slate-800 bg-slate-900 p-4 flex items-center gap-3"
                >
                  <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-slate-950 border border-slate-800 text-xs font-semibold text-slate-400">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate inline-flex items-center gap-1.5">
                      <KindIcon
                        size={14}
                        className={
                          isRide ? "text-emerald-400" : "text-tarmoto-cyan"
                        }
                        aria-hidden="true"
                      />
                      {kindLabel}
                    </p>
                    <p className="text-[11px] text-slate-500 font-mono truncate">
                      {item.trip_id ?? item.ride_id}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                    <MapPin size={12} aria-hidden="true" />
                    {t("Position ")}
                    {item.position + 1}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <RouteCollectionFollowCta
          collectionId={detail.id}
          slug={detail.slug}
          ownerName={detail.owner_name ?? ""}
        />
      </section>
    </main>
  );
}
function Pill({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-950/40 px-3 py-1">
      <span className="text-slate-500">{icon}</span>
      <span>{children}</span>
    </span>
  );
}
