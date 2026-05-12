"use client";

import { t } from "@/i18n";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { FolderOpen, Users } from "lucide-react";

/**
 * Sub-nav strip for every `/community/*` view. The cream-on-ink sidebar
 * lists "Community" as a single top-level entry; this strip restores
 * discoverability for the related views — the rider feed and saved route
 * collections — without nesting items in the sidebar.
 */

type SubItem = {
  href: string;
  label: string;
  icon: typeof Users;
};

const ITEMS: SubItem[] = [
  { href: "/community", label: "Feed", icon: Users },
  {
    href: "/community/collections",
    label: "Collections",
    icon: FolderOpen,
  },
];

export function CommunitySubNav({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={t("Community views")}
      className={clsx(
        "flex flex-wrap items-center gap-1.5 rounded-xl border border-ink/10 bg-paper p-1",
        className,
      )}
    >
      {ITEMS.map((item) => {
        const isActive =
          item.href === "/community"
            ? pathname === "/community" ||
              (pathname.startsWith("/community/") &&
                !pathname.startsWith("/community/collections"))
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
