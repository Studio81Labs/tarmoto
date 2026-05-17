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
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
