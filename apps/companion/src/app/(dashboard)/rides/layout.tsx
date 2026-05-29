/**
 * Shared layout for `/rides/*` sibling views. v2 Ride History spec
 * (`v2-pages.jsx` RideHistoryView) gives every sub-page a unified
 * `RidesScaffold` (stamp + Activity icon + 32 px `Ride History`
 * title + sub + SubRouteTabs), so the layout itself is a thin
 * passthrough — the page mounts the scaffold so it can pass its
 * own header CTAs and tab badge count.
 */
export default function RidesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex h-full min-h-0 flex-col">{children}</div>;
}
