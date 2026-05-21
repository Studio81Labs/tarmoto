import type { ReactNode } from "react";
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
  className?: string;
}

export function PageHeader({
  title,
  stamp,
  sub,
  icon,
  right,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("mb-6 flex items-end justify-between gap-6", className)}>
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
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}
