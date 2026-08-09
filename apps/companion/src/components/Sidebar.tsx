"use client";

import { useTranslation } from "@/i18n/I18nProvider";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { useSession, signOut } from "next-auth/react";
import {
  BarChart3,
  Bell,
  ChevronLeft,
  ChevronRight,
  History,
  Home,
  type LucideIcon,
  LogOut,
  Map as MapIcon,
  Route,
  Settings,
  Trophy,
  Users,
  WifiOff,
} from "lucide-react";

import { useEffect, useState, type ReactNode } from "react";
import {
  formatRelativeTimeLabel,
  type InAppNotification,
} from "@tarmoto/shared";
import { Mono, Stamp, TarmotoMark } from "@tarmoto/ui";
import { useFormat } from "@/format/FormatProvider";
import { UserAvatar } from "@/components/UserAvatar";
import { useContribution } from "@/hooks/useContribution";
import { useDropdown, useMediaQuery, usePersistentState } from "@/hooks";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { useAuthStore } from "@/stores/auth";
import { useRealtimeStore } from "@/stores/realtime";
import { accountApi } from "@/lib/api";
import { getUserFacingErrorMessage, type EnglishMessageKey } from "@/i18n";

/** Product wordmark; names are intentionally locale-independent. */
const WORDMARK = "TARMOTO";

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
  label: EnglishMessageKey;
  stamp: string;
  icon: LucideIcon;
  section: NavSection;
  /**
   * Optional list of related sub-routes. The nav item highlights as
   * active when the rider is on the primary `href` or any of these.
   */
  match?: string[];
};

const SECTION_LABELS = {
  plan: "Plan",
  activity: "Activity",
  discover: "Discover",
} satisfies Record<Exclude<NavSection, null>, EnglishMessageKey>;

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
  | { type: "section"; label: EnglishMessageKey | null; key: string }
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
  const t = useTranslation();
  const pathname = usePathname();
  // The rider's explicit choice, persisted. `null` = never toggled, so the
  // sidebar follows the viewport default below. Once they collapse/expand it
  // by hand, that preference sticks (and wins over the viewport) until cleared.
  // Read synchronously (usePersistentState, not useLocalStorage) so a manually
  // saved preference is present on the first commit — otherwise the sidebar
  // remounting across a route-group boundary would paint the viewport default
  // for one frame before the stored value lands, flashing expand→collapse.
  const [userCollapsed, setUserCollapsed] = usePersistentState<boolean | null>(
    COLLAPSED_STORAGE_KEY,
    null,
  );
  // Default collapsed below the desktop breakpoint (lg / 1024px) so tablet
  // portrait (e.g. 744px) and narrower start compact; desktop starts expanded.
  const compactViewport = useMediaQuery("(max-width: 1023px)");
  const collapsed = userCollapsed ?? compactViewport;

  // The Community layout already replaces every destination behind this link
  // with the unavailable card, so leaving the entry in the nav advertises a
  // route that can only fail. Filtered here rather than in `NAV_ITEMS` so a
  // live flip re-adds it without a reload.
  const { enabled: communityEnabled } =
    useFeatureKillSwitch("community_access");
  const groups = buildNavGroups(
    communityEnabled
      ? NAV_ITEMS
      : NAV_ITEMS.filter((item) => item.href !== "/community/feed"),
  );

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
              {WORDMARK}
            </span>
          )}
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={() => setUserCollapsed(true)}
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
          onClick={() => setUserCollapsed(false)}
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
  label: EnglishMessageKey | null;
  collapsed: boolean;
}) {
  const t = useTranslation();
  if (label === null) return null;
  if (collapsed) {
    // Tightened divider — separates groups visually without a label.
    return <div aria-hidden="true" className="my-1.5 h-px bg-cream/10" />;
  }
  return (
    <div className="mt-3 mb-1 px-3">
      <Stamp tone="on-dark-dim" className="text-cream/40">
        {t(label)}
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
  const t = useTranslation();
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
      <SidebarContributionBadge collapsed={collapsed} />
      <SidebarOfflineIndicator collapsed={collapsed} />
      <SidebarNotificationBell collapsed={collapsed} />
      <SidebarUserMenu collapsed={collapsed} />
    </div>
  );
}

/**
 * "Your contribution" badge — the rider's road-quality contribution (km of
 * road they've mapped) plus their regional standing. Expanded-rail only, and
 * only once they've mapped something; the regional line + bar are dropped when
 * the rider has no home region (no rank). The bar fills by ranking position
 * (1st = full), derived from the real rank rather than the design's mock 68%.
 */
function SidebarContributionBadge({ collapsed }: { collapsed: boolean }) {
  const t = useTranslation();
  const format = useFormat();
  const { contribution } = useContribution();
  if (collapsed || !contribution || contribution.km_mapped <= 0) return null;

  const {
    km_mapped,
    percentile,
    rank_in_region,
    region_rider_count,
    region_riders_behind,
    home_region,
  } = contribution;
  // Only claim a regional standing when the rider is actually ahead of
  // someone — i.e. not the sole contributor (rank 1 of 1) and not dead last,
  // where "Top 100%" reads as misleading. Gate on `region_riders_behind`
  // (riders strictly below the viewer): `rank_in_region` is a DENSE_RANK, so
  // comparing it to the rider count can't distinguish a genuinely-last rider
  // from one tied behind others. The km total still shows when the line drops.
  const ranked =
    percentile != null &&
    home_region != null &&
    rank_in_region != null &&
    region_rider_count != null &&
    region_rider_count > 0 &&
    region_riders_behind != null &&
    region_riders_behind > 0;
  const barPct = ranked
    ? Math.max(
        2,
        Math.round(
          ((region_rider_count - rank_in_region + 1) / region_rider_count) *
            100,
        ),
      )
    : 0;

  // The backend reports km to one decimal and a single ~100m segment is
  // ~0.1km, so rounding to an integer would show "0 MAPPED" for a fresh
  // contributor. splitDistanceKm keeps one decimal (and converts for
  // imperial riders); the unit feeds the badge label below so the number
  // and its unit always agree. "MAPPED" describes the complete measurement,
  // so it stays after both value and unit even when the locale places the
  // measurement unit before the number.
  const mapped = format.splitDistanceKm(km_mapped);
  const mappedUnit = (
    <Mono className="text-[10px] font-medium text-cream/60">{mapped.unit}</Mono>
  );

  return (
    <div className="mb-1.5 rounded-[10px] border border-cream/[0.08] bg-cream/[0.06] p-3">
      <Stamp tone="on-dark">{t("Your contribution")}</Stamp>
      <div className="mt-1 flex items-baseline gap-1 text-[20px] font-extrabold tracking-[-0.5px] text-cream">
        {mapped.unitPosition === "before" ? mappedUnit : null}
        {mapped.value}
        {mapped.unitPosition === "after" ? mappedUnit : null}
        <Mono className="text-[10px] font-medium text-cream/60">
          {t("MAPPED")}
        </Mono>
      </div>
      {ranked && (
        <>
          <div className="mt-2 h-1 overflow-hidden rounded-sm bg-cream/10">
            <div
              className="h-full rounded-sm bg-accent"
              style={{ width: `${barPct}%` }}
            />
          </div>
          <Mono className="mt-1.5 block text-[9px] text-cream/50">
            {t("Top {percentile} of riders in {region}", {
              percentile: format.number(percentile / 100, {
                style: "percent",
                maximumFractionDigits: 0,
              }),
              region: home_region,
            })}
          </Mono>
        </>
      )}
    </div>
  );
}

const GRACE_PERIOD_MS = 1500;

function SidebarOfflineIndicator({ collapsed }: { collapsed: boolean }) {
  const t = useTranslation();
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
  const t = useTranslation();
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
      .catch((err: unknown) => {
        setError(
          getUserFacingErrorMessage(err, t("Failed to load notifications")),
        );
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
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          getUserFacingErrorMessage(err, t("Failed to load notifications")),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, accessToken]);

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
  const t = useTranslation();
  const format = useFormat();
  return (
    <div
      className={clsx(
        "fixed z-50 rounded-[14px] border border-line-strong bg-cream p-[18px] shadow-[0_24px_60px_rgba(14,14,16,0.25)]",
        // Phone widths: the rail still renders at full width, so anchor the
        // panel as a bottom sheet inset from both edges instead of starting at
        // `aside + 10px` (which would run a 360px panel off a 390px screen).
        "inset-x-3 bottom-3 w-auto",
        // sm+ : fixed just past the rail's right edge. The AppShell is
        // `fixed inset-0` with the sidebar at left:0, so `left = aside width
        // (232 / 72) + 10px gap` places the panel reliably regardless of where
        // the bell sits inside the rail. Bottom-aligned at 80px to match v2.
        // (Still a DOM child of the bell's ref, so click-outside / Escape work.)
        "sm:inset-x-auto sm:bottom-20 sm:w-[360px]",
        collapsed ? "sm:left-[82px]" : "sm:left-[242px]",
      )}
    >
      <div className="mb-3.5 flex items-start justify-between gap-3">
        <div>
          <Stamp>{t("Inbox")}</Stamp>
          <div className="mt-0.5 text-[16px] font-extrabold text-ink">
            {t("Notifications")}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close")}
          className="-mr-1 text-[22px] leading-none text-ink/40 transition hover:text-ink"
        >
          ×
        </button>
      </div>

      {loading && items.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-line px-4 py-10 text-center text-sm text-fg-dim">
          {t("Loading notifications")}
        </div>
      ) : error ? (
        <div className="rounded-[10px] border border-dashed border-line px-4 py-10 text-center text-sm text-quality-q1">
          {t("Could not load notifications")}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-line px-6 py-10 text-center">
          <Bell
            size={22}
            className="mx-auto mb-2.5 text-fg-mute"
            aria-hidden="true"
          />
          <div className="text-[15px] font-bold text-ink">
            {t("You're all caught up")}
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-fg-dim">
            {t(
              "Hazard alerts, ride milestones, and community activity will land here.",
            )}
          </p>
        </div>
      ) : (
        <div className="flex max-h-[380px] flex-col gap-2 overflow-y-auto">
          {items.map((note) => (
            <Link
              key={note.id}
              href={hrefForNotification(note)}
              onClick={() => onMarkRead(note)}
              className="flex items-start gap-2.5 rounded-[10px] border border-line bg-paper p-3 text-left transition hover:border-line-strong"
              aria-label={note.title}
            >
              <span
                className={clsx(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  note.read_at ? "bg-ink/40" : "bg-accent",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-bold text-ink">
                  {note.title}
                </div>
                <div className="mt-1 text-[11px] text-fg-dim">
                  {note.body} ·{" "}
                  {formatRelativeTimeLabel(note.created_at, { format }, t)}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onMarkAllRead}
        disabled={unreadCount === 0}
        className="mt-3 w-full rounded-lg border border-line py-2.5 text-center text-[12px] font-bold text-fg-dim transition hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim"
      >
        {t("Mark all as read")}
      </button>
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
  const t = useTranslation();
  const { data: session } = useSession();
  const user = session?.user;
  const { open, close, toggle, ref } = useDropdown();

  const handleLogout = () => {
    close();
    void signOut({ callbackUrl: "/login" });
  };

  const accountLabel = user?.displayName
    ? t("Account menu — {name}", { name: user.displayName })
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
        <UserAvatar
          name={user?.displayName ?? t("Rider")}
          size={28}
          fontSize={13}
          accent
        />
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
