"use client";
import { t } from "@/i18n";
import Link from "next/link";
import { Bell, CheckCheck, Settings } from "lucide-react";
import { useDropdown } from "@/hooks";
import { useEffect, useState } from "react";
import type { InAppNotification } from "@tarmoto/shared";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

export function NotificationBell({
  hasUnread = false,
}: {
  hasUnread?: boolean;
}) {
  const { open, close, toggle, ref } = useDropdown();
  const [items, setItems] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(hasUnread ? 1 : 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accessToken = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    if (!accessToken) {
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    accountApi
      .getNotifications()
      .then(({ data }) => {
        if (cancelled) return;
        setItems(data.items);
        setUnreadCount(data.unread_count);
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || "Failed to load notifications");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const markRead = (note: InAppNotification) => {
    if (note.read_at) {
      close();
      return;
    }
    setItems((current) =>
      current.map((item) =>
        item.id === note.id
          ? { ...item, read_at: new Date().toISOString() }
          : item,
      ),
    );
    setUnreadCount((current) => Math.max(0, current - 1));
    void accountApi.markNotificationRead(note.id).catch(() => {
      void accountApi.getNotifications().then(({ data }) => {
        setItems(data.items);
        setUnreadCount(data.unread_count);
      });
    });
    close();
  };

  const markAllRead = () => {
    setItems((current) =>
      current.map((item) =>
        item.read_at ? item : { ...item, read_at: new Date().toISOString() },
      ),
    );
    setUnreadCount(0);
    void accountApi.markAllNotificationsRead().then(({ data }) => {
      setItems(data.items);
      setUnreadCount(data.unread_count);
    });
  };

  const hasDataUnread = unreadCount > 0;
  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        className="relative rounded-full border border-ink/15 bg-cream p-2 text-ink transition hover:bg-paper"
        aria-label={t("Notifications")}
      >
        <Bell size={16} />
        {hasDataUnread && (
          <span
            data-testid="notification-unread-indicator"
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent"
          />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-ink/15 bg-cream shadow-[0_12px_32px_rgba(14,14,16,0.14)]">
          <div className="flex items-center justify-between border-b border-ink/10 px-4 py-3">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-ink/60">
              {t("Notifications")}
            </span>
            <div className="flex items-center gap-1">
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="rounded p-1 text-ink/45 transition hover:bg-paper hover:text-ink disabled:opacity-40"
                  aria-label={t("Mark all read")}
                  disabled={unreadCount === 0}
                >
                  <CheckCheck size={14} />
                </button>
              )}
              <Link
                href="/settings/notifications"
                onClick={close}
                className="rounded p-1 text-ink/45 transition hover:bg-paper hover:text-ink"
                aria-label={t("Notification settings")}
              >
                <Settings size={14} />
              </Link>
            </div>
          </div>
          {loading && items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-ink/55">
              {t("Loading notifications")}
            </div>
          ) : error ? (
            <div className="px-4 py-10 text-center text-sm text-ink/55">
              {t("Could not load notifications")}
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-ink/55">
              {t("No new notifications")}
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto py-1">
              {items.map((note) => (
                <Link
                  key={note.id}
                  href={hrefForNotification(note)}
                  onClick={() => markRead(note)}
                  className="block border-b border-ink/10 px-4 py-3 text-left transition last:border-b-0 hover:bg-paper"
                  aria-label={note.title}
                >
                  <div className="flex items-start gap-2">
                    {!note.read_at && (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold text-ink">
                        {note.title}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-ink/60">
                        {note.body}
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function hrefForNotification(note: InAppNotification): string {
  if (note.data.type === "trip_collaboration" && note.data.trip_id) {
    return `/trips/${encodeURIComponent(note.data.trip_id)}`;
  }
  if (note.data.type === "new_follower" && note.data.follower_id) {
    return `/community/${encodeURIComponent(note.data.follower_id)}`;
  }
  if (note.data.type === "route_comment" && note.data.trip_id) {
    return `/trips/${encodeURIComponent(note.data.trip_id)}`;
  }
  if (note.data.type === "ride_like" && note.data.ride_id) {
    return `/rides/${encodeURIComponent(note.data.ride_id)}`;
  }
  if (note.data.type === "hazard_alert") {
    return "/explore";
  }
  if (note.data.type === "subscription_billing") {
    return "/settings/subscription";
  }
  return "/settings/notifications";
}
