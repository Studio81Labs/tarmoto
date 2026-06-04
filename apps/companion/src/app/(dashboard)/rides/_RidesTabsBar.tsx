"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { SubRouteTabs } from "@/components/SubRouteTabs";
import { TimeWindowPills } from "./_components/TimeWindowPills";

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
  // Time-window pills are shared by All rides + Road map (both filter by the
  // same `?window=` lower bound). Compare picks two specific rides, so a time
  // window is meaningless there — hide the pills on `/rides/compare`.
  const showPills = pathname !== "/rides/compare";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <SubRouteTabs
        ariaLabel="Ride history sections"
        tabs={[
          {
            href: "/rides",
            label: "All rides",
            badge: allRidesBadge,
            // `/rides/road-map` and `/rides/compare` share the
            // `/rides` prefix; without `exact`, the default
            // `startsWith` rule would keep this tab active on those
            // sibling routes alongside the real one.
            exact: true,
          },
          { href: "/rides/road-map", label: "Road map" },
          { href: "/rides/compare", label: "Compare rides" },
        ]}
      />
      {showPills && <TimeWindowPills />}
    </div>
  );
}
