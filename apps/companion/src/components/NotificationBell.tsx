"use client";

import Link from "next/link";
import { Bell, Settings } from "lucide-react";
import { useDropdown } from "@/hooks";

export function NotificationBell({
  hasUnread = false,
}: {
  hasUnread?: boolean;
}) {
  const { open, close, toggle, ref } = useDropdown();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        className="relative p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
        aria-label="Notifications"
      >
        <Bell size={18} />
        {hasUnread && (
          <span className="absolute top-1 right-1 w-2 h-2 bg-tarmoto-cyan rounded-full" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 rounded-lg border border-slate-800 bg-slate-900 shadow-lg z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
            <span className="text-sm font-semibold text-slate-200">
              Notifications
            </span>
            <Link
              href="/settings/notifications"
              onClick={close}
              className="p-1 rounded text-slate-500 hover:text-slate-300 transition"
              aria-label="Notification settings"
            >
              <Settings size={14} />
            </Link>
          </div>
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            No new notifications
          </div>
        </div>
      )}
    </div>
  );
}
