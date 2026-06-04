import { Sidebar } from "./Sidebar";

/**
 * AppShell — authenticated app chrome. Shell v2 collapses the previous
 * top bar entirely; the sidebar carries the brand, navigation, offline
 * indicator, notifications, and user menu. Pages own their own header
 * area when they need one.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-cream text-ink">
      <Sidebar />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/*
          `min-h-0` is required on this scroller: as a flex child its default
          `min-height: auto` lets tall content grow the box past the viewport
          instead of scrolling inside it, spilling over so the whole page
          gets a second scrollbar. With `min-h-0` it stays bounded to the
          shell and only this region scrolls.
        */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
