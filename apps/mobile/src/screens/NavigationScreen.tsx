/**
 * NavigationScreen — US-16 turn-by-turn voice navigation.
 *
 * Live navigation over a trip day's planned polyline. The heavy lifting
 * (maneuver extraction, tick processing, TTS) lives in services/hooks —
 * this screen is a thin rendering layer that:
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
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Icon from "@react-native-vector-icons/material-design-icons";
import {
  Camera,
  LineLayer,
  MapView,
  ShapeSource,
  UserLocation,
} from "@maplibre/maplibre-react-native";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  shadows,
  spacing,
} from "@/theme";
import { useKeepAwake } from "@/hooks";
import { useNavigationSession } from "@/hooks/useNavigationSession";
import { useTripStore } from "@/stores";
import type { LatLng, TripDay, Waypoint } from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";
import type { Maneuver, ManeuverType } from "@/services/navigation";
import { DEV_MAP_STYLE_URL } from "./MapScreen.helpers";

type NavRoute = RouteProp<TripsStackParamList, "Navigate">;
type Nav = NativeStackNavigationProp<TripsStackParamList, "Navigate">;
type IconName = ComponentProps<typeof Icon>["name"];

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

const MANEUVER_LABELS: Record<ManeuverType, string> = {
  depart: "Depart",
  arrive: "Arrive",
  continue: "Continue",
  "turn-slight-left": "Bear left",
  "turn-slight-right": "Bear right",
  "turn-left": "Turn left",
  "turn-right": "Turn right",
  "turn-sharp-left": "Sharp left",
  "turn-sharp-right": "Sharp right",
  uturn: "U-turn",
};

export default function NavigationScreen() {
  const { params } = useRoute<NavRoute>();
  const nav = useNavigation<Nav>();
  const trip = useTripStore((s) => s.activeTrip);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  useKeepAwake(true);

  const day = useMemo<TripDay | null>(() => {
    if (!trip || trip.id !== params.tripId) return null;
    return trip.days.find((d) => d.day_number === params.dayNumber) ?? null;
  }, [trip, params.tripId, params.dayNumber]);

  const polyline: LatLng[] = useMemo(
    () => day?.route_geometry ?? [],
    [day?.route_geometry],
  );
  // Pull road names off the waypoints when the vertex aligns with one —
  // the planner snaps waypoints onto polyline vertices, so an index-based
  // lookup is stable enough for spoken guidance. When no waypoint matches
  // we leave the slot undefined and let the phrase builder fall through.
  const roadNames = useMemo(
    () => buildRoadNameLookup(polyline, day?.waypoints ?? []),
    [polyline, day?.waypoints],
  );

  const { tick, maneuvers, liveLocation } = useNavigationSession({
    polyline,
    roadNames,
    voiceEnabled,
  });

  const routeShape = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: polyline.length
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

  const handleEnd = useCallback(() => {
    nav.goBack();
  }, [nav]);

  const handleToggleVoice = useCallback(() => {
    setVoiceEnabled((v) => !v);
  }, []);

  if (!day || polyline.length === 0) {
    return (
      <View style={styles.empty}>
        <Icon
          name="map-marker-off-outline"
          size={48}
          color={colors.textTertiary}
        />
        <Text style={styles.emptyTitle}>No route to navigate</Text>
        <Text style={styles.emptyBody}>
          Open this day from the trip detail and try again.
        </Text>
        <TouchableOpacity onPress={handleEnd} style={styles.endSecondary}>
          <Text style={styles.endSecondaryLabel}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const startCenter = polyline[0];
  const nextManeuver = tick?.nextManeuver ?? maneuvers[1] ?? maneuvers[0];
  const offRoute = tick?.offRoute ?? false;

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        mapStyle={DEV_MAP_STYLE_URL}
        attributionEnabled={false}
        logoEnabled={false}
      >
        <Camera
          defaultSettings={{
            centerCoordinate: [startCenter.lng, startCenter.lat],
            zoomLevel: 14,
          }}
          followUserLocation
          followZoomLevel={16}
        />
        <UserLocation visible animated />
        <ShapeSource id="nav-route" shape={routeShape}>
          <LineLayer
            id="nav-route-line"
            sourceID="nav-route"
            style={{
              lineColor: colors.primary,
              lineWidth: 6,
              lineCap: "round",
              lineJoin: "round",
              lineOpacity: offRoute ? 0.4 : 0.9,
            }}
          />
        </ShapeSource>
      </MapView>

      <View pointerEvents="box-none" style={styles.topOverlay}>
        {offRoute ? (
          <OffRouteBanner distanceM={tick?.offRouteDistanceM ?? 0} />
        ) : null}
        <NextManeuverCard
          maneuver={nextManeuver}
          distanceM={tick?.distanceToNextM ?? 0}
        />
      </View>

      <View pointerEvents="box-none" style={styles.bottomOverlay}>
        <View style={styles.statsRow}>
          <Stat label="Remaining" value={formatKm(tick?.remainingM ?? 0)} />
          <Stat
            label="Off-axis"
            value={formatMeters(tick?.offRouteDistanceM ?? 0)}
          />
          <Stat
            label="Maneuvers"
            value={`${Math.max(0, maneuvers.length - 2)}`}
          />
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
              color={voiceEnabled ? colors.textInverse : colors.textPrimary}
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.endBtn}
            onPress={handleEnd}
            accessibilityRole="button"
            accessibilityLabel="End navigation"
          >
            <Icon name="close" size={18} color={colors.textInverse} />
            <Text style={styles.endLabel}>End</Text>
          </TouchableOpacity>
        </View>
      </View>

      {!liveLocation ? (
        <View style={styles.searchingBadge} pointerEvents="none">
          <Icon name="crosshairs-gps" size={14} color={colors.textInverse} />
          <Text style={styles.searchingLabel}>Acquiring GPS…</Text>
        </View>
      ) : null}
    </View>
  );
}

function NextManeuverCard({
  maneuver,
  distanceM,
}: {
  maneuver: Maneuver;
  distanceM: number;
}) {
  const icon = MANEUVER_ICONS[maneuver.type] ?? "arrow-up";
  const label = MANEUVER_LABELS[maneuver.type] ?? "Continue";
  const distance =
    maneuver.type === "depart" ? "Depart" : formatManeuverDistance(distanceM);
  return (
    <View style={styles.maneuverCard}>
      <View style={styles.maneuverIconWrap}>
        <Icon name={icon} size={38} color={colors.primary} />
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
      <Icon name="alert-octagon" size={18} color={colors.textInverse} />
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

function formatKm(m: number): string {
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
    backgroundColor: colors.bg,
  },
  map: {
    flex: 1,
  },
  topOverlay: {
    position: "absolute",
    top: spacing.xl,
    left: spacing.lg,
    right: spacing.lg,
    gap: spacing.sm,
  },
  bottomOverlay: {
    position: "absolute",
    bottom: spacing.xl,
    left: spacing.lg,
    right: spacing.lg,
    gap: spacing.md,
  },
  maneuverCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  maneuverIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primaryAlpha15,
    alignItems: "center",
    justifyContent: "center",
  },
  maneuverBody: {
    flex: 1,
    gap: 2,
  },
  maneuverDistance: {
    color: colors.textPrimary,
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.black,
    lineHeight: 34,
  },
  maneuverLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  maneuverRoad: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  offRouteBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: colors.danger,
    ...shadows.card,
  },
  offRouteBody: {
    flex: 1,
  },
  offRouteTitle: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  offRouteBodyText: {
    color: colors.textInverse,
    fontSize: fontSize.xs,
    opacity: 0.9,
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  stat: {
    flex: 1,
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  statLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
    marginTop: 2,
  },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "center",
  },
  iconFab: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    ...shadows.card,
  },
  iconFabMuted: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  endBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.danger,
  },
  endLabel: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  searchingBadge: {
    position: "absolute",
    top: spacing.xl,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.textPrimary,
  },
  searchingLabel: {
    color: colors.textInverse,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
    backgroundColor: colors.bg,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
  },
  emptyBody: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: "center",
  },
  endSecondary: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  endSecondaryLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
});
