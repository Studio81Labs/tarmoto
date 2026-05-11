import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

/**
 * AppShell — the authenticated app chrome (ink sidebar + cream content area).
 * Shared between the dashboard route group and the public /explore route so
 * an authenticated visitor to /explore sees the same frame as everywhere else.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-cream text-ink">
      <Sidebar />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <div className="flex-1 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
