"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import type { ReactNode } from "react";
import { Mono } from "@tarmoto/ui";

/**
 * SubRouteTabs · in-page tab strip used by route groups whose parent
 * page exposes several sibling views. Spec: Web App v2 Design Map · §16
 * (segmented controls / PageTabs). Cream pill on paper, ink fill for
 * the active tab, optional mono badge.
 *
 * The companion's Web App v2 nav (#xxx) flattened the sidebar — sub
 * routes like `/rides/road-map` and `/community/collections` are no
 * longer surfaced in the rail, so each parent section mounts this
 * strip in its layout to give riders a way between siblings.
 */
export interface SubRouteTab {
  href: string;
  label: ReactNode;
  badge?: ReactNode;
  /** Optional explicit match — defaults to the tab's `href`. */
  matchPrefixes?: string[];
  /**
   * Restrict the active check to an exact pathname match (drops the
   * default `startsWith(href + "/")` prefix rule). Use when the tab
   * sits at the section root (e.g. `/rides`) and would otherwise
   * stay highlighted on every sibling sub-route (`/rides/road-map`,
   * `/rides/compare`) because they share the same prefix.
   */
  exact?: boolean;
}

export function SubRouteTabs({
  tabs,
  className,
  ariaLabel,
}: {
  tabs: SubRouteTab[];
  className?: string;
  ariaLabel?: string;
}) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={ariaLabel}
      className={clsx(
        "inline-flex gap-1 rounded-[10px] border border-line bg-paper p-1",
        className,
      )}
    >
      {tabs.map((tab) => {
        const matchers = tab.matchPrefixes ?? [tab.href];
        const active = matchers.some((m) =>
          tab.exact
            ? pathname === m
            : pathname === m || pathname.startsWith(m + "/"),
        );
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-[12px] font-bold transition-colors",
              active
                ? "bg-ink text-cream"
                : "bg-transparent text-fg-dim hover:text-ink",
            )}
          >
            <span>{tab.label}</span>
            {tab.badge != null && (
              <Mono
                className={clsx(
                  "text-[10px]",
                  active ? "text-cream/70" : "text-fg-mute",
                )}
              >
                · {tab.badge}
              </Mono>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
