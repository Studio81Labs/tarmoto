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
 * scaffold with its own optional `headerRight` slot (Share map /
 * Export CSV buttons render only when the page has data).
 *
 * Tab badge count is fetched here via `useRidesTotal` so the
 * `All rides · N` badge stays visible across every sub-page
 * regardless of which one is mounted. The All rides page can
 * still override via `allRidesBadge` — it already has the total
 * from its heavier `useRidesQuery` and avoids a duplicate fetch.
 */
export function RidesScaffold({
  headerRight,
  allRidesBadge,
  children,
}: {
  headerRight?: ReactNode;
  allRidesBadge?: ReactNode;
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
    <div className="mx-auto flex h-full min-h-0 w-full max-w-page animate-fade-in flex-col p-4 md:p-7">
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
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
