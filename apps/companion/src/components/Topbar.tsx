"use client";

import { Bell } from "lucide-react";
import { useSession } from "next-auth/react";
import { OfflineIndicator } from "./OfflineIndicator";

export function Topbar() {
  const { data: session } = useSession();
  const user = session?.user;

  return (
    <header className="flex h-16 items-center justify-end border-b border-slate-800 px-6">
      <div className="flex items-center gap-4">
        <OfflineIndicator />
        <button className="relative p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition">
          <Bell size={18} />
          <span className="absolute top-1 right-1 w-2 h-2 bg-tarmoto-cyan rounded-full" />
        </button>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-tarmoto-cyan/20 flex items-center justify-center text-tarmoto-cyan text-sm font-bold">
            {user?.displayName?.[0]?.toUpperCase() ?? "T"}
          </div>
          {user?.displayName && (
            <span className="text-sm font-medium text-slate-300">
              {user.displayName}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
