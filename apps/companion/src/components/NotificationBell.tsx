"use client";
import { t } from "@/i18n";
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
        className="relative rounded-full border border-ink/15 bg-cream p-2 text-ink transition hover:bg-paper"
        aria-label={t("Notifications")}
      >
        <Bell size={16} />
        {hasUnread && (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-ink/15 bg-cream shadow-[0_12px_32px_rgba(14,14,16,0.14)]">
          <div className="flex items-center justify-between border-b border-ink/10 px-4 py-3">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-ink/60">
              {t("Notifications")}
            </span>
            <Link
              href="/settings/notifications"
              onClick={close}
              className="rounded p-1 text-ink/45 transition hover:bg-paper hover:text-ink"
              aria-label={t("Notification settings")}
            >
              <Settings size={14} />
            </Link>
          </div>
          <div className="px-4 py-10 text-center text-sm text-ink/55">
            {t("No new notifications")}
          </div>
        </div>
      )}
    </div>
  );
}
