"use client";

import { usePathname } from "next/navigation";
import { SubRouteTabs } from "@/components/SubRouteTabs";

/**
 * Ride History section tab strip. Only rendered on the three section
 * roots — `/rides`, `/rides/road-map`, `/rides/compare`. Hidden on
 * deep-links (`/rides/[rideId]`) where the page chrome already
 * provides a Back affordance, and on `/rides/stats` since Statistics
 * is now its own top-level nav item.
 */
const ROOT_ROUTES = ["/rides", "/rides/road-map", "/rides/compare"];

export function RidesTabsBar() {
  const pathname = usePathname();
  const show = ROOT_ROUTES.includes(pathname);
  if (!show) return null;
  return (
    <div className="shrink-0 border-b border-line bg-cream px-5 pt-5 pb-3 md:px-7">
      <SubRouteTabs
        ariaLabel="Ride history sections"
        tabs={[
          { href: "/rides", label: "All rides" },
          { href: "/rides/road-map", label: "Road map" },
          { href: "/rides/compare", label: "Compare rides" },
        ]}
      />
    </div>
  );
}
