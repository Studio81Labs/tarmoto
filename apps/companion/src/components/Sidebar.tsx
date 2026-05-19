"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { useSession, signOut } from "next-auth/react";
import {
  Bell,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Settings,
  Settings2,
  WifiOff,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { InAppNotification } from "@tarmoto/shared";
import { useDropdown, useLocalStorage } from "@/hooks";
import { useAuthStore } from "@/stores/auth";
import { useRealtimeStore } from "@/stores/realtime";
import { accountApi } from "@/lib/api";
import { TarmotoMark } from "./tarmoto/atoms";
import { t } from "@/i18n";

/**
 * Tarmoto sidebar — single source of navigation chrome (the top bar was
 * removed in shell v2). The rail flips between expanded (220px, label +
 * stamp) and collapsed (72px, stamp acting as an icon) modes; state is
 * persisted in localStorage so the rider's preference survives reloads.
 *
 * Bottom block: offline indicator, notification bell (rich dropdown,
 * unread badge), and user menu (avatar + dropdown with Settings / Log
 * out). Settings is no longer a top-level nav item — it lives only
 * inside the user menu now.
 */

type NavSubItem = {
  href: string;
  label: string;
};

// `href` is optional. A NAV_ITEM without `href` is a section group
// rather than a destination — clicking the parent does nothing and the
// children render unconditionally. Used for `/community`, which has no
// overview page of its own (the section IS its children).
type NavItem = {
  href?: string;
  label: string;
  stamp: string;
  // Sub-routes that render under the parent. Behaviour depends on whether
  // the parent has its own `href`:
  // - With href: children render only while the rider is in-section,
  //   mirroring the legacy per-page top tab strips (e.g. the old
  //   `RidesSubNav`).
  // - Without href: children render unconditionally because the parent
  //   is the only way into the section.
  children?: NavSubItem[];
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", stamp: "00", label: "Home" },
  { href: "/trips", stamp: "01", label: "Trips" },
  { href: "/explore", stamp: "02", label: "Road Explorer" },
  {
    href: "/rides",
    stamp: "03",
    label: "Ride History",
    children: [
      { href: "/rides/stats", label: "Statistics" },
      { href: "/rides/road-map", label: "Road map" },
      { href: "/rides/compare", label: "Compare rides" },
    ],
  },
  {
    stamp: "04",
    label: "Community",
    children: [
      { href: "/community/feed", label: "Feed" },
      { href: "/community/collections", label: "Collections" },
    ],
  },
  { href: "/gamification", stamp: "05", label: "Achievements" },
];

const COLLAPSED_STORAGE_KEY = "tarmoto:sidebar-collapsed";

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useLocalStorage<boolean>(
    COLLAPSED_STORAGE_KEY,
    false,
  );

  return (
    <aside
      className={clsx(
        "flex shrink-0 flex-col gap-5 border-r border-ink/10 bg-ink py-5 text-cream transition-[width] duration-200",
        collapsed ? "w-[72px] px-2" : "w-[220px] px-3.5",
      )}
      aria-label={t("Primary")}
    >
      {/* Logo + collapse toggle */}
      <div
        className={clsx(
          "flex items-center",
          collapsed ? "justify-center" : "justify-between",
        )}
      >
        <Link
          href="/"
          className="flex items-center gap-2.5 px-1.5"
          aria-label={t("Tarmoto")}
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
            <TarmotoMark size={18} />
          </span>
          {!collapsed && (
            <span className="leading-none">
              <span className="block text-[15px] font-bold tracking-tight text-cream">
                TARMOTO
              </span>
              <span className="mt-0.5 block font-mono text-[9px] tracking-[1px] text-cream/50">
                WEB · v1.4
              </span>
            </span>
          )}
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-cream/60 transition hover:bg-cream/10 hover:text-cream"
            aria-label={t("Collapse sidebar")}
          >
            <ChevronLeft size={16} />
          </button>
        )}
      </div>

      {/* Expand toggle when collapsed — sits below the logo, full-width tap target */}
      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex h-8 w-full items-center justify-center rounded-lg text-cream/60 transition hover:bg-cream/10 hover:text-cream"
          aria-label={t("Expand sidebar")}
        >
          <ChevronRight size={16} />
        </button>
      )}

      <div className="h-px bg-cream/10" />

      {/* Navigation */}
      <nav className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const parentHref = item.href;
          const inSection =
            parentHref === undefined
              ? // Section groups (linkless) — derive presence from the
                // first child so the rider's current sub-route still
                // counts as "in this section" for child highlighting.
                (item.children?.some((child) =>
                  pathname.startsWith(child.href),
                ) ?? false)
              : parentHref === "/"
                ? pathname === "/"
                : pathname.startsWith(parentHref);
          const isActive = (() => {
            if (parentHref === undefined) return false;
            if (parentHref === "/") return pathname === "/";
            if (!pathname.startsWith(parentHref)) return false;
            const hasMoreSpecific = NAV_ITEMS.some(
              (other) =>
                other.href !== undefined &&
                other.href !== parentHref &&
                other.href.startsWith(parentHref) &&
                pathname.startsWith(other.href),
            );
            return !hasMoreSpecific;
          })();
          // Section groups (no parent href) always reveal their
          // children so the rider can reach them from anywhere; link
          // parents follow the legacy in-section gating.
          const showChildren =
            !collapsed &&
            item.children !== undefined &&
            (parentHref === undefined || inSection);
          const parentClassName = clsx(
            "flex items-center rounded-lg py-2.5 transition-colors",
            collapsed ? "justify-center px-0" : "gap-2.5 px-3",
            parentHref === undefined
              ? "text-cream/70"
              : isActive
                ? "bg-accent text-ink"
                : "text-cream hover:bg-cream/5",
          );
          const stampClassName = clsx(
            "font-mono text-[10px] font-bold tracking-[1px]",
            collapsed ? "" : "w-6",
            isActive ? "text-ink" : "text-cream/40",
          );
          const labelClassName = clsx(
            "text-[13px]",
            isActive ? "font-bold" : "font-semibold",
          );
          const parentInner = (
            <>
              <span aria-hidden="true" className={stampClassName}>
                {item.stamp}
              </span>
              {!collapsed && (
                <span className={labelClassName}>{item.label}</span>
              )}
            </>
          );
          return (
            <div
              key={parentHref ?? item.label}
              className="flex flex-col gap-0.5"
            >
              {parentHref !== undefined ? (
                <Link
                  href={parentHref}
                  aria-current={isActive ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                  className={parentClassName}
                >
                  {parentInner}
                </Link>
              ) : (
                // Section group: not a link. Render as a plain row so
                // the rider sees the heading and goes straight to the
                // children below.
                <div
                  title={collapsed ? item.label : undefined}
                  className={parentClassName}
                >
                  {parentInner}
                </div>
              )}

              {showChildren && (
                <div className="ml-9 flex flex-col gap-0.5 border-l border-cream/10 pl-2">
                  {item.children?.map((child) => {
                    const childActive = pathname.startsWith(child.href);
                    return (
                      <Link
                        key={child.href}
                        href={child.href}
                        aria-current={childActive ? "page" : undefined}
                        className={clsx(
                          "rounded-md px-2 py-1.5 text-[12px] transition-colors",
                          childActive
                            ? "bg-cream/10 font-semibold text-cream"
                            : "text-cream/60 hover:bg-cream/5 hover:text-cream",
                        )}
                      >
                        {child.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="flex-1" />

      <SidebarFooter collapsed={collapsed} />
    </aside>
  );
}

function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={clsx("flex flex-col gap-1.5", collapsed && "items-center")}>
      <SidebarOfflineIndicator collapsed={collapsed} />
      <SidebarNotificationBell collapsed={collapsed} />
      <SidebarUserMenu collapsed={collapsed} />
    </div>
  );
}

const GRACE_PERIOD_MS = 1500;

function SidebarOfflineIndicator({ collapsed }: { collapsed: boolean }) {
  const status = useRealtimeStore((s) => s.status);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [showOffline, setShowOffline] = useState(false);

  useEffect(() => {
    const onOffline = () => {
      setIsOnline(false);
      setShowOffline(true);
    };
    const onOnline = () => {
      setIsOnline(true);
      setShowOffline(false);
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => {
    if (!isOnline) {
      setShowOffline(true);
      return;
    }
    if (status === "connected") {
      setShowOffline(false);
      return;
    }
    const timer = window.setTimeout(
      () => setShowOffline(true),
      GRACE_PERIOD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [isOnline, status]);

  if (!showOffline || (isOnline && status === "connected")) return null;
  const label = !isOnline
    ? "Offline"
    : status === "connecting"
      ? "Reconnecting…"
      : "Realtime paused";
  const title = !isOnline
    ? "Browser is offline; cached map tiles and data may be shown"
    : "Real-time updates are reconnecting";
  return (
    <div
      role="status"
      aria-live="polite"
      title={t(title)}
      className={clsx(
        "flex items-center rounded-lg border border-accent/40 bg-accent/15 text-[11px] font-bold text-cream",
        collapsed ? "h-9 w-9 justify-center" : "gap-1.5 px-2.5 py-1.5",
      )}
    >
      <WifiOff size={12} />
      {!collapsed && <span>{label}</span>}
    </div>
  );
}

function SidebarNotificationBell({ collapsed }: { collapsed: boolean }) {
  const { open, close, toggle, ref } = useDropdown();
  const [items, setItems] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accessToken = useAuthStore((s) => s.accessToken);

  const refreshNotifications = () => {
    void accountApi
      .getNotifications()
      .then(({ data }) => {
        setItems(data.items);
        setUnreadCount(data.unread_count);
        setError(null);
      })
      .catch((err: Error) => {
        setError(err.message || "Failed to load notifications");
      });
  };

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
      refreshNotifications();
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
    void accountApi
      .markAllNotificationsRead()
      .then(({ data }) => {
        setItems(data.items);
        setUnreadCount(data.unread_count);
        setError(null);
      })
      .catch(() => {
        refreshNotifications();
      });
  };

  const hasDataUnread = unreadCount > 0;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        title={collapsed ? t("Notifications") : undefined}
        aria-label={t("Notifications")}
        className={clsx(
          "relative flex w-full items-center rounded-lg text-cream transition hover:bg-cream/5",
          collapsed ? "h-9 w-9 justify-center" : "gap-2.5 px-3 py-2",
        )}
      >
        <Bell size={16} />
        {!collapsed && (
          <span className="text-[13px] font-semibold">
            {t("Notifications")}
          </span>
        )}
        {hasDataUnread && (
          <span
            data-testid="notification-unread-indicator"
            className={clsx(
              "absolute h-2 w-2 rounded-full bg-accent",
              collapsed
                ? "right-1.5 top-1.5"
                : "right-3 top-1/2 -translate-y-1/2",
            )}
          />
        )}
      </button>

      {open && (
        // Anchored to the left of the sidebar so the panel doesn't clip on
        // narrow viewports when the sidebar is collapsed. `bottom-full`
        // mirrors the top-bar's `top-full` pattern — sidebar is bottom-up.
        <div
          className={clsx(
            "absolute z-50 mb-2 w-80 overflow-hidden rounded-xl border border-ink/15 bg-cream shadow-[0_12px_32px_rgba(14,14,16,0.14)]",
            collapsed ? "bottom-0 left-full ml-2" : "bottom-full left-0",
          )}
        >
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
                <Settings2 size={14} />
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

function SidebarUserMenu({ collapsed }: { collapsed: boolean }) {
  const { data: session } = useSession();
  const user = session?.user;
  const { open, close, toggle, ref } = useDropdown();
  const initial = user?.displayName?.[0]?.toUpperCase() ?? "T";

  const handleLogout = () => {
    close();
    void signOut({ callbackUrl: "/login" });
  };

  // Stable accessible name across collapsed / expanded states.
  // Collapsed renders only the avatar initial, so without an
  // explicit `aria-label` AT would expose this as a one-letter
  // button ("R") — a rider on a screen reader would have no
  // discoverable Settings / Log out entry behind it.
  const accountLabel = user?.displayName
    ? `${t("Account menu")} — ${user.displayName}`
    : t("Account menu");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        title={collapsed ? (user?.displayName ?? t("Rider")) : undefined}
        aria-label={accountLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        className={clsx(
          "flex w-full items-center rounded-lg transition hover:bg-cream/5",
          collapsed ? "h-9 w-9 justify-center p-0" : "gap-2.5 px-1.5 py-1.5",
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-bold text-ink">
          {initial}
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1 text-left leading-none">
            <span className="block truncate text-[12px] font-bold text-cream">
              {user?.displayName ?? t("Rider")}
            </span>
            <span className="mt-1 block font-mono text-[9px] tracking-[1px] text-cream/50">
              {t("ACCOUNT")}
            </span>
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={clsx(
            "absolute z-50 mb-2 w-52 overflow-hidden rounded-xl border border-ink/15 bg-cream py-1 shadow-[0_12px_32px_rgba(14,14,16,0.14)]",
            collapsed ? "bottom-0 left-full ml-2" : "bottom-full left-0",
          )}
        >
          <Link
            href="/settings"
            role="menuitem"
            onClick={close}
            className="flex items-center gap-3 px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-paper"
          >
            <Settings size={16} />
            {t("Settings")}
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={handleLogout}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-quality-very-poor/15 hover:text-quality-very-poor"
          >
            <LogOut size={16} />
            {t("Log out")}
          </button>
        </div>
      )}
    </div>
  );
}
