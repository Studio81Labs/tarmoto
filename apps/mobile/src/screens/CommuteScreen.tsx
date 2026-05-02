/**
 * CommuteScreen — US-15 / US-21 / US-22 / US-23 commute surface.
 *
 * Three visual states:
 *   - `loading` while the first fetch is in flight
 *   - `learning` when no primary commute has been detected yet (the
 *     backend needs at least 3 rides per the user story)
 *   - `ready` with the commute summary, weather line, hazard list,
 *     alternative routes, and weekly summary
 *
 * Push notifications for new hazards are a separate workstream (see
 * Issue #17 acceptance criteria). This screen delivers the in-app half
 * of that feature — the diff itself — which the future notification
 * layer can reuse via the same `useCommute()` hook.
 */

import React, { ComponentProps, useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import {
  type CompositeNavigationProp,
  useNavigation,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  hazardIcons,
  qualityColor,
  qualityLabel,
  spacing,
} from "@/theme";
import { useCommute, type CommuteHazardView } from "@/hooks/useCommute";
import type {
  CommuteAlternativeRoute,
  CommuteAlternativesResponse,
  CommuteRoute,
  CommuteStats,
  CommuteStatus,
  Weather,
} from "@/types";
import type {
  HomeStackParamList,
  RootTabParamList,
} from "@/navigation/RootNavigator";
import {
  formatHazardType,
  formatRelativeTime,
} from "./RoadPreviewScreen.helpers";
import { capitalize } from "./TripScreens.helpers";

type IconName = ComponentProps<typeof Icon>["name"];

type CommuteNav = CompositeNavigationProp<
  NativeStackNavigationProp<HomeStackParamList, "Commute">,
  BottomTabNavigationProp<RootTabParamList>
>;

export default function CommuteScreen() {
  const {
    phase,
    route,
    savedRoutes,
    status,
    hazards,
    newHazardCount,
    alternatives,
    stats,
    errorMessage,
    refresh,
    retry,
    acknowledge,
    setPrimary,
    isRefreshing,
    isUpdatingPrimary,
  } = useCommute();
  const navigation = useNavigation<CommuteNav>();

  const startCommuteRide = useCallback((): void => {
    // Cross-tab nav into the live ride HUD. RideActiveScreen owns the
    // `/rides/start` POST and telemetry pipeline; this screen just
    // chooses the ride_type marker.
    navigation.navigate("RideTab", {
      screen: "RideActive",
      params: { rideType: "commute" },
    });
  }, [navigation]);

  const navigateAlternative = useCallback(
    (alt: CommuteAlternativeRoute) => {
      // #342: launch turn-by-turn nav over the alternative's polyline.
      // We register `Navigate` on the Home stack precisely so the rider
      // stays on this tab when they end the session — no cross-tab hop
      // and no trip-day shim. The screen itself is polyline-aware now.
      if (alt.geometry.length < 2) return;
      navigation.navigate("Navigate", {
        source: "polyline",
        polyline: alt.geometry,
        title: `Alternative · ${alt.distance_km.toFixed(1)} km`,
      });
    },
    [navigation],
  );

  // NEW hazard markers stay sticky until the rider explicitly taps
  // "Mark all seen" below. Avoid auto-acknowledging on unmount: the
  // `acknowledge` callback's identity changes on every refresh, which
  // would cause the cleanup to silently clear the pre-refresh diff.

  if (phase === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (phase === "error") {
    return (
      <View style={styles.centered}>
        <Icon name="wifi-off" size={40} color={colors.textTertiary} />
        <Text style={styles.emptyTitle}>Can't load commute</Text>
        <Text style={styles.emptyBody}>
          {errorMessage ?? "Check your connection and try again."}
        </Text>
        <TouchableOpacity style={styles.retryBtn} onPress={retry}>
          <Text style={styles.retryLabel}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === "learning" || !route || !status) {
    return <LearningState onRefresh={refresh} refreshing={isRefreshing} />;
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={refresh}
          tintColor={colors.primary}
        />
      }
    >
      <CommuteHeader status={status} newHazardCount={newHazardCount} />

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{route.name}</Text>
        <View style={styles.metricsRow}>
          <Metric
            label="Distance"
            value={
              route.distance_km != null
                ? `${route.distance_km.toFixed(1)} km`
                : "—"
            }
          />
          <Metric
            label="Avg time"
            value={
              route.avg_duration_min != null
                ? `${route.avg_duration_min} min`
                : "—"
            }
          />
          <Metric
            label="Quality"
            value={qualityLabel(status.route_quality)}
            valueColor={qualityColor(status.route_quality)}
          />
        </View>
        <TouchableOpacity
          style={styles.startCommuteBtn}
          onPress={startCommuteRide}
          accessibilityRole="button"
          accessibilityLabel={`Start commute ride to ${route.name}`}
        >
          <Icon name="play-circle" size={20} color={colors.textInverse} />
          <Text style={styles.startCommuteLabel}>Start commute</Text>
        </TouchableOpacity>
      </View>

      <WeatherCard weather={status.weather} />

      <HazardsCard
        hazards={hazards}
        newHazardCount={newHazardCount}
        onDismissNewBadges={acknowledge}
      />

      {alternatives ? (
        <AlternativesCard
          alternatives={alternatives}
          primaryDistanceKm={route.distance_km}
          primaryDurationMin={route.avg_duration_min}
          onStart={startCommuteRide}
          onNavigate={navigateAlternative}
        />
      ) : null}

      {savedRoutes.length > 1 ? (
        <SavedRoutesCard
          routes={savedRoutes}
          primaryRouteId={route.id}
          isUpdatingPrimary={isUpdatingPrimary}
          onSetPrimary={setPrimary}
        />
      ) : null}

      {stats ? <WeeklySummaryCard stats={stats} /> : null}
    </ScrollView>
  );
}

// ── Sub-components ──

function LearningState({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.centeredContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
    >
      <Icon name="map-marker-path" size={48} color={colors.primary} />
      <Text style={styles.emptyTitle}>Learning your commute</Text>
      <Text style={styles.emptyBody}>
        Take a few rides to the same destination and we'll start tracking road
        conditions and hazards for that route.
      </Text>
    </ScrollView>
  );
}

function CommuteHeader({
  status,
  newHazardCount,
}: {
  status: CommuteStatus;
  newHazardCount: number;
}) {
  const { icon, color, message } = describeStatus(status, newHazardCount);
  return (
    <View style={[styles.statusBanner, { borderColor: color }]}>
      <View style={[styles.statusIconWrap, { backgroundColor: color + "22" }]}>
        <Icon name={icon} size={22} color={color} />
      </View>
      <View style={styles.statusTextWrap}>
        <Text style={[styles.statusTitle, { color }]}>{message.title}</Text>
        <Text style={styles.statusBody}>{message.body}</Text>
      </View>
    </View>
  );
}

function Metric({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text
        style={[styles.metricValue, valueColor ? { color: valueColor } : null]}
      >
        {value}
      </Text>
    </View>
  );
}

function WeatherCard({ weather }: { weather: Weather }) {
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Weather</Text>
      <View style={styles.weatherRow}>
        <Icon
          name={weatherIcon(weather.condition)}
          size={32}
          color={colors.primary}
        />
        <View style={styles.weatherText}>
          <Text style={styles.weatherTemp}>
            {Math.round(weather.temperature_c)}°C ·{" "}
            {capitalize(weather.condition)}
          </Text>
          <Text style={styles.weatherDetail}>{weather.description}</Text>
          <Text style={styles.weatherDetail}>
            Road: {capitalize(weather.road_condition)} · Wind{" "}
            {Math.round(weather.wind_kmh)} km/h
          </Text>
        </View>
      </View>
    </View>
  );
}

function HazardsCard({
  hazards,
  newHazardCount,
  onDismissNewBadges,
}: {
  hazards: CommuteHazardView[];
  newHazardCount: number;
  onDismissNewBadges: () => void;
}) {
  if (hazards.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Hazards</Text>
        <View style={styles.clearRow}>
          <Icon name="check-circle" size={20} color={colors.success} />
          <Text style={styles.clearText}>
            No active hazards on your commute.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.hazardsHeader}>
        <Text style={styles.sectionTitle}>Hazards ({hazards.length})</Text>
        {newHazardCount > 0 ? (
          <TouchableOpacity
            onPress={onDismissNewBadges}
            accessibilityLabel="Dismiss new hazard badges"
          >
            <Text style={styles.dismissLabel}>Mark all seen</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {hazards.map((h) => (
        <HazardRow key={h.id} hazard={h} />
      ))}
    </View>
  );
}

function HazardRow({ hazard }: { hazard: CommuteHazardView }) {
  return (
    <View style={styles.hazardRow}>
      <View
        style={[
          styles.hazardIconWrap,
          { backgroundColor: severityAlpha(hazard.severity) },
        ]}
      >
        <Icon
          name={(hazardIcons[hazard.hazard_type] as IconName) ?? "alert-circle"}
          size={22}
          color={severityColor(hazard.severity)}
        />
      </View>
      <View style={styles.hazardBody}>
        <View style={styles.hazardTitleRow}>
          <Text style={styles.hazardTitle}>
            {formatHazardType(hazard.hazard_type)}
          </Text>
          {hazard.isNew ? (
            <View style={styles.newBadge}>
              <Text style={styles.newBadgeText}>NEW</Text>
            </View>
          ) : null}
        </View>
        {hazard.road_name ? (
          <Text style={styles.hazardMeta}>{hazard.road_name}</Text>
        ) : null}
        <Text style={styles.hazardMeta}>
          {capitalize(hazard.severity)} ·{" "}
          {formatRelativeTime(hazard.created_at)}
          {hazard.confirmations > 0
            ? ` · ${hazard.confirmations} confirmed`
            : ""}
        </Text>
        {hazard.note ? (
          <Text style={styles.hazardNote}>{hazard.note}</Text>
        ) : null}
      </View>
      {hazard.photo_url ? (
        // Thumbnail surfaces the rider-attached photo directly in the
        // hazard list (US-4 photo upload). Tap-to-zoom is a nice-to-
        // have follow-up; today the thumbnail alone gives the next
        // rider a real-world view of the obstacle which matters for
        // gravel / oil_spill / flooding where severity is hard to
        // judge from text + icon alone.
        <Image
          source={{ uri: hazard.photo_url }}
          style={styles.hazardPhoto}
          accessibilityLabel={`Photo of ${formatHazardType(hazard.hazard_type)}`}
        />
      ) : null}
    </View>
  );
}

// US-22: alternative routes the rider can pick when the primary has
// hazards / closures / weather. The list is ranked client-side using a
// simple score (hazards weighted heaviest, then duration delta vs the
// primary, then quality) — this matches what the rider intuitively
// scans for on the cards. These come from the routing engine on each
// request and don't have a stable `id`, so they're tap-to-start only;
// promoting one to "primary" requires a saved route, which lives in
// `SavedRoutesCard` below.
function AlternativesCard({
  alternatives,
  primaryDistanceKm,
  primaryDurationMin,
  onStart,
  onNavigate,
}: {
  alternatives: CommuteAlternativesResponse;
  // Backend now caches `distance_km` and `avg_duration_min` on
  // `CommuteRouteResponseDto`, but both stay null until the routing
  // provider resolves the route (and on a provider outage). Guard the
  // delta chips against null so they render "—" instead of "NaN km"/"NaN min".
  primaryDistanceKm: number | null;
  primaryDurationMin: number | null;
  onStart: () => void;
  onNavigate: (alt: CommuteAlternativeRoute) => void;
}) {
  const ranked = rankAlternatives(alternatives.alternatives);

  if (ranked.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Alternative routes</Text>
        <View style={styles.clearRow}>
          <Icon name="check" size={20} color={colors.textSecondary} />
          <Text style={styles.clearText}>
            Your usual route looks like the best option right now.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>
        Alternative routes ({ranked.length})
      </Text>
      <Text style={styles.altSubtitle}>
        Compared with your primary
        {alternatives.primary_hazard_count > 0
          ? ` (${alternatives.primary_hazard_count} hazard${alternatives.primary_hazard_count === 1 ? "" : "s"})`
          : ""}
        .
      </Text>
      {ranked.map((alt, idx) => (
        <AlternativeRow
          key={`${alt.distance_km}-${idx}`}
          alt={alt}
          primaryDistanceKm={primaryDistanceKm}
          primaryDurationMin={primaryDurationMin}
          onStart={onStart}
          onNavigate={onNavigate}
        />
      ))}
    </View>
  );
}

function AlternativeRow({
  alt,
  primaryDistanceKm,
  primaryDurationMin,
  onStart,
  onNavigate,
}: {
  alt: CommuteAlternativeRoute;
  primaryDistanceKm: number | null;
  primaryDurationMin: number | null;
  onStart: () => void;
  onNavigate: (alt: CommuteAlternativeRoute) => void;
}) {
  // Backend treats both cache fields as nullable (unresolved or routing
  // provider outage), so guard against null/NaN before subtracting.
  const distanceDelta =
    typeof primaryDistanceKm === "number" && Number.isFinite(primaryDistanceKm)
      ? alt.distance_km - primaryDistanceKm
      : null;
  const durationDelta =
    typeof primaryDurationMin === "number" &&
    Number.isFinite(primaryDurationMin)
      ? alt.duration_min - primaryDurationMin
      : null;
  // Nav button is disabled when geometry is empty so we don't push a
  // dead Navigate screen. Backend currently always returns geometry on
  // alternatives, but defensive — same shape we already enforce on the
  // trip-day Start Navigation button.
  const navDisabled = alt.geometry.length < 2;
  return (
    <View style={styles.altRow}>
      <TouchableOpacity
        style={styles.altMain}
        onPress={onStart}
        accessibilityRole="button"
        accessibilityLabel={
          `Start commute on alternative route, ${alt.distance_km.toFixed(1)} ` +
          `kilometres, ${alt.duration_min} minutes, ${alt.hazard_count} ` +
          `hazard${alt.hazard_count === 1 ? "" : "s"}`
        }
      >
        <View style={styles.altHeaderRow}>
          <Text style={styles.altTitle}>
            {alt.distance_km.toFixed(1)} km · {alt.duration_min} min
          </Text>
          {alt.hazard_count === 0 ? (
            <View style={[styles.altPill, { backgroundColor: colors.success }]}>
              <Text style={styles.altPillText}>CLEAR</Text>
            </View>
          ) : (
            <View style={[styles.altPill, { backgroundColor: colors.warning }]}>
              <Text style={styles.altPillText}>
                {alt.hazard_count} HAZARD{alt.hazard_count === 1 ? "" : "S"}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.altDeltasRow}>
          <DeltaChip
            label="Δ km"
            value={
              distanceDelta != null ? formatSignedDistance(distanceDelta) : "—"
            }
            negativeIsGood
            delta={distanceDelta ?? undefined}
          />
          <DeltaChip
            label="Δ time"
            value={
              durationDelta != null ? formatSignedDuration(durationDelta) : "—"
            }
            negativeIsGood
            delta={durationDelta ?? undefined}
          />
          <DeltaChip
            label="Quality"
            value={qualityLabel(alt.avg_quality ?? 0)}
            valueColor={qualityColor(alt.avg_quality ?? 0)}
          />
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.altNavBtn, navDisabled && styles.altNavBtnDisabled]}
        onPress={() => onNavigate(alt)}
        disabled={navDisabled}
        accessibilityRole="button"
        accessibilityLabel={`Navigate alternative route, ${alt.distance_km.toFixed(1)} kilometres`}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Icon
          name="navigation-variant"
          size={20}
          color={navDisabled ? colors.textTertiary : colors.primary}
        />
      </TouchableOpacity>
    </View>
  );
}

// Saved (non-primary) routes the rider has stashed earlier — picking
// one promotes it to primary via the atomic swap endpoint, which then
// drives every other surface on this screen (status, alternatives,
// stats) on the next refresh.
//
// We deliberately do NOT expose a "start ride on this row" affordance
// here: `RideActive` only takes `{ rideType: 'commute' }` and uses
// whichever route the backend treats as primary, so a "Start" tap
// would silently launch the *current* primary instead of the row the
// rider tapped — confusing both sighted and screen-reader users. The
// promote step is required first, then the rider taps the primary
// CTA above to start the ride.
function SavedRoutesCard({
  routes,
  primaryRouteId,
  isUpdatingPrimary,
  onSetPrimary,
}: {
  routes: CommuteRoute[];
  primaryRouteId: string;
  isUpdatingPrimary: boolean;
  onSetPrimary: (routeId: string) => Promise<void>;
}) {
  const others = routes.filter((r) => r.id !== primaryRouteId);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const handlePromote = useCallback(
    (route: CommuteRoute) => {
      Alert.alert(
        "Use this as primary?",
        `Future commute checks will use ${route.name} as your primary route.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Use as primary",
            onPress: () => {
              setPendingId(route.id);
              // Attach a `.catch()` ahead of `.finally()` so a failed
              // swap (network blip, 404 if the route was deleted on
              // another device, 5xx) can't surface as an unhandled
              // promise rejection — that warns in dev and on some RN
              // Hermes builds will crash the app. We also tell the
              // rider what happened: silently swallowing the error
              // would leave them tapping the same row forever.
              onSetPrimary(route.id)
                .catch((err: unknown) => {
                  const message =
                    err instanceof Error
                      ? err.message
                      : "Couldn't switch your primary commute. Try again.";
                  Alert.alert("Couldn't update primary", message);
                })
                .finally(() => setPendingId(null));
            },
          },
        ],
      );
    },
    [onSetPrimary],
  );

  if (others.length === 0) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Saved routes ({others.length})</Text>
      <Text style={styles.altSubtitle}>
        Switch which one is your primary — hazards and weekly stats follow.
      </Text>
      {others.map((r) => {
        const isPending = isUpdatingPrimary && pendingId === r.id;
        return (
          <TouchableOpacity
            key={r.id}
            style={styles.savedRow}
            onPress={() => handlePromote(r)}
            disabled={isPending}
            accessibilityRole="button"
            accessibilityLabel={`Use ${r.name} as primary commute`}
          >
            <View style={styles.savedMain}>
              <Text style={styles.altTitle}>{r.name}</Text>
              <Text style={styles.altSubtitle}>
                {r.distance_km != null
                  ? `${r.distance_km.toFixed(1)} km`
                  : "Distance pending"}
                {r.avg_quality != null
                  ? ` · Quality ${qualityLabel(r.avg_quality)}`
                  : ""}
              </Text>
            </View>
            {isPending ? (
              <ActivityIndicator color={colors.primary} size="small" />
            ) : (
              <Text style={styles.altSecondaryLabel}>Use as primary</Text>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function DeltaChip({
  label,
  value,
  valueColor,
  negativeIsGood,
  delta,
}: {
  label: string;
  value: string;
  valueColor?: string;
  /** When true (distance/time deltas), negative deltas render as success. */
  negativeIsGood?: boolean;
  delta?: number;
}) {
  let color = valueColor ?? colors.textPrimary;
  if (delta !== undefined && negativeIsGood) {
    if (delta < 0) color = colors.success;
    else if (delta > 0) color = colors.warning;
    else color = colors.textPrimary;
  }
  return (
    <View style={styles.altDelta}>
      <Text style={styles.altDeltaLabel}>{label}</Text>
      <Text style={[styles.altDeltaValue, { color }]}>{value}</Text>
    </View>
  );
}

// US-23: small trend section under the commute view. We surface the four
// totals the spec explicitly calls out — distance, time, fuel, ride
// count — and a per-metric arrow + percentage vs the prior week. The
// arrow is colour-coded only for distance / time / rides (more is good
// for distance/rides, less is good for time); fuel is intentionally
// neutral since it's an estimate, not a goal.
function WeeklySummaryCard({ stats }: { stats: CommuteStats }) {
  const { previous_period: prev } = stats;
  return (
    <View style={styles.card}>
      <View style={styles.weeklyHeader}>
        <Text style={styles.sectionTitle}>This week</Text>
        <Text style={styles.weeklySubtitle}>vs last week</Text>
      </View>
      <View style={styles.weeklyGrid}>
        <TrendCell
          label="Rides"
          value={String(stats.total_rides)}
          delta={stats.total_rides - prev.total_rides}
          positiveIsGood
          // Ride count is a whole number; without this the cell would
          // render "+1.0 rides", which reads like a duration/distance
          // value rather than a count.
          integer
        />
        <TrendCell
          label="Distance"
          value={`${stats.total_km.toFixed(1)} km`}
          delta={stats.total_km - prev.total_km}
          deltaText={trendPercent(stats.total_km, prev.total_km)}
          positiveIsGood
        />
        <TrendCell
          label="Time"
          value={`${stats.total_time_min} min`}
          delta={stats.total_time_min - prev.total_time_min}
          deltaText={trendPercent(stats.total_time_min, prev.total_time_min)}
          positiveIsGood={false}
        />
        <TrendCell
          label="Fuel est."
          value={`${stats.fuel_estimate_l.toFixed(1)} L`}
          delta={stats.fuel_estimate_l - prev.fuel_estimate_l}
          deltaText={trendPercent(stats.fuel_estimate_l, prev.fuel_estimate_l)}
          neutral
        />
      </View>
    </View>
  );
}

function TrendCell({
  label,
  value,
  delta,
  deltaText,
  positiveIsGood,
  neutral,
  integer,
}: {
  label: string;
  value: string;
  delta: number;
  /** Optional override (e.g. percentage). Defaults to formatted absolute delta. */
  deltaText?: string;
  positiveIsGood?: boolean;
  neutral?: boolean;
  /** When true, the default delta label drops the decimal place (rides). */
  integer?: boolean;
}) {
  let color: string = colors.textTertiary;
  let icon: IconName = "minus";
  const epsilon = 0.05; // dampens the arrow on tiny rounding differences
  if (!neutral && Math.abs(delta) > epsilon) {
    icon = delta > 0 ? "arrow-up" : "arrow-down";
    if (positiveIsGood !== undefined) {
      const isGood = positiveIsGood ? delta > 0 : delta < 0;
      color = isGood ? colors.success : colors.warning;
    }
  }
  return (
    <View style={styles.weeklyCell}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.weeklyValue}>{value}</Text>
      <View style={styles.weeklyTrendRow}>
        <Icon name={icon} size={14} color={color} />
        <Text style={[styles.weeklyDelta, { color }]}>
          {deltaText ?? formatAbsDelta(delta, { integer })}
        </Text>
      </View>
    </View>
  );
}

// ── Pure helpers (kept inline; small + screen-specific) ──

function describeStatus(
  status: CommuteStatus,
  newHazardCount: number,
): { icon: IconName; color: string; message: { title: string; body: string } } {
  if (newHazardCount > 0) {
    const plural = newHazardCount === 1 ? "hazard" : "hazards";
    return {
      icon: "alert",
      color: colors.danger,
      message: {
        title: `${newHazardCount} new ${plural}`,
        body: "Check the list before you head out.",
      },
    };
  }
  switch (status.status) {
    case "clear":
      return {
        icon: "check-circle",
        color: colors.success,
        message: {
          title: "Route is clear",
          body: "No new hazards since you last checked.",
        },
      };
    case "hazards":
      return {
        icon: "alert-circle",
        color: colors.warning,
        message: {
          title: "Active hazards",
          body: "Known hazards on your route — none new.",
        },
      };
    case "weather_warning":
      return {
        icon: "weather-cloudy-alert",
        color: colors.warning,
        message: {
          title: "Weather warning",
          body: "Ride conditions may be tough.",
        },
      };
    case "delays":
      return {
        icon: "clock-alert",
        color: colors.warning,
        message: {
          title: "Delays expected",
          body: "Give yourself extra time.",
        },
      };
  }
}

function weatherIcon(condition: Weather["condition"]): IconName {
  switch (condition) {
    case "clear":
      return "weather-sunny";
    case "cloudy":
      return "weather-cloudy";
    case "rain":
      return "weather-rainy";
    case "storm":
      return "weather-lightning-rainy";
    case "snow":
      return "weather-snowy";
    case "fog":
      return "weather-fog";
    case "ice":
      return "snowflake-alert";
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case "high":
      return colors.danger;
    case "medium":
      return colors.warning;
    default:
      return colors.info;
  }
}

function severityAlpha(severity: string): string {
  switch (severity) {
    case "high":
      return "rgba(239, 68, 68, 0.15)";
    case "medium":
      return "rgba(234, 179, 8, 0.15)";
    default:
      return "rgba(59, 130, 246, 0.15)";
  }
}

/**
 * Rank alternatives so the rider's eye lands on the best candidate first.
 *
 * Score order: fewer hazards > shorter duration > higher quality. Each
 * tier dominates the next so a 0-hazard route always ranks above one
 * with hazards even if it's 10 minutes longer (the rider's whole
 * reason for using alternates is hazard avoidance).
 */
function rankAlternatives(
  alts: CommuteAlternativeRoute[],
): CommuteAlternativeRoute[] {
  return [...alts].sort((a, b) => {
    if (a.hazard_count !== b.hazard_count) {
      return a.hazard_count - b.hazard_count;
    }
    if (a.duration_min !== b.duration_min) {
      return a.duration_min - b.duration_min;
    }
    const aQ = a.avg_quality ?? -1;
    const bQ = b.avg_quality ?? -1;
    return bQ - aQ;
  });
}

function formatSignedDistance(km: number): string {
  if (Math.abs(km) < 0.05) return "±0 km";
  return `${km > 0 ? "+" : ""}${km.toFixed(1)} km`;
}

function formatSignedDuration(min: number): string {
  if (min === 0) return "±0 min";
  return `${min > 0 ? "+" : ""}${min} min`;
}

function formatAbsDelta(
  delta: number,
  options: { integer?: boolean } = {},
): string {
  if (Math.abs(delta) < 0.05) return "±0";
  if (options.integer) {
    const rounded = Math.round(delta);
    return rounded > 0 ? `+${rounded}` : String(rounded);
  }
  return delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
}

function trendPercent(current: number, previous: number): string {
  if (previous === 0) {
    if (current === 0) return "±0%";
    // No prior baseline to divide against — just signal direction.
    return current > 0 ? "+new" : "—";
  }
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) return "±0%";
  return pct > 0 ? `+${Math.round(pct)}%` : `${Math.round(pct)}%`;
}

// Re-exported so the spec can assert against the formatter without
// importing the screen component.
export const __test = {
  rankAlternatives,
  trendPercent,
  formatSignedDistance,
  formatSignedDuration,
};

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  centered: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  centeredContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.md,
  },
  emptyBody: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: "center",
    lineHeight: 22,
  },
  retryBtn: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  retryLabel: {
    color: colors.textInverse,
    fontWeight: fontWeight.bold,
    fontSize: fontSize.md,
  },
  statusBanner: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.lg,
    gap: spacing.md,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    backgroundColor: colors.bgCard,
  },
  statusIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  statusTextWrap: {
    flex: 1,
  },
  statusTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  statusBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  metricsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  metric: {
    flex: 1,
  },
  metricLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  metricValue: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    marginTop: 4,
  },
  startCommuteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    marginTop: spacing.sm,
  },
  startCommuteLabel: {
    color: colors.textInverse,
    fontWeight: fontWeight.bold,
    fontSize: fontSize.md,
  },
  weatherRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  weatherText: {
    flex: 1,
    gap: 2,
  },
  weatherTemp: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  weatherDetail: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  hazardsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  dismissLabel: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  clearRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  clearText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
  },
  hazardRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  hazardIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  hazardBody: {
    flex: 1,
    gap: 2,
  },
  hazardPhoto: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.border,
  },
  hazardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  hazardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  hazardMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  hazardNote: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 4,
    lineHeight: 20,
  },
  newBadge: {
    backgroundColor: colors.danger,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  newBadgeText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.5,
  },
  altSubtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  altRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  altMain: {
    flex: 1,
    gap: spacing.sm,
  },
  altNavBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  altNavBtnDisabled: {
    opacity: 0.4,
  },
  altHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  altTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  altPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  altPillText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.5,
  },
  altDeltasRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  altDelta: {
    flex: 1,
  },
  altDeltaLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: fontWeight.semibold,
  },
  altDeltaValue: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    marginTop: 2,
  },
  altSecondaryLabel: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  savedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  savedMain: {
    flex: 1,
    gap: 2,
  },
  weeklyHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  weeklySubtitle: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  weeklyGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
  },
  weeklyCell: {
    width: "47%",
    gap: 4,
  },
  weeklyValue: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  weeklyTrendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  weeklyDelta: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
});
