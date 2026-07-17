"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../utils/cn";
import { Heading } from "../atoms/Heading";
import { Stamp } from "../atoms/Stamp";

/**
 * PageHeader · canonical landing-row anatomy used by every top-level
 * companion page in Web App v2.
 *
 *   stamp  (optional) · mono category label above the title
 *   icon   (optional) · accent-coloured glyph inline with the title
 *   title  · 32 px Heading (Heading xl)
 *   sub    (optional) · 13 px fg-dim body, capped at ~720 px
 *   right  (optional) · CTA slot on the right; flex-shrink-0
 *
 * Once the header scrolls out of view a condensed sticky bar (icon +
 * title + the `right` actions) pins to the top of the scroll container,
 * spanning its full width with a bottom border, so context and primary
 * actions stay reachable on long pages. The nearest scroll container
 * must be an inline-size query container (Tailwind `@container`) — the
 * bar's `100cqw` width reads it to escape the page column. Opt out with
 * `sticky={false}`. The bar only mounts while condensed — environments
 * without IntersectionObserver (jsdom) simply never show it, and the
 * page's single h1 stays unique. While the bar is up, the original
 * header's action slot goes `inert` so its actions keep a single
 * focusable instance.
 *
 * The companion's prior local `<PageHeader>` (apps/companion/src/components)
 * lacked the stamp / icon-beside-title pattern and used a 24 px h1 — both
 * non-canonical. That file stays in place for un-migrated routes and will
 * retire once every dashboard surface adopts this one.
 */
export interface PageHeaderProps {
  title: ReactNode;
  stamp?: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  /** Show the condensed sticky bar once the header scrolls away. */
  sticky?: boolean;
  className?: string;
}

export function PageHeader({
  title,
  stamp,
  sub,
  icon,
  right,
  sticky = true,
  className,
}: PageHeaderProps) {
  const headerRef = useRef<HTMLDivElement>(null);
  const [condensed, setCondensed] = useState(false);

  useEffect(() => {
    // Graceful no-op where IntersectionObserver is missing (jsdom).
    if (!sticky || typeof IntersectionObserver === "undefined") return;
    const node = headerRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setCondensed(!entry.isIntersecting);
      },
      // threshold 0: condense only once the header is fully out of view
      // (observers report intersecting while any pixel remains visible).
      { threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [sticky]);

  return (
    <>
      {/* Zero-height sticky slot so the floating bar never shifts layout.
          Placed before the header: its natural position is the top of the
          page, so it is already "stuck" whenever the bar mounts. */}
      {sticky && condensed && (
        <div className="pointer-events-none sticky top-0 z-30 h-0">
          {/* left/width in cqw (not translate) — the entry animation
              animates transform and would override a translate-x. */}
          <div className="pointer-events-auto absolute left-[calc(50%-50cqw)] flex w-[100cqw] animate-header-in items-center gap-3 border-b border-line bg-paper/90 px-4 py-2 backdrop-blur-md motion-reduce:animate-none md:px-7">
            {icon && (
              <span className="shrink-0 text-accent" aria-hidden="true">
                {icon}
              </span>
            )}
            <div className="min-w-0 flex-1 truncate text-[15px] font-extrabold tracking-[-0.3px] text-ink">
              {title}
            </div>
            {right && <div className="shrink-0">{right}</div>}
          </div>
        </div>
      )}
      <div
        ref={headerRef}
        className={cn("mb-6 flex items-end justify-between gap-6", className)}
      >
        <div className="min-w-0 flex-1">
          {stamp && <Stamp>{stamp}</Stamp>}
          <div className={cn("flex items-center gap-3", stamp && "mt-1")}>
            {icon && (
              <span className="text-accent" aria-hidden="true">
                {icon}
              </span>
            )}
            <Heading size="xl" as="h1">
              {title}
            </Heading>
          </div>
          {sub && (
            <p className="mt-2 max-w-[720px] text-[13px] leading-[1.55] text-fg-dim">
              {sub}
            </p>
          )}
        </div>
        {right && (
          // While the condensed bar carries the live copy of the actions,
          // the off-screen originals go inert — one focusable instance.
          <div className="shrink-0" inert={condensed || undefined}>
            {right}
          </div>
        )}
      </div>
    </>
  );
}
