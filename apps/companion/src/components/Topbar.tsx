"use client";

import { usePathname } from "next/navigation";
import { OfflineIndicator } from "./OfflineIndicator";
import { NotificationBell } from "./NotificationBell";
import { UserMenu } from "./UserMenu";

const TITLES: Record<string, string> = {
  "/": "Home",
  "/trips": "Trip Planner",
  "/explore": "Road Explorer",
  "/rides": "Ride History",
  "/community": "Community",
  "/gamification": "Achievements",
  "/settings": "Account",
};

function titleFor(pathname: string): { stamp?: string; label: string } {
  for (const path of Object.keys(TITLES).sort((a, b) => b.length - a.length)) {
    if (
      (path === "/" && pathname === "/") ||
      (path !== "/" && pathname.startsWith(path))
    ) {
      return { label: TITLES[path] };
    }
  }
  return { label: "Tarmoto" };
}

export function Topbar() {
  const pathname = usePathname();
  const { label } = titleFor(pathname);
  return (
    <header className="flex h-16 items-center justify-between border-b border-ink/10 bg-cream px-6">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-ink/60">
          Tarmoto · {label}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <OfflineIndicator />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}
