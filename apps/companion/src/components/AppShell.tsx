import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

/**
 * AppShell — the authenticated app chrome (sidebar + topbar). Shared between
 * the dashboard route group and the public /explore route so an authenticated
 * visitor to /explore sees the same frame as everywhere else.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-slate-950">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Topbar />
        <div className="flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
