"use client";
import type { ReactNode } from "react";
import { Activity } from "lucide-react";
import { PageHeader, Mono } from "@tarmoto/ui";
import { t } from "@/i18n";
import { RidesTabsBar } from "./_RidesTabsBar";
import { useRidesTotal } from "./_useRidesTotal";

/**
 * Shared chrome for the three Ride History pages (`/rides`,
 * `/rides/road-map`, `/rides/compare`). Spec: v2-pages.jsx
 * RideHistoryView — every sub-page leads with the same stamp +
 * Activity icon + 32 px `Ride History` title + sub copy, then a
 * `SubRouteTabs` strip below with the "All rides · N" badge count.
 *
 * Centralising the structure here keeps the three pages consistent
 * without forcing a Next layout-tree refactor: each page mounts the
 * scaffold with its own optional `headerRight` slot (e.g. the Export
 * menu, which renders only when the page has data).
 *
 * Tab badge count is fetched here via `useRidesTotal` so the
 * `All rides · N` badge stays visible across every sub-page
 * regardless of which one is mounted. The All rides page can
 * still override via `allRidesBadge` — it already has the total
 * from its heavier `useRidesQuery` and avoids a duplicate fetch.
 *
 * `fill` opts a page into a bounded full-height flex body — the Road map
 * needs it so the MapLibre canvas fills the viewport and its sidebar scrolls
 * independently. The default (All rides, Compare) lets the body grow with its
 * content and scroll through the AppShell's scroller; forcing `h-full` there
 * would squeeze a tall table into the viewport and clip its last rows under
 * the card's `overflow-hidden`.
 */
export function RidesScaffold({
  headerRight,
  allRidesBadge,
  fill = false,
  children,
}: {
  headerRight?: ReactNode;
  allRidesBadge?: ReactNode;
  fill?: boolean;
  children: ReactNode;
}) {
  const fallbackTotal = useRidesTotal();
  const badge =
    allRidesBadge !== undefined ? (
      allRidesBadge
    ) : fallbackTotal !== null ? (
      <Mono className="text-[11px]">{fallbackTotal}</Mono>
    ) : null;
  return (
    <div
      className={`mx-auto w-full max-w-page animate-fade-in p-4 md:p-7 ${
        fill ? "flex h-full min-h-0 flex-col" : ""
      }`}
    >
      <PageHeader
        stamp={t("Ride history")}
        icon={<Activity size={18} strokeWidth={2} />}
        title={t("Ride History")}
        sub={t(
          "Browse every recorded ride, see where you've been, and compare two rides side by side.",
        )}
        right={headerRight}
      />
      <div className="mb-[18px]">
        <RidesTabsBar allRidesBadge={badge} />
      </div>
      {fill ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        children
      )}
    </div>
  );
}
