import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import {
  ACCENT,
  brandColorsDark,
  brandFonts,
  brandSpacing,
  QUALITY_COLORS,
} from "@/theme/brand";
import { useVehicleDisplayStore } from "@/stores/vehicleDisplay";
import type { LatLng } from "@/types";
import { MANEUVER_LABELS } from "@/services/navigation";

// Always-dark in-vehicle (CarPlay / Android Auto) nav card → night palette.
const t = brandColorsDark;

const CARD_WIDTH = 320;
const CARD_HEIGHT = 176;
const CARD_PADDING = 16;

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
              stroke={snapshot.offRoute ? QUALITY_COLORS[1] : ACCENT}
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
                fill={t.fg}
                stroke={t.bg}
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
    backgroundColor: t.bg,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  empty: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "600",
  },
  header: {
    gap: 2,
  },
  kicker: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  title: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 22,
    fontWeight: "800",
  },
  mapCard: {
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
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
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
  },
  overlayCard: {
    position: "absolute",
    left: brandSpacing.s3,
    bottom: brandSpacing.s3,
    right: brandSpacing.s3,
    borderRadius: 14,
    backgroundColor: "rgba(14, 14, 16, 0.92)",
    borderWidth: 1,
    borderColor: t.line,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
  },
  overlayDistance: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 28,
    fontWeight: "800",
  },
  overlayLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "600",
  },
  overlayRoad: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
  },
  offRouteBadge: {
    position: "absolute",
    top: brandSpacing.s3,
    left: brandSpacing.s3,
    borderRadius: 999,
    backgroundColor: QUALITY_COLORS[0],
    paddingHorizontal: brandSpacing.s2,
    paddingVertical: 6,
  },
  offRouteLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    fontWeight: "700",
  },
  banner: {
    position: "absolute",
    top: brandSpacing.s3,
    right: brandSpacing.s3,
    maxWidth: 220,
    borderRadius: 12,
    paddingHorizontal: brandSpacing.s2,
    paddingVertical: brandSpacing.s1,
  },
  bannerSuccess: {
    backgroundColor: QUALITY_COLORS[4],
  },
  bannerDanger: {
    backgroundColor: QUALITY_COLORS[0],
  },
  bannerLabel: {
    // Ink reads on both the bright Q5 green and Q1 red banner fills (the
    // bright ramp colours clear shape contrast on the dark card; ink clears
    // text contrast on the fills — a cream label would fail on the green).
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    fontWeight: "700",
  },
  statsRow: {
    flexDirection: "row",
    gap: brandSpacing.s2,
  },
  stat: {
    flex: 1,
    borderRadius: 14,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
  },
  statValue: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 14,
    fontWeight: "700",
  },
  statLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
});
