/**
 * TripsScreen — entry point for the Trips tab.
 *
 * Lists the rider's saved trips (via `api.listTrips`) with a primary CTA to
 * plan a new one. This is the landing surface for the US-7 auto-generated
 * multi-day route flow — the "Plan a trip" button kicks off the full
 * create → generate → detail flow.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Icon } from "@/components/Icon";
import {
  ACCENT_DARK,
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { api } from "@/services/api";
import { useAuthStore, useTripStore } from "@/stores";
import type { TripFolder, TripSummary } from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";
import { formatStatus } from "./TripScreens.helpers";
import {
  countActiveTrips,
  groupTripsByFolder,
  type TripsListRow,
} from "./TripsScreen.helpers";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFormat } from "@/format/FormatProvider";
import { useEntitlements, useLimit } from "@/hooks/useEntitlements";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
import { isWithinLimit } from "@tarmoto/shared";

type TripsNav = NativeStackNavigationProp<TripsStackParamList, "TripsList">;

type Phase = "loading" | "ready" | "error";

const t = brandColorsLight;

export default function TripsScreen() {
  const translate = useTranslation();
  const navigation = useNavigation<TripsNav>();
  const trips = useTripStore((s) => s.trips);
  const setTrips = useTripStore((s) => s.setTrips);

  const [phase, setPhase] = useState<Phase>(
    trips.length > 0 ? "ready" : "loading",
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // US-37 — folders are read-only on mobile for v1. We tolerate a
  // failed folders fetch (e.g. older backend without the endpoint) by
  // keeping the list flat instead of blocking trip rendering on it.
  const [folders, setFolders] = useState<TripFolder[]>([]);

  // `load`'s two callers want different UX: the initial mount with no
  // cache shows the full-screen spinner, while a re-focus after we
  // already have trips should just flip the RefreshControl. Read cache
  // presence from a ref so the callback identity stays stable — if it
  // closed over `trips.length` directly, `load` would be recreated each
  // time the list landed, causing `useFocusEffect` to re-fire on the
  // same focus session.
  const hasCachedTripsRef = useRef(trips.length > 0);
  useEffect(() => {
    hasCachedTripsRef.current = trips.length > 0;
  }, [trips.length]);

  const load = useCallback(
    async (isInitial: boolean) => {
      const hadCache = hasCachedTripsRef.current;
      if (isInitial && !hadCache) {
        setPhase("loading");
        setErrorMessage(null);
      } else {
        setIsRefreshing(true);
      }
      try {
        // Issue both fetches in parallel — the folders endpoint is the
        // smaller request; the trips fetch dominates wall-clock time so
        // serialising would just inflate latency on every reload. A
        // folders failure must NOT 4xx the trip list — fall back to the
        // flat list (existing behaviour) and surface the trips anyway.
        const [nextTrips, nextFolders] = await Promise.all([
          api.listTrips(),
          api.listTripFolders().catch(() => [] as TripFolder[]),
        ]);
        setTrips(nextTrips);
        setFolders(nextFolders);
        setPhase("ready");
      } catch (err) {
        // Refresh failures: keep showing cached trips. Initial failures
        // with no cache: surface a full error state so the user knows
        // something's off.
        if (isInitial && !hadCache) {
          setPhase("error");
          setErrorMessage(
            getUserFacingErrorMessage(err, translate("Unable to load trips")),
          );
        }
      } finally {
        setIsRefreshing(false);
      }
    },
    [setTrips, translate],
  );

  // One effect handles both the initial load and every re-focus: on the
  // first run we pass isInitial=true (so the empty state renders the
  // full-screen spinner, not a cached-data refresh indicator) and on
  // subsequent focuses we pass false. A separate `useEffect` + focus
  // effect would double-fire on mount.
  const hasLoadedOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      const isInitial = !hasLoadedOnceRef.current;
      hasLoadedOnceRef.current = true;
      void load(isInitial);
    }, [load]),
  );

  // #M3 — max_active_trips is a Free-tier limit (1; Pro/Premium
  // unlimited). This screen already loads the rider's owned-trip list,
  // so the current active-trip count is available here without an
  // extra fetch.
  const { limit: activeTripsLimit, isResolved: activeTripsLimitResolved } =
    useLimit("max_active_trips");
  // Operator kill switch (`trip_planning`, fail-SAFE off /config/flags): an
  // operator disables the planner during a backend outage. Broader than the
  // max_active_trips=0 creation cap — it also blocks JOINING — but likewise
  // leaves existing trips readable. Hides the create/join affordances and
  // guards their callbacks; detail viewing of saved trips is unaffected.
  const tripPlanningEnabled = useFeatureKillSwitchActive("trip_planning");
  const { tier } = useEntitlements();
  const [showLimitUpgrade, setShowLimitUpgrade] = useState(false);
  // Owner-scoped: only trips this rider OWNS count against their
  // max_active_trips cap (joined-collaborator trips occupy the owner's cap),
  // matching the backend's assertCanMintOpenTrip.
  const currentUserId = useAuthStore((s) => s.user?.id);
  const activeTripCount = useMemo(
    () => countActiveTrips(trips, currentUserId),
    [trips, currentUserId],
  );

  const openCreate = useCallback(() => {
    // Planner killed — no new trips (belt-and-braces; the FAB/CTA are hidden).
    if (!tripPlanningEnabled) return;
    // Fail closed while the limit snapshot hasn't resolved yet — never
    // mint on an unknown cap. The FAB is also visually disabled below
    // for the same reason.
    if (!activeTripsLimitResolved) return;
    // At/over the cap: block the mint and show the upsell instead of
    // letting `POST /trips` 403 with no explanation. TripCreateScreen's
    // handleGenerate/handleImport carry the matching reactive safety
    // net for a revoke between this check and the request landing.
    if (!isWithinLimit(activeTripsLimit, activeTripCount)) {
      setShowLimitUpgrade(true);
      return;
    }
    navigation.navigate("TripCreate");
  }, [
    navigation,
    tripPlanningEnabled,
    activeTripsLimitResolved,
    activeTripsLimit,
    activeTripCount,
  ]);

  const openJoin = useCallback(() => {
    if (!tripPlanningEnabled) return;
    navigation.navigate("TripJoin");
  }, [navigation, tripPlanningEnabled]);

  const openDetail = useCallback(
    (tripId: string) => navigation.navigate("TripDetail", { tripId }),
    [navigation],
  );

  // Hooks must run unconditionally on every render — this used to sit
  // after the `phase` early returns below, which meant the very first
  // "loading" render (fresh install, no cached trips) called fewer
  // hooks than the "ready" render that follows it once `load` resolves,
  // tripping React's "Rendered more hooks than during the previous
  // render" invariant. Hoisted above the early returns to fix that (pre-
  // existing bug surfaced while adding the #M3 gating hooks above).
  const rows = useMemo(
    () => groupTripsByFolder(trips, folders),
    [trips, folders],
  );

  if (phase === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={t.fg} />
      </View>
    );
  }

  if (phase === "error") {
    return (
      <View style={styles.centered}>
        <Icon name="wifi-off" size={40} color={t.dim} />
        <Text style={styles.emptyTitle}>{translate("Can't load trips")}</Text>
        <Text style={styles.emptyBody}>
          {errorMessage ?? translate("Check your connection and try again.")}
        </Text>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => void load(true)}
        >
          <Text style={styles.primaryBtnLabel}>{translate("Retry")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList<TripsListRow>
        data={rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => void load(false)}
            tintColor={t.fg}
          />
        }
        ListEmptyComponent={
          <EmptyState
            onCreate={openCreate}
            onJoin={openJoin}
            createDisabled={!activeTripsLimitResolved}
            planningEnabled={tripPlanningEnabled}
          />
        }
        ListHeaderComponent={
          trips.length > 0 && tripPlanningEnabled ? (
            <ListHeader onJoin={openJoin} />
          ) : null
        }
        renderItem={({ item }) =>
          item.kind === "folder-header" ? (
            <FolderHeader label={item.label} count={item.count} />
          ) : (
            <TripCard
              trip={item.trip}
              onPress={() => openDetail(item.trip.id)}
            />
          )
        }
        ItemSeparatorComponent={({ leadingItem, trailingItem }) => {
          // Skip the separator immediately above a folder header so
          // the header sits flush with the next group instead of
          // floating in space, and tighten the gap between header and
          // its first trip.
          const lead = leadingItem as TripsListRow | undefined;
          const trail = trailingItem as TripsListRow | undefined;
          if (
            lead?.kind === "folder-header" ||
            trail?.kind === "folder-header"
          ) {
            return <View style={styles.headerSeparator} />;
          }
          return <View style={styles.separator} />;
        }}
      />
      {trips.length > 0 && tripPlanningEnabled ? (
        <TouchableOpacity
          style={[styles.fab, !activeTripsLimitResolved && styles.fabDisabled]}
          onPress={openCreate}
          disabled={!activeTripsLimitResolved}
          accessibilityRole="button"
          accessibilityLabel={translate("Plan a new trip")}
          accessibilityState={{ disabled: !activeTripsLimitResolved }}
        >
          <Icon name="plus" size={24} color={t.fg} />
          <Text style={styles.fabLabel}>{translate("Plan a trip")}</Text>
        </TouchableOpacity>
      ) : null}
      <UpgradePrompt
        visible={showLimitUpgrade}
        capability={{
          limit: "max_active_trips",
          resolvedLimit: activeTripsLimit,
        }}
        currentTier={tier ?? "free"}
        message={translate(
          "Free riders can keep {limit, plural, one {# active trip} other {# active trips}}. Upgrade for more.",
          { limit: activeTripsLimit ?? 1 },
        )}
        neutralMessage={translate(
          "Your plan allows {limit, plural, one {# active trip} other {# active trips}}.",
          { limit: activeTripsLimit ?? 1 },
        )}
        onClose={() => setShowLimitUpgrade(false)}
      />
    </View>
  );
}

function FolderHeader({
  label,
  count,
}: {
  label: string | null;
  count: number;
}) {
  const format = useFormat();
  // Subscribe at the row boundary so the locale-owned pseudo-folder label
  // updates even while the memoized grouping data keeps the same identity.
  const translateHeader = useTranslation();
  const displayLabel = label ?? translateHeader("Unfiled");
  return (
    <View
      style={styles.folderHeader}
      accessibilityRole="header"
      accessibilityLabel={translateHeader(
        "{label}, {count, plural, one {# trip} other {# trips}}",
        {
          label: displayLabel,
          count,
        },
      )}
    >
      <Icon name="folder-outline" size={14} color={t.dim} />
      <Text style={styles.folderHeaderLabel} numberOfLines={1}>
        {displayLabel}
      </Text>
      <Text style={styles.folderHeaderCount}>{format.integer(count)}</Text>
    </View>
  );
}

function ListHeader({ onJoin }: { onJoin: () => void }) {
  const translate = useTranslation();
  return (
    <TouchableOpacity
      style={styles.joinRow}
      onPress={onJoin}
      accessibilityRole="button"
      accessibilityLabel={translate("Join a trip with an invite code")}
    >
      <View style={styles.joinIconWrap}>
        <Icon name="account-multiple-plus" size={20} color={t.fg} />
      </View>
      <View style={styles.joinBody}>
        <Text style={styles.joinTitle}>{translate("Join a trip")}</Text>
        <Text style={styles.joinSubtitle}>
          {translate(
            "Got an invite code? Ride along with the rest of the group.",
          )}
        </Text>
      </View>
      <Icon name="chevron-right" size={22} color={t.faint} />
    </TouchableOpacity>
  );
}

function EmptyState({
  onCreate,
  onJoin,
  createDisabled,
  planningEnabled,
}: {
  onCreate: () => void;
  onJoin: () => void;
  /** Mirrors the FAB: fail-closed while the max_active_trips snapshot is
   *  unresolved so the primary CTA can't silently no-op. */
  createDisabled: boolean;
  /** Operator `trip_planning` kill switch — hide the plan/join CTAs when off. */
  planningEnabled: boolean;
}) {
  const translate = useTranslation();
  return (
    <View style={styles.emptyWrap}>
      <Icon name="calendar-blank-outline" size={48} color={t.accent} />
      <Text style={styles.emptyTitle}>{translate("No trips yet")}</Text>
      <Text style={styles.emptyBody}>
        {translate(
          "Tarmoto finds the best roads for a multi-day ride. Pick a few parameters and we'll auto-generate the route.",
        )}
      </Text>
      {planningEnabled ? (
        <>
          <TouchableOpacity
            style={[styles.primaryBtn, createDisabled && styles.fabDisabled]}
            onPress={onCreate}
            disabled={createDisabled}
            accessibilityRole="button"
            accessibilityLabel={translate("Plan a trip")}
            accessibilityState={{ disabled: createDisabled }}
          >
            <Icon name="plus" size={18} color={t.invFg} />
            <Text style={styles.primaryBtnLabel}>
              {translate("Plan a trip")}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={onJoin}>
            <Icon name="account-multiple-plus" size={18} color={t.fg} />
            <Text style={styles.secondaryBtnLabel}>
              {translate("Join with invite code")}
            </Text>
          </TouchableOpacity>
        </>
      ) : null}
    </View>
  );
}

function TripCard({
  trip,
  onPress,
}: {
  trip: TripSummary;
  onPress: () => void;
}) {
  const translate = useTranslation();
  const statusColor = statusBadgeColor(trip.status);
  const tripMeta = translate(
    "{hasRegion, select, yes {{region} · } other {}}{dayCount, plural, one {# day} other {# days}}{hasMembers, select, yes { · {memberCount, plural, one {# rider} other {# riders}}} other {}}",
    {
      dayCount: trip.num_days,
      hasMembers: trip.member_count > 1 ? "yes" : "no",
      hasRegion: trip.region ? "yes" : "no",
      memberCount: trip.member_count,
      region: trip.region ?? "",
    },
  );
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={translate(
        "{title}, {count, plural, one {# day} other {# days}}, {status}",
        {
          title: trip.title,
          count: trip.num_days,
          status: formatStatus(trip.status),
        },
      )}
    >
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {trip.title}
        </Text>
        <Text style={styles.cardMeta} numberOfLines={1}>
          {tripMeta}
        </Text>
      </View>
      <View style={[styles.statusPill, { borderColor: statusColor }]}>
        <Text style={[styles.statusLabel, { color: statusColor }]}>
          {formatStatus(trip.status)}
        </Text>
      </View>
      <Icon name="chevron-right" size={22} color={t.faint} />
    </TouchableOpacity>
  );
}

// Status pill border + text. All clear AA on the white card: `ACCENT_DARK`
// is the burnt-orange "active" mark (the raw accent fails AA as text), the
// status tones cover completed/planned, and `dim` is the neutral fallback.
function statusBadgeColor(status: TripSummary["status"]): string {
  switch (status) {
    case "active":
      return ACCENT_DARK;
    case "completed":
      return statusFg.success;
    case "planned":
      return statusFg.warning;
    default:
      return t.dim;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  listContent: {
    padding: brandSpacing.s5,
    paddingBottom: brandSpacing.s12 * 2,
    flexGrow: 1,
  },
  separator: {
    height: brandSpacing.s3,
  },
  headerSeparator: {
    height: brandSpacing.s2,
  },
  folderHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingHorizontal: brandSpacing.s2,
    paddingTop: brandSpacing.s3,
    paddingBottom: brandSpacing.s1,
  },
  folderHeaderLabel: {
    flex: 1,
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  folderHeaderCount: {
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  centered: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  emptyTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "700",
    marginTop: brandSpacing.s3,
  },
  emptyBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    marginTop: brandSpacing.s3,
    paddingHorizontal: brandSpacing.s5,
    minHeight: 48,
    justifyContent: "center",
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  primaryBtnLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontWeight: "700",
    fontSize: 14,
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    marginTop: brandSpacing.s2,
    paddingHorizontal: brandSpacing.s5,
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },
  secondaryBtnLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontWeight: "700",
    fontSize: 14,
  },
  joinRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    marginBottom: brandSpacing.s3,
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
  },
  joinIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
  },
  joinBody: {
    flex: 1,
    gap: 2,
  },
  joinTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  joinSubtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
  },
  cardBody: {
    flex: 1,
    gap: 4,
  },
  cardTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  cardMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  statusPill: {
    paddingHorizontal: brandSpacing.s2,
    paddingVertical: 4,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
  },
  statusLabel: {
    fontFamily: brandFonts.sans,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  fab: {
    position: "absolute",
    bottom: brandSpacing.s5,
    right: brandSpacing.s5,
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingHorizontal: brandSpacing.s5,
    minHeight: 48,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    // The signature "Plan a trip" raised action — the screen's accent moment
    // (ink glyph/label on accent clears ~6.7:1).
    backgroundColor: t.accent,
  },
  fabLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  fabDisabled: {
    opacity: 0.5,
  },
});
