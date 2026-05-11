"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { useSession } from "next-auth/react";
import { TarmotoMark } from "./tarmoto/atoms";
import { t } from "@/i18n";

/**
 * Tarmoto sidebar — ink rail with cream type, matching Web App v2.html.
 * Sections are flattened to a single numbered list of top-level views with
 * a numbered "stamp" mono prefix per item; sub-pages remain reachable from
 * within each view.
 */

type NavItem = {
  href: string;
  label: string;
  stamp: string;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", stamp: "00", label: "Home" },
  { href: "/trips", stamp: "01", label: "Trips" },
  { href: "/explore", stamp: "02", label: "Road Explorer" },
  { href: "/rides", stamp: "03", label: "Ride History" },
  { href: "/community", stamp: "04", label: "Community" },
  { href: "/gamification", stamp: "05", label: "Achievements" },
  { href: "/settings", stamp: "06", label: "Account" },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const user = session?.user;
  const initial = user?.displayName?.[0]?.toUpperCase() ?? "T";

  return (
    <aside
      className="flex w-[220px] shrink-0 flex-col gap-5 border-r border-ink/10 bg-ink px-3.5 py-5 text-cream"
      aria-label={t("Primary")}
    >
      {/* Logo */}
      <Link
        href="/"
        className="flex items-center gap-2.5 px-1.5"
        aria-label={t("Tarmoto")}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
          <TarmotoMark size={18} color="#0E0E10" />
        </span>
        <span className="leading-none">
          <span className="block text-[15px] font-bold tracking-tight text-cream">
            TARMOTO
          </span>
          <span className="mt-0.5 block font-mono text-[9px] tracking-[1px] text-cream/50">
            WEB · v1.4
          </span>
        </span>
      </Link>

      <div className="h-px bg-cream/10" />

      {/* Navigation */}
      <nav className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const isActive = (() => {
            if (item.href === "/") return pathname === "/";
            if (!pathname.startsWith(item.href)) return false;
            const hasMoreSpecific = NAV_ITEMS.some(
              (other) =>
                other.href !== item.href &&
                other.href.startsWith(item.href) &&
                pathname.startsWith(other.href),
            );
            return !hasMoreSpecific;
          })();
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 transition-colors",
                isActive ? "bg-accent text-ink" : "text-cream hover:bg-cream/5",
              )}
            >
              <span
                aria-hidden="true"
                className={clsx(
                  "w-6 font-mono text-[10px] font-bold tracking-[1px]",
                  isActive ? "text-ink" : "text-cream/40",
                )}
              >
                {item.stamp}
              </span>
              <span
                className={clsx(
                  "text-[13px]",
                  isActive ? "font-bold" : "font-semibold",
                )}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* User block.

         The "Your contribution" panel from the v2 design is intentionally
         left out for now — we don't yet have a single hook that returns the
         signed-in rider's total mapped distance, so the panel would only be
         able to show placeholder numbers, which would lie to new riders and
         disagree with the dedicated stats / road-map pages. Add it back
         once a real contribution endpoint is wired up. */}
      <Link
        href="/settings"
        className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition hover:bg-cream/5"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-[13px] font-bold text-ink">
          {initial}
        </span>
        <span className="min-w-0 flex-1 leading-none">
          <span className="block truncate text-[12px] font-bold text-cream">
            {user?.displayName ?? t("Rider")}
          </span>
          <span className="mt-1 block font-mono text-[9px] tracking-[1px] text-cream/50">
            {t("ACCOUNT")}
          </span>
        </span>
      </Link>
    </aside>
  );
}
