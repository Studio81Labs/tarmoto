/**
 * NavigationScreen — US-16 turn-by-turn voice navigation.
 *
 * Live navigation over a planned polyline. The heavy lifting (maneuver
 * extraction, tick processing, TTS) lives in services/hooks — this
 * screen is a thin rendering layer that:
 *
 *   - Renders the planned route on a MapLibre base map with the live
 *     location puck.
 *
 *   - Shows the next maneuver as a big top card (arrow icon + distance +
 *     target road name), which is what the rider glances at.
 *
 *   - Shows remaining distance + a voice toggle + an End button on the
 *     bottom. The voice toggle mutes TTS without ending the session.
 *
 *   - Flags off-route state with a full-width banner — the banner sits
 *     above the next-turn card so the rider can't miss it while the
 *     state machine suppresses maneuver announcements.
 *
 * The route input is polymorphic: trip-day callers pass `{ tripId,
 * dayNumber }` and the screen resolves polyline / waypoints / title from
 * `useTripStore`; commute (and any future ad-hoc routing) callers pass
 * `{ polyline, title?, waypoints? }` directly. See `NavigateParams` in
 * `RootNavigator` for the full shape.
 *
 * We keep the screen awake while it's mounted (rider stares at it). The
 * screen is designed for portrait motorcycle handlebar mounts; a
 * landscape variant is a follow-up.
 */
import React, {
  type ComponentProps,
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Icon } from "@/components/Icon";
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  UserLocation,
} from "@maplibre/maplibre-react-native";
import {
  ACCENT,
  brandColorsDark,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { useKeepAwake, useRouteWeatherAlerts } from "@/hooks";
import { useNavigationSession } from "@/hooks/useNavigationSession";
import { useVehicleNavigationDisplay } from "@/hooks/useVehicleNavigationDisplay";
import { usePreferencesStore, useTripStore } from "@/stores";
import { WeatherAlertBanner } from "@/components/WeatherAlertBanner";
import type { LatLng, Waypoint } from "@/types";
import type {
  HomeStackParamList,
  TripsStackParamList,
} from "@/navigation/RootNavigator";
import {
  MANEUVER_LABELS,
  type Maneuver,
  type ManeuverType,
} from "@/services/navigation";
import { APP_MAP_STYLE_URL } from "./MapScreen.helpers";
import { resolveNavigationRoute } from "./NavigationScreen.helpers";
import { navigationWaypointsForRoadNames } from "./TripScreens.helpers";

// `Navigate` is registered on both TripsStack (the planned-trip flow)
// and HomeStack (commute), with identical params. Either RouteProp is a
// valid annotation; the union keeps the screen agnostic to which stack
// pushed it.
type NavRoute = RouteProp<TripsStackParamList | HomeStackParamList, "Navigate">;
type Nav = NativeStackNavigationProp<
  TripsStackParamList | HomeStackParamList,
  "Navigate"
>;
type IconName = ComponentProps<typeof Icon>["name"];

// Immersive HUD over a live map → the brand night palette. Dark cards with
// cream text, the accent for the planned route + active controls.
const t = brandColorsDark;

const MANEUVER_ICONS: Record<ManeuverType, IconName> = {
  depart: "navigation-variant",
  arrive: "flag-checkered",
  continue: "arrow-up",
  "turn-slight-left": "arrow-top-left",
  "turn-slight-right": "arrow-top-right",
  "turn-left": "arrow-left-top",
  "turn-right": "arrow-right-top",
  "turn-sharp-left": "arrow-left",
  "turn-sharp-right": "arrow-right",
  uturn: "backup-restore",
};

export default function NavigationScreen() {
  const { params } = useRoute<NavRoute>();
  const nav = useNavigation<Nav>();
  // This full-screen route hides the tab bar, which previously reserved the
  // bottom inset; pad the bottom controls so they clear the home indicator.
  const insets = useSafeAreaInsets();
  // The voice FAB defaults from the rider's persisted Voice Navigation
  // preference (Settings → Voice navigation). Toggling the FAB is a
  // session-scoped override — it doesn't write back to Settings, so a
  // rider who silences a single trip still sees voice on next time.
  const voiceNavEnabled = usePreferencesStore((s) => s.voiceNavEnabled);
  const voiceNavVolume = usePreferencesStore((s) => s.voiceNavVolume);
  const voiceNavLanguage = usePreferencesStore((s) => s.voiceNavLanguage);
  const voiceNavVerbose = usePreferencesStore((s) => s.voiceNavVerbose);
  const distanceUnit = usePreferencesStore((s) => s.distanceUnit);
  const [voiceEnabled, setVoiceEnabled] = useState(voiceNavEnabled);
  const [weatherDetailOpen, setWeatherDetailOpen] = useState(false);
  const weatherAlertsEnabled = usePreferencesStore(
    (s) => s.weatherAlertsEnabled,
  );
  useKeepAwake(true);

  // Trip-day callers carry only the IDs and rely on `useTripStore` for
  // the geometry; the polyline branch carries the route inline. Reading
  // the store unconditionally keeps the hook order stable and is cheap
  // (a single Zustand selector) — the selector returns null for the
  // polyline branch so React doesn't re-render on unrelated trip edits.
  const activeTrip = useTripStore((s) =>
    params.source === "trip-day" ? s.activeTrip : null,
  );
  const route = useMemo(
    () => resolveNavigationRoute(params, activeTrip),
    [params, activeTrip],
  );
  const polyline = route.polyline;

  // Pull road names off the waypoints when the vertex aligns with one —
  // the planner snaps waypoints onto polyline vertices, so an index-based
  // lookup is stable enough for spoken guidance. When no waypoint matches
  // we leave the slot undefined and let the phrase builder fall through.
  // Client-only suggested overnight stays are excluded because they are
  // not route-snapped planner waypoints and would skew maneuver naming.
  const roadNames = useMemo(
    () =>
      buildRoadNameLookup(
        polyline,
        navigationWaypointsForRoadNames(route.waypoints),
      ),
    [polyline, route.waypoints],
  );

  const { tick, maneuvers, liveLocation } = useNavigationSession({
    polyline,
    roadNames,
    voiceEnabled,
    // Skip GPS hardware activation when the polyline is unusable — the
    // screen renders the empty-state below and the rider isn't navigating
    // anything, so there's nothing to project live location onto.
    trackLocation: polyline.length >= 2,
    language: voiceNavLanguage,
    unit: distanceUnit,
    verbose: voiceNavVerbose,
    volume: voiceNavVolume,
  });

  // US-13: surface real-time weather alerts ahead. The hook handles
  // polling, dedupe, and TTS throttling; the screen just renders the
  // banner above the maneuver card.
  const { alerts: weatherAlerts } = useRouteWeatherAlerts({
    polyline,
    progressM: tick?.progressM ?? null,
    enabled: weatherAlertsEnabled && polyline.length >= 2,
  });

  const routeShape = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      // A LineString with a single coordinate is invalid GeoJSON and the
      // rest of the flow (TripDayScreen's Start-Navigation guard, the
      // NavSession projection) already considers < 2 points unusable.
      // Drop any stray single-point polyline so the layer stays empty.
      features:
        polyline.length >= 2
          ? [
              {
                type: "Feature",
                properties: {},
                geometry: {
                  type: "LineString",
                  coordinates: polyline.map((p) => [p.lng, p.lat]),
                },
              },
            ]
          : [],
    }),
    [polyline],
  );

  const vehicleNextManeuver =
    tick?.nextManeuver ??
    (tick !== null
      ? (maneuvers[maneuvers.length - 1] ?? null)
      : (maneuvers[1] ?? maneuvers[0] ?? null));

  useVehicleNavigationDisplay({
    title: route.title,
    polyline,
    tick,
    liveLocation,
    nextManeuver: vehicleNextManeuver,
  });

  const handleEnd = useCallback(() => {
    nav.goBack();
  }, [nav]);

  const handleToggleVoice = useCallback(() => {
    setVoiceEnabled((v) => !v);
  }, []);

  const noRouteView = (
    <View style={styles.empty}>
      <StatusBar barStyle="light-content" backgroundColor={t.bg} translucent />
      <Icon name="map-marker-off-outline" size={48} color={t.mute} />
      <Text style={styles.emptyTitle}>No route to navigate</Text>
      <Text style={styles.emptyBody}>
        {params.source === "trip-day"
          ? "Open this day from the trip detail and try again."
          : "We couldn't load this route's geometry. Go back and try again."}
      </Text>
      <TouchableOpacity onPress={handleEnd} style={styles.endSecondary}>
        <Text style={styles.endSecondaryLabel}>Back</Text>
      </TouchableOpacity>
    </View>
  );

  if (polyline.length < 2) {
    return noRouteView;
  }

  const startCenter = polyline[0];
  // Three states for the next-turn card:
  //   1. We have a live tick with a next maneuver → show it.
  //   2. We have a tick but no next maneuver → the rider has arrived
  //      (or overshot the last maneuver), so show "Arrive" instead of
  //      stale "Turn right" copy from the start of the route.
  //   3. No tick yet (pre-GPS-fix) → preview the first real turn.
  const nextManeuver: Maneuver | undefined =
    vehicleNextManeuver ?? maneuvers[0];
  if (!startCenter || !nextManeuver) {
    return noRouteView;
  }
  const offRoute = tick?.offRoute ?? false;
  // Live count of interior maneuvers still ahead of the rider. Falls back
  // to the total interior count before the first GPS fix lands so the
  // stat row stays populated; once `tick` arrives, it tracks progress
  // tick-by-tick alongside Remaining and Off-axis.
  const remainingManeuvers = tick
    ? maneuvers.filter(
        (m) =>
          m.type !== "depart" &&
          m.type !== "arrive" &&
          m.distanceFromStartM > tick.progressM,
      ).length
    : Math.max(0, maneuvers.length - 2);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={t.bg} translucent />
      <Map
        style={styles.map}
        mapStyle={APP_MAP_STYLE_URL}
        attribution={false}
        logo={false}
      >
        <Camera
          initialViewState={{
            center: [startCenter.lng, startCenter.lat],
            zoom: 14,
          }}
          trackUserLocation="course"
          zoom={16}
        />
        <UserLocation animated />
        <GeoJSONSource id="nav-route" data={routeShape}>
          <Layer
            type="line"
            id="nav-route-line"
            source="nav-route"
            paint={{
              "line-color": ACCENT,
              "line-width": 6,
              "line-opacity": offRoute ? 0.4 : 0.9,
            }}
            layout={{
              "line-cap": "round",
              "line-join": "round",
            }}
          />
        </GeoJSONSource>
      </Map>

      <View pointerEvents="box-none" style={styles.topOverlay}>
        {offRoute ? (
          <OffRouteBanner distanceM={tick?.offRouteDistanceM ?? 0} />
        ) : null}
        <WeatherAlertBanner
          alerts={weatherAlerts}
          detailOpen={weatherDetailOpen}
          onOpenDetail={() => setWeatherDetailOpen(true)}
          onCloseDetail={() => setWeatherDetailOpen(false)}
        />
        <NextManeuverCard
          maneuver={nextManeuver}
          distanceM={tick?.distanceToNextM ?? 0}
          hasFix={tick !== null}
        />
      </View>

      <View
        pointerEvents="box-none"
        style={[
          styles.bottomOverlay,
          { bottom: brandSpacing.s5 + insets.bottom },
        ]}
      >
        <View style={styles.statsRow}>
          <Stat
            label="Remaining"
            value={formatDistanceM(tick?.remainingM ?? 0)}
          />
          <Stat
            label="Off-axis"
            value={formatMeters(tick?.offRouteDistanceM ?? 0)}
          />
          <Stat label="Maneuvers" value={`${remainingManeuvers}`} />
        </View>
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={[styles.iconFab, !voiceEnabled && styles.iconFabMuted]}
            onPress={handleToggleVoice}
            accessibilityRole="button"
            accessibilityState={{ selected: voiceEnabled }}
            accessibilityLabel={
              voiceEnabled ? "Mute voice guidance" : "Enable voice guidance"
            }
          >
            <Icon
              name={voiceEnabled ? "volume-high" : "volume-off"}
              size={22}
              color={voiceEnabled ? t.invFg : t.fg}
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.endBtn}
            onPress={handleEnd}
            accessibilityRole="button"
            accessibilityLabel="End navigation"
          >
            <Icon name="close" size={18} color={t.fg} />
            <Text style={styles.endLabel}>End</Text>
          </TouchableOpacity>
        </View>
      </View>

      {!liveLocation ? (
        <View style={styles.searchingBadge} pointerEvents="none">
          <Icon name="crosshairs-gps" size={14} color={t.fg} />
          <Text style={styles.searchingLabel}>Acquiring GPS…</Text>
        </View>
      ) : null}
    </View>
  );
}

function NextManeuverCard({
  maneuver,
  distanceM,
  hasFix,
}: {
  maneuver: Maneuver;
  distanceM: number;
  /**
   * Whether the rider has a live GPS fix yet. Until the first tick lands
   * `distanceM` is defaulted to 0, which would otherwise render as "Now"
   * — a dangerous misread on a motorcycle (it implies the turn is
   * imminent when GPS hasn't even locked). Before the first fix we show
   * a neutral placeholder instead.
   */
  hasFix: boolean;
}) {
  const icon = MANEUVER_ICONS[maneuver.type] ?? "arrow-up";
  const label = MANEUVER_LABELS[maneuver.type] ?? "Continue";
  const distance = !hasFix
    ? "—"
    : maneuver.type === "depart"
      ? "Depart"
      : formatManeuverDistance(distanceM);
  return (
    <View style={styles.maneuverCard}>
      <View style={styles.maneuverIconWrap}>
        <Icon name={icon} size={38} color={ACCENT} />
      </View>
      <View style={styles.maneuverBody}>
        <Text style={styles.maneuverDistance}>{distance}</Text>
        <Text style={styles.maneuverLabel} numberOfLines={1}>
          {label}
        </Text>
        {maneuver.roadName ? (
          <Text style={styles.maneuverRoad} numberOfLines={1}>
            onto {maneuver.roadName}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function OffRouteBanner({ distanceM }: { distanceM: number }) {
  return (
    <View style={styles.offRouteBanner} accessibilityLiveRegion="polite">
      <Icon name="alert-octagon" size={18} color={t.fg} />
      <View style={styles.offRouteBody}>
        <Text style={styles.offRouteTitle}>Off route</Text>
        <Text style={styles.offRouteBodyText}>
          {formatMeters(distanceM)} from the planned path — return when it's
          safe.
        </Text>
      </View>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/**
 * Build a vertex-indexed road-name lookup. We attribute each waypoint's
 * `name` to its sequence position in the polyline — the planner emits
 * waypoints in order and snaps them onto polyline vertices, so a best-
 * effort uniform spacing is good enough for TTS phrasing. Returns an
 * array the same length as `polyline` with gaps where no name is known.
 */
function buildRoadNameLookup(
  polyline: LatLng[],
  waypoints: Waypoint[],
): Array<string | undefined> {
  const names: Array<string | undefined> = new Array(polyline.length).fill(
    undefined,
  );
  if (polyline.length === 0 || waypoints.length === 0) return names;
  // Waypoints come from the planner ordered by `sequence`; distribute them
  // evenly across the polyline index range so the first waypoint lands at
  // vertex 0 and the last at the final vertex. Real road names per segment
  // will replace this once the backend routing response includes them.
  const sorted = [...waypoints].sort((a, b) => a.sequence - b.sequence);
  sorted.forEach((wp, i) => {
    if (!wp.name) return;
    const pos =
      sorted.length === 1
        ? 0
        : Math.round((i * (polyline.length - 1)) / (sorted.length - 1));
    names[pos] = wp.name;
  });
  return names;
}

function formatManeuverDistance(m: number): string {
  if (m <= 15) return "Now";
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/**
 * Format a distance in METERS for the stats panel, switching to km with
 * one decimal above 1 km. Deliberately named distinct from
 * `formatKm` in `TripScreens.helpers.ts` (which takes kilometres) so a
 * future refactor can't silently introduce a 1000× unit drift.
 */
function formatDistanceM(m: number): string {
  if (m <= 0) return "0 km";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function formatMeters(m: number): string {
  if (m < 1) return "0 m";
  return `${Math.round(m)} m`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  map: {
    flex: 1,
  },
  topOverlay: {
    position: "absolute",
    top: brandSpacing.s5,
    left: brandSpacing.s4,
    right: brandSpacing.s4,
    gap: brandSpacing.s2,
  },
  bottomOverlay: {
    position: "absolute",
    bottom: brandSpacing.s5,
    left: brandSpacing.s4,
    right: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  maneuverCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    paddingHorizontal: brandSpacing.s4,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.lg,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  maneuverIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: t.raised2,
    alignItems: "center",
    justifyContent: "center",
  },
  maneuverBody: {
    flex: 1,
    gap: 2,
  },
  maneuverDistance: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 28,
    fontWeight: "800",
    lineHeight: 34,
  },
  maneuverLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  maneuverRoad: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  offRouteBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingHorizontal: brandSpacing.s4,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.md,
    backgroundColor: statusFg.danger,
  },
  offRouteBody: {
    flex: 1,
  },
  offRouteTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  offRouteBodyText: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    opacity: 0.9,
  },
  statsRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
    padding: brandSpacing.s3,
    borderRadius: brandRadii.md,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  stat: {
    flex: 1,
  },
  statValue: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 16,
    fontWeight: "700",
  },
  statLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
    marginTop: 2,
  },
  actionsRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
    alignItems: "center",
  },
  iconFab: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ACCENT,
  },
  iconFabMuted: {
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  endBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 48,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: statusFg.danger,
  },
  endLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  searchingBadge: {
    position: "absolute",
    top: brandSpacing.s5,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s1,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  searchingLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
    backgroundColor: t.bg,
  },
  emptyTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "700",
  },
  emptyBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    textAlign: "center",
  },
  endSecondary: {
    paddingHorizontal: brandSpacing.s5,
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },
  endSecondaryLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
});
