import { KillSwitchGate } from "@/components/entitlements/KillSwitchGate";
import { FeatureUnavailablePage } from "@/components/entitlements/FeatureUnavailablePage";
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
      {/* Whole-route kill, so the full-page state rather than the gates'
          default inline card — a strip of copy at the top of an otherwise
          blank page reads as a broken page, not a paused feature. */}
      <KillSwitchGate
        feature="community_access"
        fallback={<FeatureUnavailablePage />}
      >
        {children}
      </KillSwitchGate>
    </div>
  );
}
