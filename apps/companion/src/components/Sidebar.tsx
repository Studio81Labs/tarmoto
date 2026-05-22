"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { useSession, signOut } from "next-auth/react";
import {
  BarChart3,
  Bell,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  History,
  Home,
  type LucideIcon,
  LogOut,
  Map as MapIcon,
  Route,
  Settings,
  Settings2,
  Trophy,
  Users,
  WifiOff,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { InAppNotification } from "@tarmoto/shared";
import { Mono, Stamp } from "@tarmoto/ui";
import { useDropdown, useLocalStorage } from "@/hooks";
import { useAuthStore } from "@/stores/auth";
import { useRealtimeStore } from "@/stores/realtime";
import { accountApi } from "@/lib/api";
import { TarmotoMark } from "./tarmoto/atoms";
import { t } from "@/i18n";

/**
 * Tarmoto sidebar — single source of navigation chrome. Mirrors the
 * Web App v2 design map (§14 NavRail): flat nav with section splitters,
 * stamp + icon + label per item, collapsible to a 72 px icon rail.
 * Sub-routes (Road map, Compare, Collections) are reached via in-page
 * tab strips on the parent rather than expanded nav children.
 */

type NavSection = "plan" | "activity" | "discover" | null;

type NavItem = {
  href: string;
  label: string;
  stamp: string;
  icon: LucideIcon;
  section: NavSection;
  /**
   * Optional list of related sub-routes. The nav item highlights as
   * active when the rider is on the primary `href` or any of these.
   */
  match?: string[];
};

const SECTION_LABELS: Record<Exclude<NavSection, null>, string> = {
  plan: "Plan",
  activity: "Activity",
  discover: "Discover",
};

const NAV_ITEMS: NavItem[] = [
  {
    href: "/",
    stamp: "00",
    label: "Home",
    icon: Home,
    section: null,
  },
  {
    href: "/trips",
    stamp: "01",
    label: "Trips",
    icon: Route,
    section: "plan",
  },
  {
    href: "/explore",
    stamp: "02",
    label: "Road Explorer",
    icon: MapIcon,
    section: "plan",
  },
  {
    href: "/rides",
    stamp: "03",
    label: "Ride History",
    icon: History,
    section: "activity",
    match: ["/rides/road-map", "/rides/compare"],
  },
  {
    href: "/rides/stats",
    stamp: "04",
    label: "Statistics",
    icon: BarChart3,
    section: "activity",
  },
  {
    href: "/community/feed",
    stamp: "05",
    label: "Community",
    icon: Users,
    section: "discover",
    match: ["/community"],
  },
  {
    href: "/achievements",
    stamp: "06",
    label: "Achievements",
    icon: Trophy,
    section: "discover",
  },
];

const COLLAPSED_STORAGE_KEY = "tarmoto:sidebar-collapsed";

type NavGroup =
  | { type: "section"; label: string | null; key: string }
  | { type: "item"; item: NavItem };

function buildNavGroups(items: ReadonlyArray<NavItem>): NavGroup[] {
  const groups: NavGroup[] = [];
  let last: NavSection | undefined;
  items.forEach((item, i) => {
    if (item.section !== last) {
      groups.push({
        type: "section",
        label: item.section ? SECTION_LABELS[item.section] : null,
        key: `sec-${i}`,
      });
      last = item.section;
    }
    groups.push({ type: "item", item });
  });
  return groups;
}

function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.href === "/") return pathname === "/";
  // Promote the more-specific match: when on /rides/stats the
  // "Statistics" item wins, not "Ride History" — even though both
  // technically share the /rides prefix.
  const moreSpecific = NAV_ITEMS.find(
    (other) =>
      other !== item &&
      other.href !== "/" &&
      other.href.startsWith(item.href + "/") &&
      pathname.startsWith(other.href),
  );
  if (moreSpecific) return false;
  if (pathname === item.href || pathname.startsWith(item.href + "/")) {
    return true;
  }
  return (
    item.match?.some((m) => pathname === m || pathname.startsWith(m + "/")) ??
    false
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useLocalStorage<boolean>(
    COLLAPSED_STORAGE_KEY,
    false,
  );

  const groups = buildNavGroups(NAV_ITEMS);

  return (
    <aside
      className={clsx(
        "flex shrink-0 flex-col gap-4 border-r border-ink/10 bg-ink py-5 text-cream transition-[width] duration-200",
        collapsed ? "w-[72px] px-2.5" : "w-[232px] px-3.5",
      )}
      aria-label={t("Primary")}
    >
      {/* Brand + collapse toggle */}
      <div
        className={clsx(
          "flex items-center gap-2.5",
          collapsed ? "justify-center" : "px-1.5",
        )}
      >
        <Link
          href="/"
          className="flex items-center gap-2.5"
          aria-label={t("Tarmoto")}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-accent">
            <TarmotoMark size={20} />
          </span>
          {!collapsed && (
            <span className="text-[15px] font-extrabold tracking-tight text-cream">
              TARMOTO
            </span>
          )}
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="ml-auto flex h-6 w-6 items-center justify-center rounded-md bg-cream/5 text-cream/60 transition hover:bg-cream/10 hover:text-cream"
            aria-label={t("Collapse sidebar")}
          >
            <ChevronLeft size={14} />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex h-8 w-full items-center justify-center rounded-lg text-cream/60 transition hover:bg-cream/10 hover:text-cream"
          aria-label={t("Expand sidebar")}
        >
          <ChevronRight size={14} />
        </button>
      )}

      <div className="h-px bg-cream/10" />

      {/* Nav — flat list with section splitters */}
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
        {groups.map((g) =>
          g.type === "section" ? (
            <SectionSplitter
              key={g.key}
              label={g.label}
              collapsed={collapsed}
            />
          ) : (
            <SidebarItem
              key={g.item.href}
              item={g.item}
              active={isItemActive(g.item, pathname)}
              collapsed={collapsed}
            />
          ),
        )}
      </nav>

      <SidebarFooter collapsed={collapsed} />
    </aside>
  );
}

function SectionSplitter({
  label,
  collapsed,
}: {
  label: string | null;
  collapsed: boolean;
}) {
  if (label === null) return null;
  if (collapsed) {
    // Tightened divider — separates groups visually without a label.
    return <div aria-hidden="true" className="my-1.5 h-px bg-cream/10" />;
  }
  return (
    <div className="mt-3 mb-1 px-3">
      <Stamp tone="on-dark-dim" className="text-cream/40">
        {label}
      </Stamp>
    </div>
  );
}

function SidebarItem({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const label = t(item.label);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "flex items-center rounded-lg transition-colors",
        collapsed ? "justify-center px-0 py-2.5" : "gap-2.5 px-3 py-2.5",
        active ? "bg-accent text-ink" : "text-cream hover:bg-cream/5",
      )}
    >
      {!collapsed && (
        <Mono
          className={clsx(
            "w-[18px] shrink-0 text-[10px] font-bold tracking-[1px]",
            active ? "text-ink" : "text-cream/40",
          )}
        >
          {item.stamp}
        </Mono>
      )}
      <Icon size={18} strokeWidth={1.9} className="shrink-0" />
      {!collapsed && (
        <span
          className={clsx(
            "text-[13px]",
            active ? "font-extrabold" : "font-semibold",
          )}
        >
          {label}
        </span>
      )}
    </Link>
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
    ? t("Offline")
    : status === "connecting"
      ? t("Reconnecting…")
      : t("Realtime paused");
  const title = !isOnline
    ? t("Browser is offline; cached map tiles and data may be shown")
    : t("Real-time updates are reconnecting");
  return (
    <div
      role="status"
      aria-live="polite"
      title={title}
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
        setError(err.message || t("Failed to load notifications"));
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
        setError(err.message || t("Failed to load notifications"));
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
        <NotificationsDropdown
          collapsed={collapsed}
          items={items}
          loading={loading}
          error={error}
          unreadCount={unreadCount}
          onMarkRead={markRead}
          onMarkAllRead={markAllRead}
          onClose={close}
        />
      )}
    </div>
  );
}

function NotificationsDropdown({
  collapsed,
  items,
  loading,
  error,
  unreadCount,
  onMarkRead,
  onMarkAllRead,
  onClose,
}: {
  collapsed: boolean;
  items: InAppNotification[];
  loading: boolean;
  error: string | null;
  unreadCount: number;
  onMarkRead: (note: InAppNotification) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
}): ReactNode {
  return (
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
              onClick={onMarkAllRead}
              className="rounded p-1 text-ink/45 transition hover:bg-paper hover:text-ink disabled:opacity-40"
              aria-label={t("Mark all read")}
              disabled={unreadCount === 0}
            >
              <CheckCheck size={14} />
            </button>
          )}
          <Link
            href="/settings/notifications"
            onClick={onClose}
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
              onClick={() => onMarkRead(note)}
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
          "flex w-full items-center rounded-lg border border-cream/8 transition hover:bg-cream/5",
          collapsed ? "h-9 w-9 justify-center p-0" : "gap-2.5 px-2 py-1.5",
        )}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-bold text-ink">
          {initial}
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1 text-left leading-none">
            <span className="block truncate text-[12px] font-bold text-cream">
              {user?.displayName ?? t("Rider")}
            </span>
            <Mono className="mt-1 block text-[9px] tracking-[1px] text-cream/50">
              {t("ACCOUNT")}
            </Mono>
          </span>
        )}
        {!collapsed && (
          <Settings size={14} className="ml-1 shrink-0 text-cream/45" />
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
