"use client";
import type { ReactNode } from "react";
import { Users } from "lucide-react";
import { PageHeader, Mono } from "@tarmoto/ui";
import { t } from "@/i18n";
import { CommunityTabsBar } from "./_CommunityTabsBar";
import {
  useCommunityFeedTotal,
  useCommunityCollectionsTotal,
} from "./_useCommunityTotals";

/**
 * Shared chrome for the two Community section roots (`/community/feed`,
 * `/community/collections`). Spec: v2-pages.jsx CommunityView — every
 * sub-page leads with the same stamp `Community` + 18 px Users icon +
 * 32 px `Community` title + sub copy, then a `SubRouteTabs` strip
 * below with mono `Feed · N` / `Collections · N` badges.
 *
 * Each page mounts the scaffold with its own optional `headerRight`
 * slot (e.g. the Collections tab's `New collection` CTA) and may
 * pass `feedBadge` / `collectionsBadge` overrides for whichever tab
 * it already has the count for. The scaffold falls back to the
 * lightweight `useCommunity*Total` hooks for the sibling tab so the
 * badge persists when switching between Feed and Collections without
 * a double-fetch on the active page.
 */
export function CommunityScaffold({
  headerRight,
  feedBadge,
  collectionsBadge,
  children,
}: {
  headerRight?: ReactNode;
  feedBadge?: ReactNode;
  collectionsBadge?: ReactNode;
  children: ReactNode;
}) {
  const fallbackFeed = useCommunityFeedTotal();
  const fallbackCollections = useCommunityCollectionsTotal();
  const feed =
    feedBadge !== undefined ? (
      feedBadge
    ) : fallbackFeed !== null ? (
      <Mono className="text-[11px]">{fallbackFeed}</Mono>
    ) : null;
  const collections =
    collectionsBadge !== undefined ? (
      collectionsBadge
    ) : fallbackCollections !== null ? (
      <Mono className="text-[11px]">{fallbackCollections}</Mono>
    ) : null;
  return (
    // Grows with content so the page scrolls through the AppShell scroller and
    // the bottom padding is honoured (matching RidesScaffold). The earlier
    // `h-full min-h-0 flex-col` "fill" layout pinned the scaffold to the
    // viewport and pushed long feed/collection content past the bottom padding.
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      <PageHeader
        stamp={t("Community")}
        icon={<Users size={18} strokeWidth={2} />}
        title={t("Community")}
        sub={t(
          "Explore popular shared rides, follow other riders, and curate your favourite roads.",
        )}
        right={headerRight}
      />
      <div className="mb-[18px]">
        <CommunityTabsBar feedBadge={feed} collectionsBadge={collections} />
      </div>
      {children}
    </div>
  );
}
