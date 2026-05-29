"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { SubRouteTabs } from "@/components/SubRouteTabs";

/**
 * Ride History section tab strip. Only rendered on the three section
 * roots — `/rides`, `/rides/road-map`, `/rides/compare`. Hidden on
 * deep-links (`/rides/[rideId]`) where the page chrome already
 * provides a Back affordance, and on `/rides/stats` since Statistics
 * is now its own top-level nav item.
 *
 * `allRidesBadge` populates the `All rides · N` mono count per the
 * v2 spec; passed through from `RidesScaffold` so each page can
 * surface the total it knows about.
 */
const ROOT_ROUTES = ["/rides", "/rides/road-map", "/rides/compare"];

export function RidesTabsBar({ allRidesBadge }: { allRidesBadge?: ReactNode }) {
  const pathname = usePathname();
  const show = ROOT_ROUTES.includes(pathname);
  if (!show) return null;
  return (
    <SubRouteTabs
      ariaLabel="Ride history sections"
      tabs={[
        { href: "/rides", label: "All rides", badge: allRidesBadge },
        { href: "/rides/road-map", label: "Road map" },
        { href: "/rides/compare", label: "Compare rides" },
      ]}
    />
  );
}
