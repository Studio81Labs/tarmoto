import { CommunityTabsBar } from "./_CommunityTabsBar";

/**
 * Shared layout for `/community/*`. The Web App v2 sidebar is flat —
 * Community appears once and points at Feed; the tab strip surfaces
 * Collections as a sibling tab on the section roots, while
 * rider-profile deep links render without the strip.
 */
export default function CommunityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CommunityTabsBar />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
