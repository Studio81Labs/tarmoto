"use client";

import { usePathname } from "next/navigation";
import { SubRouteTabs } from "@/components/SubRouteTabs";

/**
 * Community section tab strip. Only rendered when the rider is on
 * one of the section-root routes (Feed / Collections); hidden on
 * deep-links like `/community/[riderId]` where the back-to-section
 * affordance lives inside the page chrome.
 */
const ROOT_ROUTES = ["/community/feed", "/community/collections"];

export function CommunityTabsBar() {
  const pathname = usePathname();
  const show = ROOT_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + "/"),
  );
  if (!show) return null;
  return (
    <div className="shrink-0 border-b border-line bg-cream px-5 pt-5 pb-3 md:px-7">
      <SubRouteTabs
        ariaLabel="Community sections"
        tabs={[
          { href: "/community/feed", label: "Feed" },
          { href: "/community/collections", label: "Collections" },
        ]}
      />
    </div>
  );
}
