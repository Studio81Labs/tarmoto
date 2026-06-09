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
  return <div className="flex h-full min-h-0 flex-col">{children}</div>;
}
