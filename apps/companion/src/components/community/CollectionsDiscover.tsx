"use client";
import { t } from "@/i18n";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Mono, Stamp } from "@tarmoto/ui";
import { useAuthStore } from "@/stores/auth";
import { UserAvatar } from "@/components/UserAvatar";
import {
  fetchCollectionMosaic,
  fetchDiscoverCollections,
  type DiscoverCollection,
} from "@/lib/collections-discover";

/** Map a route polyline ([lng,lat][]) to an SVG path within a 200×120 box. */
function linePath(line: number[][]): string {
  const points = line
    .map((p) => ({ lng: p[0], lat: p[1] }))
    .filter(
      (p): p is { lng: number; lat: number } =>
        p.lng !== undefined && p.lat !== undefined,
    );
  if (points.length === 0) return "";
  const xs = points.map((p) => p.lng);
  const ys = points.map((p) => p.lat);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(...xs) - minX || 1;
  const h = Math.max(...ys) - minY || 1;
  return (
    "M " +
    points
      .map(({ lng, lat }) => {
        const x = ((lng - minX) / w) * 180 + 10;
        const y = (1 - (lat - minY) / h) * 100 + 10; // flip lat (north up)
        return `${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" L ")
  );
}

export function CollectionsDiscover({ search }: { search: string }) {
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const [items, setItems] = useState<DiscoverCollection[] | null>(null);

  useEffect(() => {
    if (!authReady) return;
    const ac = new AbortController();
    // Debounce the title search so each keystroke doesn't hit the server.
    const id = setTimeout(() => {
      void fetchDiscoverCollections(search, ac.signal)
        .then((page) => setItems(page.items))
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(id);
      ac.abort();
    };
  }, [authReady, search]);

  // Discover is a read-only browse of *other* members' public collections
  // (creating one lives in the header / "Your collections"). Hide the whole
  // section until there's something to discover so it doesn't render an empty
  // heading while loading or when the community has no public collections /
  // no search matches.
  if (!items || items.length === 0) return null;

  return (
    <section>
      <Stamp>{t("Discover")}</Stamp>
      <div className="mt-3 grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-3">
        {items.map((c) => (
          <DiscoverCard key={c.id} collection={c} />
        ))}
      </div>
    </section>
  );
}

function DiscoverCard({ collection }: { collection: DiscoverCollection }) {
  const [lines, setLines] = useState<number[][][]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetchCollectionMosaic(collection.slug).then((l) => {
      if (!cancelled) setLines(l);
    });
    return () => {
      cancelled = true;
    };
  }, [collection.slug]);

  // Six mosaic cells; fill with route previews where available.
  const cells = Array.from({ length: 6 }, (_, i) => lines[i] ?? null);

  return (
    <Link
      href={`/community/collections/discover/${encodeURIComponent(collection.slug)}`}
      className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-cream transition hover:border-line-strong"
    >
      <div className="grid h-[120px] grid-cols-3 grid-rows-2 bg-paper">
        {cells.map((line, i) => (
          <div
            key={i}
            className="border-b border-r border-cream last:border-r-0"
          >
            <svg viewBox="0 0 200 120" className="h-full w-full" aria-hidden>
              {line && (
                <path
                  d={linePath(line)}
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </div>
        ))}
      </div>

      <div className="p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-base font-extrabold text-ink">
              {collection.title}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-dim">
              <UserAvatar
                name={collection.owner_name ?? ""}
                size={18}
                fontSize={9}
              />
              <span>{collection.owner_name ?? t("Anonymous")}</span>
            </div>
          </div>
          {collection.viewer_is_following && (
            <span className="shrink-0 rounded-full border border-accent bg-accent/20 px-2.5 py-1 text-[11px] font-bold text-ink">
              {t("Following")}
            </span>
          )}
        </div>

        <div className="mt-3 flex justify-between border-t border-line pt-3 text-[11px] text-fg-dim">
          <Mono>
            <span className="font-bold text-ink">{collection.item_count}</span>{" "}
            {t("ROUTES")}
          </Mono>
          <Mono>
            <span className="font-bold text-ink">
              {collection.follower_count}
            </span>{" "}
            {t("FOLLOWS")}
          </Mono>
        </div>
      </div>
    </Link>
  );
}
