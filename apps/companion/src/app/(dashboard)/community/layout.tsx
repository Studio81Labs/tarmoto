import { KillSwitchGate } from "@/components/entitlements/KillSwitchGate";
/**
 * Shared layout for `/community/*` sibling views. The v2 Community
 * spec (`v2-pages.jsx` CommunityView) gives every sub-page a unified
 * `CommunityScaffold` (stamp + Users icon + 32 px `Community` title
 * + sub + an optional header CTA + SubRouteTabs),
 * so the layout itself is a thin passthrough — each page mounts the
 * scaffold so it can pass its own header CTAs and tab badges.
 */
export default function CommunityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One gate for every `/community/*` view — feed, collections, rides and
          rider profiles all mount through here, so the operator switch cannot be
          bypassed by deep-linking a sub-route. */}
      <KillSwitchGate feature="community_access">{children}</KillSwitchGate>
    </div>
  );
}
