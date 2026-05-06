"use client";

import { useState, useRef, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { Settings, LogOut } from "lucide-react";

export function UserMenu() {
  const { data: session } = useSession();
  const user = session?.user;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = () => {
    setOpen(false);
    signOut({ callbackUrl: "/login" });
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm text-slate-300 hover:bg-slate-800 transition"
      >
        <div className="w-8 h-8 rounded-full bg-tarmoto-cyan/20 flex items-center justify-center text-tarmoto-cyan text-sm font-bold shrink-0">
          {user?.displayName?.[0]?.toUpperCase() ?? "T"}
        </div>
        {user?.displayName && (
          <span className="text-sm font-medium">{user.displayName}</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-slate-800 bg-slate-900 shadow-lg py-1 z-50">
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-800 transition"
          >
            <Settings size={16} />
            Settings
          </Link>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-slate-300 hover:text-red-400 hover:bg-red-400/5 transition"
          >
            <LogOut size={16} />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
