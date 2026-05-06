"use client";

import { OfflineIndicator } from "./OfflineIndicator";
import { NotificationBell } from "./NotificationBell";
import { UserMenu } from "./UserMenu";

export function Topbar() {
  return (
    <header className="flex h-16 items-center justify-end border-b border-slate-800 px-6">
      <div className="flex items-center gap-4">
        <OfflineIndicator />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}
