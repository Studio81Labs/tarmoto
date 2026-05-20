import { RidesTabsBar } from "./_RidesTabsBar";

/**
 * Shared layout for `/rides/*` sibling views. The Web App v2 sidebar
 * is flat (no expanded sub-children), so the in-page tab strip
 * replaces the dropped sidebar children for Road map / Compare —
 * `/rides/stats` is now a separate top-level nav item.
 */
export default function RidesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RidesTabsBar />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
