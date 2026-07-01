import Link from "next/link";
import clsx from "clsx";
import { Route as RouteIcon } from "lucide-react";
import { Mono, QualityBars } from "@tarmoto/ui";
import { t } from "@/i18n";
import type { RouteCollectionPreviewItem } from "@/lib/api";

/**
 * Pure, hook-free presentational atoms for a collection route row. Shared by
 * the owner detail page (client) and the public shared page (server) so the
 * thumbnail + status chip render identically in both.
 */

/**
 * Map a single simplified polyline (`[lng, lat][]`) to an SVG path inside the
 * 200×120 thumbnail box (north up). Mirrors `CollectionsDiscover.linePath`.
 */
export function thumbPath(line: number[][]): string {
  const xs = line.map((p) => p[0] ?? 0);
  const ys = line.map((p) => p[1] ?? 0);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(...xs) - minX || 1;
  const h = Math.max(...ys) - minY || 1;
  return (
    "M " +
    line
      .map(([lng, lat]) => {
        const x = (((lng ?? 0) - minX) / w) * 180 + 10;
        const y = (1 - ((lat ?? 0) - minY) / h) * 100 + 10;
        return `${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" L ")
  );
}

/**
 * Route-preview thumbnail; falls back to a route glyph with no geometry.
 * `className` controls the box (size + responsive visibility) so each page can
 * size it to its layout — defaults to the owner detail page's 58×40 box.
 */
export function RouteThumb({
  lines,
  label,
  className,
}: {
  lines: number[][][] | undefined;
  label: string;
  className?: string;
}) {
  const line = lines?.find((l) => l && l.length >= 2);
  return (
    <div
      className={
        className ??
        "hidden h-10 w-[58px] shrink-0 overflow-hidden rounded-lg border border-line bg-paper sm:block"
      }
    >
      {line ? (
        <svg
          viewBox="0 0 200 120"
          preserveAspectRatio="xMidYMid slice"
          className="h-full w-full"
          role="img"
          aria-label={`${label} route preview`}
        >
          <path
            d={thumbPath(line)}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <div className="flex h-full items-center justify-center text-fg-mute">
          <RouteIcon size={16} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

/** Status chip (planned / completed / shared / …) coloured like the design. */
export function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase();
  const tone =
    s === "completed"
      ? "border-[#1f8a5b]/40 text-[#1f8a5b]"
      : s === "shared"
        ? "border-[#b06a38]/40 text-[#b06a38]"
        : s === "active"
          ? "border-accent/45 text-accent"
          : "border-line-strong text-ink";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.2px] ${tone}`}
    >
      {status}
    </span>
  );
}

/**
 * One collection route row (numbered), rendered from the per-item preview
 * summaries (#689) so it works for any viewer — the public shared page and the
 * in-app member discover view both use it. `author` is the collection owner
 * (every item belongs to them).
 *
 * `linkable` opts the row into deep-linking to the item's detail view
 * (`/community/rides/:id` or `/community/trips/:id`, both under the dashboard
 * shell). It defaults to OFF so the anonymous public shared page keeps its
 * read-only rows — those destinations require the app shell and would bounce a
 * logged-out reader to sign-in. A row with no resolvable `target_id` (deleted
 * item) stays non-interactive even when `linkable`.
 */
export function CollectionRouteRow({
  route,
  index,
  author,
  linkable = false,
}: {
  route: RouteCollectionPreviewItem;
  index: number;
  author: string;
  linkable?: boolean | undefined;
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

  const href =
    linkable && route.target_id
      ? isRide
        ? `/community/rides/${encodeURIComponent(route.target_id)}`
        : `/community/trips/${encodeURIComponent(route.target_id)}`
      : null;

  const rowClass =
    "grid grid-cols-[32px_64px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] border border-line bg-cream p-3.5 sm:grid-cols-[32px_64px_minmax(0,1fr)_82px_96px_auto] sm:gap-3.5";

  const cells = (
    <>
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
    </>
  );

  return (
    <li>
      {href ? (
        <Link
          href={href}
          className={clsx(
            rowClass,
            "transition hover:border-line-strong hover:bg-paper",
          )}
        >
          {cells}
        </Link>
      ) : (
        <div className={rowClass}>{cells}</div>
      )}
    </li>
  );
}
