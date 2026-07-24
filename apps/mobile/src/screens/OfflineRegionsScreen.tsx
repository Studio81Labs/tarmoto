/**
 * OfflineRegionsScreen — US-18 AC #1 "Download map regions for offline use".
 *
 * Lists every region the rider has asked to cache, shows per-region
 * progress, and exposes the add/retry/delete actions. The heavy lifting
 * (tile math, filesystem writes, cancellation) lives in
 * `hooks/useOfflineRegions.ts` — this screen is a thin render layer plus
 * the "save current viewport" entry point.
 *
 * The "save current area" button pulls the rider's last map viewport
 * from `useMapStore`. That keeps the flow one-tap (no modal to draw
 * a region) and mirrors what other mobile apps do for this feature —
 * the trip planner on web (US-43) is where riders draw arbitrary
 * polygons.
 *
 * Brand: migrated onto the cream + ink brand system (Phase 3) so the
 * Settings → Offline maps flow stays consistent. Each status carries an
 * AA-safe text/icon colour and a separate progress-fill colour. See
 * docs/design/mobile-spec/README.md.
 */

import React, { type ComponentProps, useCallback, useMemo } from "react";
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Icon } from "@/components/Icon";
import { bboxAroundPoint, type OfflineRegion } from "@/services/offlineRegions";

type IconName = ComponentProps<typeof Icon>["name"];
import { regionProgress, useMapStore } from "@/stores";
import { useOfflineRegions } from "@/hooks";
import {
  ACCENT_DARK,
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import type { EnglishMessageKey } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFormat } from "@/format/FormatProvider";
import type { Formatters } from "@tarmoto/shared";

const t = brandColorsLight;
const INK = "#0E0E10";

// Zoom range cached per region. z=8 is country-level, z=14 is "individual
// road" on the quality overlay — that window matches what the map renders
// for a rider browsing at the default zoom (12). Going higher would blow
// past MAX_TILES_PER_REGION for any sensibly-sized bbox.
const DEFAULT_MIN_ZOOM = 8;
const DEFAULT_MAX_ZOOM = 14;
// Radius (km) of the bbox built around the current map centre when the
// rider taps "save current area". Roughly a day-ride's worth of context.
const DEFAULT_SAVE_RADIUS_KM = 25;

const STATUS_LABELS: Record<OfflineRegion["status"], EnglishMessageKey> = {
  pending: "Waiting…",
  downloading: "Downloading…",
  complete: "Ready offline",
  failed: "Failed",
  cancelled: "Paused",
};

const STATUS_ICONS: Record<OfflineRegion["status"], IconName> = {
  pending: "clock-outline",
  downloading: "cloud-download-outline",
  complete: "cloud-check-outline",
  failed: "cloud-alert-outline",
  cancelled: "pause-circle-outline",
};

// AA-safe (>=4.5:1 on the white card) colour for the status label + icon.
const STATUS_TEXT: Record<OfflineRegion["status"], string> = {
  pending: t.dim,
  downloading: t.fg,
  complete: statusFg.success,
  failed: statusFg.danger,
  cancelled: statusFg.warning,
};

// Progress-bar fill (graphical, >=3:1 against the `sunken` track). The
// deepened accent marks the one active download — the raw accent only reaches
// ~2.1:1 on the cream track, so `ACCENT_DARK` carries the same "active" read
// while clearing the non-text contrast floor. Terminal states reuse their
// (already AA-safe) status colour.
const STATUS_FILL: Record<OfflineRegion["status"], string> = {
  pending: t.faint,
  downloading: ACCENT_DARK,
  complete: statusFg.success,
  failed: statusFg.danger,
  cancelled: statusFg.warning,
};

export default function OfflineRegionsScreen() {
  const localize = useTranslation();
  const format = useFormat();
  const center = useMapStore((s) => s.center);
  const { regions, saveRegion, retryRegion, cancelDownload, deleteRegion } =
    useOfflineRegions();

  const sortedRegions = useMemo(
    // Show newest at the top — a fresh download is what the rider is
    // most likely checking on.
    () => [...regions].sort((a, b) => b.createdAt - a.createdAt),
    [regions],
  );

  const onSaveCurrent = useCallback(async () => {
    const bbox = bboxAroundPoint(center, DEFAULT_SAVE_RADIUS_KM);
    const name = defaultRegionName(center.lat, center.lng, localize, format);
    const outcome = await saveRegion(
      name,
      bbox,
      DEFAULT_MIN_ZOOM,
      DEFAULT_MAX_ZOOM,
    );
    if (!outcome.ok) {
      const message =
        outcome.reason === "too-many-tiles"
          ? localize(
              "This area would need {count, plural, one {# tile} other {# tiles}}, which is over the offline cache limit. Zoom in before saving.",
              { count: outcome.tileCount },
            )
          : outcome.reason === "busy"
            ? localize(
                "Another region is still downloading. Wait for it to finish (or pause it) before saving a new one.",
              )
            : localize(
                "The map bounds looked invalid. Move the map and try again.",
              );
      Alert.alert(localize("Couldn't save this area"), message);
    }
  }, [center, format, localize, saveRegion]);

  const onRetry = useCallback(
    (regionId: string) => {
      void retryRegion(regionId);
    },
    [retryRegion],
  );

  const onCancel = useCallback(
    (regionId: string) => {
      cancelDownload(regionId);
    },
    [cancelDownload],
  );

  const onDelete = useCallback(
    (region: OfflineRegion) => {
      Alert.alert(
        localize("Delete offline region"),
        localize(
          '"{value0}" will be removed from your device. You can re-save it later.',
          { value0: region.name },
        ),
        [
          { text: localize("Cancel"), style: "cancel" },
          {
            text: localize("Delete"),
            style: "destructive",
            onPress: () => {
              void deleteRegion(region.id);
            },
          },
        ],
      );
    },
    [deleteRegion, localize],
  );

  return (
    <View style={styles.container}>
      <FlatList
        contentContainerStyle={styles.content}
        data={sortedRegions}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={
          <View style={styles.headerCard}>
            <Text style={styles.sectionTitle}>
              {localize("Offline map regions")}
            </Text>
            <Text style={styles.sectionBody}>
              {localize(
                "Save an area to your device so the road-quality overlay keeps working when you lose cell service. Tiles live in the app's storage — delete a region anytime to reclaim space.",
              )}
            </Text>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={onSaveCurrent}
              accessibilityRole="button"
              accessibilityLabel={localize(
                "Save current map area for offline use",
              )}
            >
              <Icon name="map-marker-plus-outline" size={20} color={INK} />
              <Text style={styles.primaryBtnLabel}>
                {localize("Save current area ({distance})", {
                  distance: format.distanceKm(DEFAULT_SAVE_RADIUS_KM),
                })}
              </Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => (
          <RegionRow
            region={item}
            onRetry={onRetry}
            onCancel={onCancel}
            onDelete={onDelete}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <Icon name="cloud-off-outline" size={28} color={t.dim} />
            <Text style={styles.emptyTitle}>
              {localize("No offline regions yet")}
            </Text>
            <Text style={styles.emptyBody}>
              {localize(
                'Pan the map to the area you want to cache and tap "Save current area" above.',
              )}
            </Text>
          </View>
        }
      />
    </View>
  );
}

interface RegionRowProps {
  region: OfflineRegion;
  onRetry: (regionId: string) => void;
  onCancel: (regionId: string) => void;
  onDelete: (region: OfflineRegion) => void;
}

// Memoised so tile-tick updates to the active region don't force every
// other row in the FlatList to re-render. `onRetry`/`onCancel`/`onDelete`
// are `useCallback`-stable in the parent, so identity-based equality is
// enough — no custom comparator needed.
const RegionRow = React.memo(RegionRowImpl);

function RegionRowImpl({
  region,
  onRetry,
  onCancel,
  onDelete,
}: RegionRowProps) {
  const localize = useTranslation();
  const format = useFormat();
  const statusLabel = localize(STATUS_LABELS[region.status]);
  const statusIcon = STATUS_ICONS[region.status];
  const statusTextColor = STATUS_TEXT[region.status];
  const statusFillColor = STATUS_FILL[region.status];

  const progressPct = Math.round(regionProgress(region) * 100);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.statusIcon}>
          <Icon name={statusIcon} size={20} color={statusTextColor} />
        </View>
        <View style={styles.cardTitleBlock}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {region.name}
          </Text>
          <Text style={[styles.cardStatus, { color: statusTextColor }]}>
            {statusLabel}
          </Text>
        </View>
      </View>

      <Text style={styles.cardDetails}>
        {localize("{tiles} tiles · zoom {minZoom}–{maxZoom} · {size}", {
          tiles: region.totalTiles,
          minZoom: region.minZoom,
          maxZoom: region.maxZoom,
          size: formatBytes(region.bytesOnDisk, format),
        })}
      </Text>

      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            {
              width: `${progressPct}%`,
              backgroundColor: statusFillColor,
            },
          ]}
        />
      </View>
      <Text style={styles.progressText}>
        {region.failedTiles > 0
          ? localize("{downloaded} / {total} downloaded · {failed} failed", {
              downloaded: region.downloadedTiles,
              total: region.totalTiles,
              failed: region.failedTiles,
            })
          : localize("{downloaded} / {total} downloaded", {
              downloaded: region.downloadedTiles,
              total: region.totalTiles,
            })}
      </Text>

      {region.lastError ? (
        <Text style={styles.errorText} numberOfLines={2}>
          {region.lastError}
        </Text>
      ) : null}

      <View style={styles.actionsRow}>
        {region.status === "downloading" ? (
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => onCancel(region.id)}
            accessibilityRole="button"
            accessibilityLabel={localize("Pause download of {value0}", {
              value0: region.name,
            })}
          >
            <Icon name="pause" size={18} color={t.fg} />
            <Text style={styles.secondaryBtnLabel}>{localize("Pause")}</Text>
          </TouchableOpacity>
        ) : null}

        {region.status === "failed" || region.status === "cancelled" ? (
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => onRetry(region.id)}
            accessibilityRole="button"
            accessibilityLabel={localize("Retry download of {value0}", {
              value0: region.name,
            })}
          >
            <Icon name="refresh" size={18} color={t.fg} />
            <Text style={styles.secondaryBtnLabel}>{localize("Retry")}</Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={[styles.secondaryBtn, styles.dangerBtn]}
          onPress={() => onDelete(region)}
          accessibilityRole="button"
          accessibilityLabel={localize("Delete {value0}", {
            value0: region.name,
          })}
        >
          <Icon name="trash-can-outline" size={18} color={statusFg.danger} />
          <Text style={[styles.secondaryBtnLabel, { color: statusFg.danger }]}>
            {localize("Delete")}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function defaultRegionName(
  lat: number,
  lng: number,
  localize: ReturnType<typeof useTranslation>,
  format: Formatters,
): string {
  return localize("Area near {lat}, {lng}", {
    lat: format.decimal(lat, 2),
    lng: format.decimal(lng, 2),
  });
}

/**
 * Human-readable byte size. 1024-base (KiB/MiB) matches what riders see
 * in iOS/Android storage settings. Zero renders as "—" so empty regions
 * don't scream "0 B" at the rider.
 */
function formatBytes(bytes: number, format: Formatters): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${format.decimal(mb, 1)} MB`;
  const kb = bytes / 1024;
  return `${format.integer(kb)} KB`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    paddingBottom: brandSpacing.s8,
  },
  headerCard: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.lg,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  sectionTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  sectionBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    lineHeight: 20,
  },
  primaryBtn: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    gap: brandSpacing.s2,
    paddingHorizontal: brandSpacing.s4,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.accent,
  },
  primaryBtnLabel: {
    color: INK,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "800",
  },
  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.lg,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s2,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
  },
  statusIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: t.sunken,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitleBlock: {
    flex: 1,
    gap: 2,
  },
  cardTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 15,
    fontWeight: "700",
  },
  cardStatus: {
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
  },
  cardDetails: {
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 12,
  },
  progressTrack: {
    height: 6,
    backgroundColor: t.sunken,
    borderRadius: brandRadii.pill,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: brandRadii.pill,
  },
  progressText: {
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 11,
  },
  errorText: {
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  actionsRow: {
    flexDirection: "row",
    gap: brandSpacing.s2,
    marginTop: brandSpacing.s1,
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised2,
    borderWidth: 1,
    borderColor: t.line,
  },
  secondaryBtnLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
  },
  dangerBtn: {
    backgroundColor: t.raised2,
  },
  emptyCard: {
    alignItems: "center",
    padding: brandSpacing.s6,
    gap: brandSpacing.s2,
    backgroundColor: t.raised,
    borderRadius: brandRadii.lg,
    borderWidth: 1,
    borderColor: t.line,
  },
  emptyTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 15,
    fontWeight: "800",
  },
  emptyBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    textAlign: "center",
  },
});
