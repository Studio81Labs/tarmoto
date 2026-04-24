import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { colors, fontSize, fontWeight, spacing } from "@/theme";
import { useVehicleDisplayStore } from "@/stores/vehicleDisplay";
import type { LatLng } from "@/types";
import type { ManeuverType } from "@/services/navigation";

const CARD_WIDTH = 320;
const CARD_HEIGHT = 176;
const CARD_PADDING = 16;

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

interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasProjection {
  path: string;
  points: CanvasPoint[];
  marker: CanvasPoint | null;
}

export function projectRouteToCanvas(
  polyline: LatLng[],
  currentLocation: LatLng | null,
  width: number,
  height: number,
): CanvasProjection | null {
  if (polyline.length < 2) return null;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  const lats = polyline.map((p) => p.lat);
  const lngs = polyline.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const spanLat = Math.max(maxLat - minLat, 1e-6);
  const spanLng = Math.max(maxLng - minLng, 1e-6);
  const innerWidth = Math.max(width - CARD_PADDING * 2, 1);
  const innerHeight = Math.max(height - CARD_PADDING * 2, 1);
  const scale = Math.min(innerWidth / spanLng, innerHeight / spanLat);
  const offsetX = (width - spanLng * scale) / 2;
  const offsetY = (height - spanLat * scale) / 2;

  const project = (point: LatLng): CanvasPoint => ({
    x: offsetX + (point.lng - minLng) * scale,
    y: height - (offsetY + (point.lat - minLat) * scale),
  });

  const points = polyline.map(project);
  const path = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    )
    .join(" ");

  return {
    path,
    points,
    marker: currentLocation ? project(currentLocation) : null,
  };
}

function formatDistanceMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "0 m";
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatSpeed(speedKmh: number): string {
  if (!Number.isFinite(speedKmh) || speedKmh < 1) return "—";
  return `${Math.round(speedKmh)} km/h`;
}

function formatRideDistance(distanceKm: number): string {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return "0.0 km";
  return `${distanceKm.toFixed(1)} km`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function VehicleDisplaySurface() {
  const snapshot = useVehicleDisplayStore((state) => state.snapshot);
  const projection = useMemo(
    () =>
      snapshot
        ? projectRouteToCanvas(
            snapshot.polyline,
            snapshot.currentLocation,
            CARD_WIDTH,
            CARD_HEIGHT,
          )
        : null,
    [snapshot],
  );

  if (!snapshot) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Waiting for navigation…</Text>
      </View>
    );
  }

  const nextTurnLabel = snapshot.nextManeuver
    ? (MANEUVER_LABELS[snapshot.nextManeuver.type] ?? "Continue")
    : "Continue";

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.kicker}>Tarmoto</Text>
        <Text style={styles.title} numberOfLines={1}>
          {snapshot.title}
        </Text>
      </View>

      <View style={styles.mapCard}>
        {projection ? (
          <Svg width={CARD_WIDTH} height={CARD_HEIGHT}>
            <Path
              d={projection.path}
              stroke={snapshot.offRoute ? colors.warning : colors.primary}
              strokeWidth={8}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            {projection.marker ? (
              <Circle
                cx={projection.marker.x}
                cy={projection.marker.y}
                r={7}
                fill={colors.white}
                stroke={colors.bg}
                strokeWidth={3}
              />
            ) : null}
          </Svg>
        ) : (
          <View style={styles.routeFallback}>
            <Text style={styles.routeFallbackText}>
              Route preview unavailable
            </Text>
          </View>
        )}

        <View style={styles.overlayCard}>
          <Text style={styles.overlayDistance}>
            {formatDistanceMeters(snapshot.distanceToNextM)}
          </Text>
          <Text style={styles.overlayLabel}>{nextTurnLabel}</Text>
          {snapshot.nextManeuver?.roadName ? (
            <Text style={styles.overlayRoad} numberOfLines={1}>
              onto {snapshot.nextManeuver.roadName}
            </Text>
          ) : null}
        </View>

        {snapshot.banner ? (
          <View
            style={[
              styles.banner,
              snapshot.banner.tone === "success"
                ? styles.bannerSuccess
                : styles.bannerDanger,
            ]}
          >
            <Text style={styles.bannerLabel}>{snapshot.banner.message}</Text>
          </View>
        ) : null}

        {snapshot.offRoute ? (
          <View style={styles.offRouteBadge}>
            <Text style={styles.offRouteLabel}>
              Off route · {formatDistanceMeters(snapshot.offRouteDistanceM)}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.statsRow}>
        <Stat label="Speed" value={formatSpeed(snapshot.rideStats.speedKmh)} />
        <Stat
          label="Ride"
          value={formatRideDistance(snapshot.rideStats.distanceKm)}
        />
        <Stat
          label="Time"
          value={formatDuration(snapshot.rideStats.durationSeconds)}
        />
        <Stat
          label="Remain"
          value={formatDistanceMeters(snapshot.remainingM)}
        />
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  empty: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
  },
  header: {
    gap: 2,
  },
  kicker: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
  },
  mapCard: {
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
  },
  routeFallback: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  routeFallbackText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
  },
  overlayCard: {
    position: "absolute",
    left: spacing.md,
    bottom: spacing.md,
    right: spacing.md,
    borderRadius: 14,
    backgroundColor: "rgba(7, 10, 16, 0.92)",
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  overlayDistance: {
    color: colors.white,
    fontSize: 28,
    fontWeight: fontWeight.black,
  },
  overlayLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  overlayRoad: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  offRouteBadge: {
    position: "absolute",
    top: spacing.md,
    left: spacing.md,
    borderRadius: 999,
    backgroundColor: colors.danger,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  offRouteLabel: {
    color: colors.white,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  banner: {
    position: "absolute",
    top: spacing.md,
    right: spacing.md,
    maxWidth: 220,
    borderRadius: 12,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  bannerSuccess: {
    backgroundColor: colors.success,
  },
  bannerDanger: {
    backgroundColor: colors.danger,
  },
  bannerLabel: {
    color: colors.white,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  stat: {
    flex: 1,
    borderRadius: 14,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  statLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
});
