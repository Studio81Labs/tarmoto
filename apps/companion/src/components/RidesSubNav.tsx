"use client";

import { t } from "@/i18n";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { BarChart3, History, MapPin, Scale } from "lucide-react";

/**
 * Sub-nav strip surfaced on every `/rides/*` view. The cream-on-ink sidebar
 * lists "Ride History" as a single top-level entry; this strip restores
 * discoverability for the related views — stats, the personal road map,
 * and ride comparison — without nesting items in the sidebar.
 */

type SubItem = {
  href: string;
  label: string;
  icon: typeof History;
};

const ITEMS: SubItem[] = [
  { href: "/rides", label: "Ride history", icon: History },
  { href: "/rides/stats", label: "Statistics", icon: BarChart3 },
  { href: "/rides/road-map", label: "Road map", icon: MapPin },
  { href: "/rides/compare", label: "Compare rides", icon: Scale },
];

export function RidesSubNav({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={t("Ride views")}
      className={clsx(
        "flex flex-wrap items-center gap-1.5 rounded-xl border border-ink/10 bg-paper p-1",
        className,
      )}
    >
      {ITEMS.map((item) => {
        const isActive =
          item.href === "/rides"
            ? pathname === "/rides"
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition",
              isActive
                ? "bg-ink text-cream"
                : "text-ink/65 hover:bg-cream hover:text-ink",
            )}
          >
            <item.icon size={13} strokeWidth={2} aria-hidden="true" />
            {t(item.label)}
          </Link>
        );
      })}
    </nav>
  );
}
