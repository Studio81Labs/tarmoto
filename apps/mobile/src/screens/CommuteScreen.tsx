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
import { Icon } from "@/components/Icon";
import {
  type CompositeNavigationProp,
  useNavigation,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { hazardIcons, qualityLabel } from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
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
import { t as translate, tDynamic } from "@/i18n";

type IconName = ComponentProps<typeof Icon>["name"];

type CommuteNav = CompositeNavigationProp<
  NativeStackNavigationProp<HomeStackParamList, "Commute">,
  BottomTabNavigationProp<RootTabParamList>
>;

const t = brandColorsLight;
// Low-severity hazards have no brand "info" tone (the palette is cream/ink +
// the three status colours), so they read as neutral ink rather than blue.
const SEVERITY_LOW_COLOR = t.dim;

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
        title: translate("Alternative · {value0} km", {
          value0: alt.distance_km.toFixed(1),
        }),
      });
    },
    [navigation],
  );

  // #361: gate the primary nav button on a resolved polyline (>= 2
  // points). The backend lazily populates `route_geometry` on first
  // read; while it's null (fresh route, routing-provider outage) we
  // disable the button instead of pushing a dead Navigate screen.
  // Computed once and shared with the callback + JSX so the tap-guard
  // and the disabled rendering can't drift out of sync.
  const primaryNavDisabled =
    !route?.route_geometry || route.route_geometry.length < 2;

  const navigatePrimary = useCallback(() => {
    if (primaryNavDisabled || !route?.route_geometry) return;
    navigation.navigate("Navigate", {
      source: "polyline",
      polyline: route.route_geometry,
      title: route.name,
    });
  }, [navigation, route, primaryNavDisabled]);

  // NEW hazard markers stay sticky until the rider explicitly taps
  // "Mark all seen" below. Avoid auto-acknowledging on unmount: the
  // `acknowledge` callback's identity changes on every refresh, which
  // would cause the cleanup to silently clear the pre-refresh diff.

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
        <Text style={styles.emptyTitle}>{translate("Can't load commute")}</Text>
        <Text style={styles.emptyBody}>
          {errorMessage ?? translate("Check your connection and try again.")}
        </Text>
        <TouchableOpacity style={styles.retryBtn} onPress={retry}>
          <Text style={styles.retryLabel}>{translate("Retry")}</Text>
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
          tintColor={t.fg}
        />
      }
    >
      <CommuteHeader status={status} newHazardCount={newHazardCount} />

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{route.name}</Text>
        <View style={styles.metricsRow}>
          <Metric
            label={translate("Distance")}
            value={
              route.distance_km != null
                ? `${route.distance_km.toFixed(1)} km`
                : "—"
            }
          />
          <Metric
            label={translate("Avg time")}
            value={
              route.avg_duration_min != null
                ? `${route.avg_duration_min} min`
                : "—"
            }
          />
          {/* Quality value stays ink: the ramp fails AA as text on the
              white card. The label is enough; the ramp lives on map/bar
              surfaces elsewhere. */}
          <Metric
            label={translate("Quality")}
            value={qualityLabel(status.route_quality)}
          />
        </View>
        <View style={styles.primaryCtaRow}>
          <TouchableOpacity
            style={styles.startCommuteBtn}
            onPress={startCommuteRide}
            accessibilityRole="button"
            accessibilityLabel={translate("Start commute ride to {value0}", {
              value0: route.name,
            })}
          >
            <Icon name="play-circle" size={20} color={t.invFg} />
            <Text style={styles.startCommuteLabel}>
              {translate("Start commute")}
            </Text>
          </TouchableOpacity>
          {/*
            #361: opt-in turn-by-turn nav for the primary route, mirroring
            the navigate button on alternative cards (#342). `primaryNavDisabled`
            (computed above) keeps the style, `disabled`, and icon-color
            branches in lockstep so the visual state can't lie about the tap.
          */}
          <TouchableOpacity
            style={[
              styles.primaryNavBtn,
              primaryNavDisabled ? styles.primaryNavBtnDisabled : null,
            ]}
            onPress={navigatePrimary}
            disabled={primaryNavDisabled}
            accessibilityRole="button"
            accessibilityLabel={translate(
              "Navigate primary commute route to {value0}",
              { value0: route.name },
            )}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Icon
              name="navigation-variant"
              size={20}
              color={primaryNavDisabled ? t.faint : t.fg}
            />
          </TouchableOpacity>
        </View>
      </View>

      {status.weather ? <WeatherCard weather={status.weather} /> : null}

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
          tintColor={t.fg}
        />
      }
    >
      <Icon name="map-marker-path" size={48} color={t.accent} />
      <Text style={styles.emptyTitle}>
        {translate("Learning your commute")}
      </Text>
      <Text style={styles.emptyBody}>
        {translate(
          "Take a few rides to the same destination and we'll start tracking road conditions and hazards for that route.",
        )}
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
      <Text style={styles.sectionTitle}>{translate("Weather")}</Text>
      <View style={styles.weatherRow}>
        <Icon name={weatherIcon(weather.condition)} size={32} color={t.fg} />
        <View style={styles.weatherText}>
          <Text style={styles.weatherTemp}>
            {Math.round(weather.temperature_c)}°C ·{" "}
            {tDynamic(capitalize(weather.condition))}
          </Text>
          <Text style={styles.weatherDetail}>{weather.description}</Text>
          <Text style={styles.weatherDetail}>
            {translate("Road: {condition} · Wind {speed} km/h", {
              condition: tDynamic(capitalize(weather.road_condition)),
              speed: Math.round(weather.wind_kmh),
            })}
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
        <Text style={styles.sectionTitle}>{translate("Hazards")}</Text>
        <View style={styles.clearRow}>
          <Icon name="check-circle" size={20} color={statusFg.success} />
          <Text style={styles.clearText}>
            {translate("No active hazards on your commute.")}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.hazardsHeader}>
        <Text style={styles.sectionTitle}>
          {translate("Hazards (")}
          {hazards.length})
        </Text>
        {newHazardCount > 0 ? (
          <TouchableOpacity
            onPress={onDismissNewBadges}
            accessibilityLabel={translate("Dismiss new hazard badges")}
          >
            <Text style={styles.dismissLabel}>
              {translate("Mark all seen")}
            </Text>
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
              <Text style={styles.newBadgeText}>{translate("NEW")}</Text>
            </View>
          ) : null}
        </View>
        {hazard.road_name ? (
          <Text style={styles.hazardMeta}>{hazard.road_name}</Text>
        ) : null}
        <Text style={styles.hazardMeta}>
          {hazard.confirmations > 0
            ? translate("{severity} · {time} · {count} confirmed", {
                severity: translate(
                  hazard.severity === "high"
                    ? "High"
                    : hazard.severity === "medium"
                      ? "Medium"
                      : "Low",
                ),
                time: formatRelativeTime(hazard.created_at),
                count: hazard.confirmations,
              })
            : translate("{severity} · {time}", {
                severity: translate(
                  hazard.severity === "high"
                    ? "High"
                    : hazard.severity === "medium"
                      ? "Medium"
                      : "Low",
                ),
                time: formatRelativeTime(hazard.created_at),
              })}
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
          accessibilityLabel={translate("Photo of {value0}", {
            value0: formatHazardType(hazard.hazard_type),
          })}
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
        <Text style={styles.sectionTitle}>
          {translate("Alternative routes")}
        </Text>
        <View style={styles.clearRow}>
          <Icon name="check" size={20} color={t.dim} />
          <Text style={styles.clearText}>
            {translate(
              "Your usual route looks like the best option right now.",
            )}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>
        {translate("Alternative routes ({count})", { count: ranked.length })}
      </Text>
      <Text style={styles.altSubtitle}>
        {alternatives.primary_hazard_count > 0
          ? translate(
              "Compared with your primary ({count, plural, one {# hazard} other {# hazards}}).",
              {
                count: alternatives.primary_hazard_count,
              },
            )
          : translate("Compared with your primary.")}
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
        accessibilityLabel={translate(
          "Start commute on alternative route, {distance} kilometres, {duration} minutes, {count, plural, one {# hazard} other {# hazards}}",
          {
            distance: alt.distance_km.toFixed(1),
            duration: alt.duration_min,
            count: alt.hazard_count,
          },
        )}
      >
        <View style={styles.altHeaderRow}>
          <Text style={styles.altTitle}>
            {translate("{distance} km · {duration} min", {
              distance: alt.distance_km.toFixed(1),
              duration: alt.duration_min,
            })}
          </Text>
          {alt.hazard_count === 0 ? (
            <View
              style={[styles.altPill, { backgroundColor: statusFg.success }]}
            >
              <Text style={styles.altPillText}>{translate("CLEAR")}</Text>
            </View>
          ) : (
            <View
              style={[styles.altPill, { backgroundColor: statusFg.warning }]}
            >
              <Text style={styles.altPillText}>
                {translate(
                  "{count, plural, one {# HAZARD} other {# HAZARDS}}",
                  { count: alt.hazard_count },
                )}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.altDeltasRow}>
          <DeltaChip
            label={translate("Δ km")}
            value={
              distanceDelta != null ? formatSignedDistance(distanceDelta) : "—"
            }
            negativeIsGood
            delta={distanceDelta ?? undefined}
          />
          <DeltaChip
            label={translate("Δ time")}
            value={
              durationDelta != null ? formatSignedDuration(durationDelta) : "—"
            }
            negativeIsGood
            delta={durationDelta ?? undefined}
          />
          {/* Quality value stays ink (ramp fails AA as text on the card). */}
          <DeltaChip
            label={translate("Quality")}
            value={qualityLabel(alt.avg_quality ?? 0)}
          />
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.altNavBtn, navDisabled && styles.altNavBtnDisabled]}
        onPress={() => onNavigate(alt)}
        disabled={navDisabled}
        accessibilityRole="button"
        accessibilityLabel={translate(
          "Navigate alternative route, {value0} kilometres",
          { value0: alt.distance_km.toFixed(1) },
        )}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Icon
          name="navigation-variant"
          size={20}
          color={navDisabled ? t.faint : t.fg}
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
        translate("Use this as primary?"),
        `Future commute checks will use ${route.name} as your primary route.`,
        [
          { text: translate("Cancel"), style: "cancel" },
          {
            text: translate("Use as primary"),
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
                  Alert.alert(translate("Couldn't update primary"), message);
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
      <Text style={styles.sectionTitle}>
        {translate("Saved routes (")}
        {others.length})
      </Text>
      <Text style={styles.altSubtitle}>
        {translate(
          "Switch which one is your primary — hazards and weekly stats follow.",
        )}
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
            accessibilityLabel={translate("Use {value0} as primary commute", {
              value0: r.name,
            })}
          >
            <View style={styles.savedMain}>
              <Text style={styles.altTitle}>{r.name}</Text>
              <Text style={styles.altSubtitle}>
                {r.distance_km != null && r.avg_quality != null
                  ? translate("{distance} km · Quality {quality}", {
                      distance: r.distance_km.toFixed(1),
                      quality: qualityLabel(r.avg_quality),
                    })
                  : r.distance_km != null
                    ? translate("{distance} km", {
                        distance: r.distance_km.toFixed(1),
                      })
                    : r.avg_quality != null
                      ? translate("Distance pending · Quality {quality}", {
                          quality: qualityLabel(r.avg_quality),
                        })
                      : translate("Distance pending")}
              </Text>
            </View>
            {isPending ? (
              <ActivityIndicator color={t.fg} size="small" />
            ) : (
              <Text style={styles.altSecondaryLabel}>
                {translate("Use as primary")}
              </Text>
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
  delta?: number | undefined;
}) {
  let color = valueColor ?? t.fg;
  if (delta !== undefined && negativeIsGood) {
    if (delta < 0) color = statusFg.success;
    else if (delta > 0) color = statusFg.warning;
    else color = t.fg;
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
        <Text style={styles.sectionTitle}>{translate("This week")}</Text>
        <Text style={styles.weeklySubtitle}>{translate("vs last week")}</Text>
      </View>
      <View style={styles.weeklyGrid}>
        <TrendCell
          label={translate("Rides")}
          value={String(stats.total_rides)}
          delta={stats.total_rides - prev.total_rides}
          positiveIsGood
          // Ride count is a whole number; without this the cell would
          // render "+1.0 rides", which reads like a duration/distance
          // value rather than a count.
          integer
        />
        <TrendCell
          label={translate("Distance")}
          value={`${stats.total_km.toFixed(1)} km`}
          delta={stats.total_km - prev.total_km}
          deltaText={trendPercent(stats.total_km, prev.total_km)}
          positiveIsGood
        />
        <TrendCell
          label={translate("Time")}
          value={`${stats.total_time_min} min`}
          delta={stats.total_time_min - prev.total_time_min}
          deltaText={trendPercent(stats.total_time_min, prev.total_time_min)}
          positiveIsGood={false}
        />
        <TrendCell
          label={translate("Fuel est.")}
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
  let color: string = t.dim;
  let icon: IconName = "minus";
  const epsilon = 0.05; // dampens the arrow on tiny rounding differences
  if (!neutral && Math.abs(delta) > epsilon) {
    icon = delta > 0 ? "arrow-up" : "arrow-down";
    if (positiveIsGood !== undefined) {
      const isGood = positiveIsGood ? delta > 0 : delta < 0;
      color = isGood ? statusFg.success : statusFg.warning;
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
      color: statusFg.danger,
      message: {
        title: translate("{value0} new {value1}", {
          value0: newHazardCount,
          value1: plural,
        }),
        body: translate("Check the list before you head out."),
      },
    };
  }
  switch (status.status) {
    case "clear":
      return {
        icon: "check-circle",
        color: statusFg.success,
        message: {
          title: translate("Route is clear"),
          body: translate("No new hazards since you last checked."),
        },
      };
    case "hazards":
      return {
        icon: "alert-circle",
        color: statusFg.warning,
        message: {
          title: translate("Active hazards"),
          body: translate("Known hazards on your route — none new."),
        },
      };
    case "weather_warning":
      return {
        icon: "weather-cloudy-alert",
        color: statusFg.warning,
        message: {
          title: translate("Weather warning"),
          body: translate("Ride conditions may be tough."),
        },
      };
    case "delays":
      return {
        icon: "clock-alert",
        color: statusFg.warning,
        message: {
          title: translate("Delays expected"),
          body: translate("Give yourself extra time."),
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
      return statusFg.danger;
    case "medium":
      return statusFg.warning;
    default:
      return SEVERITY_LOW_COLOR;
  }
}

// Light tint behind the severity icon — a low-alpha wash of the same status
// tone (neutral ink for low). Decorative grouping; the dark status icon on
// top carries the contrast.
function severityAlpha(severity: string): string {
  switch (severity) {
    case "high":
      return "rgba(179, 38, 30, 0.12)";
    case "medium":
      return "rgba(138, 83, 0, 0.12)";
    default:
      return "rgba(14, 14, 16, 0.06)";
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
  options: { integer?: boolean | undefined } = {},
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
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    paddingBottom: brandSpacing.s12,
  },
  centered: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  centeredContent: {
    flexGrow: 1,
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
  retryBtn: {
    marginTop: brandSpacing.s3,
    paddingHorizontal: brandSpacing.s5,
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  retryLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontWeight: "700",
    fontSize: 14,
  },
  statusBanner: {
    flexDirection: "row",
    alignItems: "center",
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    backgroundColor: t.raised,
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
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  statusBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    marginTop: 2,
  },
  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  sectionTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  metricsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: brandSpacing.s3,
  },
  metric: {
    flex: 1,
  },
  metricLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  metricValue: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 4,
  },
  primaryCtaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    marginTop: brandSpacing.s2,
  },
  startCommuteBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    backgroundColor: t.invBg,
    minHeight: 48,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
  },
  startCommuteLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontWeight: "700",
    fontSize: 14,
  },
  primaryNavBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
    borderWidth: 1,
    borderColor: t.line,
  },
  primaryNavBtnDisabled: {
    opacity: 0.4,
  },
  weatherRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
  },
  weatherText: {
    flex: 1,
    gap: 2,
  },
  weatherTemp: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  weatherDetail: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  hazardsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  dismissLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
    textDecorationLine: "underline",
  },
  clearRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  clearText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
  },
  hazardRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
    borderTopWidth: 1,
    borderTopColor: t.line,
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
    borderRadius: brandRadii.sm,
    backgroundColor: t.raised2,
  },
  hazardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  hazardTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  hazardMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  hazardNote: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    marginTop: 4,
    lineHeight: 20,
  },
  newBadge: {
    backgroundColor: statusFg.danger,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: brandRadii.sm,
  },
  newBadgeText: {
    color: "#FFFFFF",
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  altSubtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  altRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingVertical: brandSpacing.s2,
    borderTopWidth: 1,
    borderTopColor: t.line,
  },
  altMain: {
    flex: 1,
    gap: brandSpacing.s2,
  },
  altNavBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
    borderWidth: 1,
    borderColor: t.line,
  },
  altNavBtnDisabled: {
    opacity: 0.4,
  },
  altHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: brandSpacing.s2,
  },
  altTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  altPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: brandRadii.sm,
  },
  altPillText: {
    color: "#FFFFFF",
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  altDeltasRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
  },
  altDelta: {
    flex: 1,
  },
  altDeltaLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: "600",
  },
  altDeltaValue: {
    fontFamily: brandFonts.mono,
    fontSize: 13,
    fontWeight: "700",
    marginTop: 2,
  },
  altSecondaryLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
    textDecorationLine: "underline",
  },
  savedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
    borderTopWidth: 1,
    borderTopColor: t.line,
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
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  weeklyGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: brandSpacing.s3,
  },
  weeklyCell: {
    width: "47%",
    gap: 4,
  },
  weeklyValue: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 16,
    fontWeight: "700",
  },
  weeklyTrendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  weeklyDelta: {
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
});
