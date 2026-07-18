"use client";

import type { ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { t } from "@/i18n";
import { SubRouteTabs } from "@/components/SubRouteTabs";
import {
  TimeWindowPills,
  parseTimeWindow,
} from "./_components/TimeWindowPills";

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
  const params = useSearchParams();
  const show = ROOT_ROUTES.includes(pathname);
  if (!show) return null;
  // Time-window pills are shared by All rides + Road map (both filter by the
  // same `?window=` lower bound). Compare picks two specific rides, so a time
  // window is meaningless there — hide the pills on `/rides/compare`.
  const showPills = pathname !== "/rides/compare";
  // Carry the active `?window=` across tab navigations so the selected window
  // survives switching tabs (the pills claim to be shared). Only `window` is
  // propagated — page/filters/sort are All-rides-specific. `matchPrefixes`
  // keeps the active-tab check on the bare pathname (SubRouteTabs matches on
  // `href` by default, which would break once a query string is appended).
  const window = parseTimeWindow(params.get("window"));
  const qs = window === "all" ? "" : `?window=${window}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <SubRouteTabs
        ariaLabel={t("Ride history sections")}
        tabs={[
          {
            href: `/rides${qs}`,
            label: "All rides",
            badge: allRidesBadge,
            matchPrefixes: ["/rides"],
            // `/rides/road-map` and `/rides/compare` share the
            // `/rides` prefix; without `exact`, the default
            // `startsWith` rule would keep this tab active on those
            // sibling routes alongside the real one.
            exact: true,
          },
          {
            href: `/rides/road-map${qs}`,
            label: "Road map",
            matchPrefixes: ["/rides/road-map"],
          },
          {
            href: `/rides/compare${qs}`,
            label: "Compare rides",
            matchPrefixes: ["/rides/compare"],
          },
        ]}
      />
      {showPills && <TimeWindowPills />}
    </div>
  );
}
