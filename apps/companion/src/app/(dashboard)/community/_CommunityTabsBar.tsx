"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { t } from "@/i18n";
import { SubRouteTabs } from "@/components/SubRouteTabs";

/**
 * Community section tab strip. Only rendered when the rider is on
 * one of the section-root routes (Feed / Collections); hidden on
 * deep-links like `/community/[riderId]` where the back-to-section
 * affordance lives inside the page chrome.
 *
 * `feedBadge` / `collectionsBadge` populate the spec's
 * `Feed · N` / `Collections · N` mono counts; passed through from
 * `CommunityScaffold` so each page can surface the total it knows.
 */
const ROOT_ROUTES = ["/community/feed", "/community/collections"];

export function CommunityTabsBar({
  feedBadge,
  collectionsBadge,
}: {
  feedBadge?: ReactNode;
  collectionsBadge?: ReactNode;
} = {}) {
  const pathname = usePathname() ?? "";
  const show = ROOT_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + "/"),
  );
  if (!show) return null;
  return (
    <SubRouteTabs
      ariaLabel={t("Community sections")}
      tabs={[
        { href: "/community/feed", label: "Feed", badge: feedBadge },
        {
          href: "/community/collections",
          label: "Collections",
          badge: collectionsBadge,
        },
      ]}
    />
  );
}
