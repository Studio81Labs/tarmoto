import { Route as RouteIcon } from "lucide-react";

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
