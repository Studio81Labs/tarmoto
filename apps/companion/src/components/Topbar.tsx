"use client";

import { Bell } from "lucide-react";
import { OfflineIndicator } from "./OfflineIndicator";
import { UserMenu } from "./UserMenu";

export function Topbar() {
  return (
    <header className="flex h-16 items-center justify-end border-b border-slate-800 px-6">
      <div className="flex items-center gap-4">
        <OfflineIndicator />
        <button className="relative p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition">
          <Bell size={18} />
          <span className="absolute top-1 right-1 w-2 h-2 bg-tarmoto-cyan rounded-full" />
        </button>
        <UserMenu />
      </div>
    </header>
  );
}
