/**
 * TripDayScreen — US-7 single-day breakdown.
 *
 * Renders distance / time / elevation / quality for a single day plus a
 * waypoint timeline with fuel and overnight stops called out — those are
 * the two waypoint classes riders reason about while deciding whether to
 * follow the generator's proposal as-is.
 */

import React, {
  ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Icon from "@react-native-vector-icons/material-design-icons";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  meetsQualityThreshold,
  qualityColorWithThreshold,
  qualityLabel,
  spacing,
} from "@/theme";
import { api } from "@/services/api";
import { usePreferencesStore, useTripStore } from "@/stores";
import type {
  Accommodation,
  AccommodationKind,
  AlongRoutePoi,
  Poi,
  PoiKind,
  Trip,
  TripDay,
  Waypoint,
} from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";
import {
  WAYPOINT_ICONS,
  formatDurationMin,
  formatKm,
  formatWaypointType,
  isLastDay,
  pickDayEndAnchor,
  summarizeFuelRange,
  summarizeWaypoints,
  withSuggestedOvernightStop,
  type FuelLeg,
  type FuelStationAnchor,
} from "./TripScreens.helpers";

type DayRoute = RouteProp<TripsStackParamList, "TripDay">;
type Nav = NativeStackNavigationProp<TripsStackParamList, "TripDay">;
type IconName = ComponentProps<typeof Icon>["name"];

export default function TripDayScreen() {
  const { params } = useRoute<DayRoute>();
  const navigation = useNavigation<Nav>();
  const { tripId, dayNumber } = params;

  const cachedTrip = useTripStore((s) => s.activeTrip);
  const setActiveTrip = useTripStore((s) => s.setActiveTrip);
  const minQuality = usePreferencesStore((s) => s.minQuality);
  const fuelRangeKm = usePreferencesStore((s) => s.fuelRangeKm);

  // Warm-cache: if the user came from TripDetail we already have the
  // trip and don't need to block on a fetch. If they deep-linked (e.g.
  // from a push), we fall back to fetching.
  const [trip, setTrip] = useState<Trip | null>(
    cachedTrip?.id === tripId ? cachedTrip : null,
  );
  const [loading, setLoading] = useState(trip === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (trip) return;
    let ignore = false;
    (async () => {
      try {
        const next = await api.getTrip(tripId);
        if (ignore) return;
        setTrip(next);
        setActiveTrip(next);
      } catch (e) {
        if (ignore) return;
        setError(e instanceof Error ? e.message : "Failed to load day");
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [tripId, trip, setActiveTrip]);

  // Resolve the active day before any conditional return so the hook
  // order below stays stable across the loading / error / not-found
  // transitions (Rules of Hooks). `useFuelStationsAlongRoute` short-
  // circuits internally when `day` is undefined.
  const day = trip?.days.find((d) => d.day_number === dayNumber);
  const fuelStations = useFuelStationsAlongRoute(day, fuelRangeKm);
  const handleAccommodationsLoaded = useCallback(
    (items: Accommodation[]) => {
      if (!trip) return;
      const next = withSuggestedOvernightStop(trip, dayNumber, items);
      if (next === trip) return;
      setTrip(next);
      setActiveTrip(next);
    },
    [dayNumber, setActiveTrip, trip],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error || !trip) {
    return (
      <View style={styles.centered}>
        <Icon name="alert-circle-outline" size={48} color={colors.danger} />
        <Text style={styles.errorTitle}>Unable to load day</Text>
        {error ? <Text style={styles.errorBody}>{error}</Text> : null}
      </View>
    );
  }

  if (!day) {
    return (
      <View style={styles.centered}>
        <Icon
          name="calendar-remove-outline"
          size={48}
          color={colors.textTertiary}
        />
        <Text style={styles.errorTitle}>Day {dayNumber} not found</Text>
        <Text style={styles.errorBody}>
          The trip doesn't include this day. It may have been regenerated with a
          different number of days.
        </Text>
      </View>
    );
  }

  const qColor =
    day.avg_quality > 0
      ? qualityColorWithThreshold(day.avg_quality, minQuality)
      : colors.textTertiary;
  // US-5: flag days whose aggregate quality sits below the rider's minimum
  // so trip planners notice a day that doesn't match their expectations
  // without having to scan every segment manually.
  const belowThreshold =
    day.avg_quality > 0 && !meetsQualityThreshold(day.avg_quality, minQuality);
  const summary = summarizeWaypoints(day.waypoints);
  const fuelRange = summarizeFuelRange(day, fuelRangeKm, fuelStations);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View
        style={[styles.card, belowThreshold ? styles.cardBelowThreshold : null]}
      >
        <Text style={styles.subLabel}>Day {day.day_number}</Text>
        <Text style={styles.title}>{day.title ?? `Day ${day.day_number}`}</Text>
        {belowThreshold ? (
          <View style={styles.thresholdBadge}>
            <Icon
              name="eye-off-outline"
              size={12}
              color={colors.textSecondary}
            />
            <Text style={styles.thresholdBadgeLabel}>
              Below your minimum ({qualityLabel(minQuality)})
            </Text>
          </View>
        ) : null}
        <View style={styles.metricsRow}>
          <Metric label="Distance" value={formatKm(day.distance_km)} />
          <Metric
            label="Time"
            value={formatDurationMin(day.estimated_time_min)}
          />
          <Metric
            label="Elevation"
            value={`+${Math.round(day.elevation_gain)} m`}
          />
          <Metric
            label="Quality"
            value={day.avg_quality > 0 ? qualityLabel(day.avg_quality) : "—"}
            valueColor={qColor}
          />
        </View>
      </View>

      <StartNavigationButton
        disabled={day.route_geometry.length < 2}
        onPress={() =>
          navigation.navigate("Navigate", {
            tripId: trip.id,
            dayNumber: day.day_number,
          })
        }
      />

      <HighlightsCard
        fuelStops={summary.fuelStops}
        overnightStops={summary.overnightStops}
      />

      {fuelRange.exceedingCount > 0 ? (
        <FuelRangeWarning
          legs={fuelRange.legs}
          fuelRangeKm={fuelRangeKm}
          exceedingCount={fuelRange.exceedingCount}
        />
      ) : null}

      {!isLastDay(trip.days, day.day_number) ? (
        <AccommodationsCard
          day={day}
          onAccommodationsLoaded={handleAccommodationsLoaded}
        />
      ) : null}

      <NearbyPoisCard day={day} />

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Route</Text>
        {day.waypoints.length === 0 ? (
          <Text style={styles.emptyBody}>
            No waypoints for this day yet. Try regenerating the trip.
          </Text>
        ) : (
          [...day.waypoints]
            .sort((a, b) => a.sequence - b.sequence)
            .map((wp, idx, arr) => (
              <WaypointRow
                key={wp.id}
                waypoint={wp}
                isLast={idx === arr.length - 1}
              />
            ))
        )}
      </View>
    </ScrollView>
  );
}

function StartNavigationButton({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: () => void;
}) {
  // US-16 entry point. Disabled when the planner hasn't filled in a
  // polyline for this day (e.g., a half-generated draft) — starting a nav
  // session over < 2 points has nothing to project onto.
  return (
    <TouchableOpacity
      style={[styles.navigateBtn, disabled && styles.navigateBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel="Start navigation"
      accessibilityState={{ disabled }}
    >
      <Icon name="navigation-variant" size={22} color={colors.textInverse} />
      <Text style={styles.navigateLabel}>Start navigation</Text>
    </TouchableOpacity>
  );
}

/**
 * Fetch live fuel stations along a day's route so `summarizeFuelRange`
 * can annotate exceeding legs with actual refuel options (US-36).
 *
 * Only runs when the rider has a positive declared fuel range *and* at
 * least one leg currently exceeds it — otherwise there's nothing to
 * decorate and we avoid the network round-trip + provider load. Accepts
 * an optional `day` so the caller can invoke this hook before the
 * loading / error / not-found early returns without violating the
 * Rules of Hooks (the hook short-circuits to `[]` internally when the
 * day is missing). When the endpoint errors (provider outage, offline)
 * the hook silently returns an empty list so the existing warning card
 * keeps working in its old waypoint-only shape.
 */
function useFuelStationsAlongRoute(
  day: TripDay | undefined,
  fuelRangeKm: number,
): FuelStationAnchor[] {
  const [stations, setStations] = useState<FuelStationAnchor[]>([]);
  const route = day?.route_geometry ?? [];
  const routeLength = route.length;
  // Quick client-side check so we only query when there is at least one
  // over-range leg on the waypoint-only breakdown. `summarizeFuelRange`
  // is pure and cheap, so reusing it here avoids duplicating the leg
  // logic in this hook.
  const needsStations =
    !!day &&
    fuelRangeKm > 0 &&
    routeLength >= 2 &&
    summarizeFuelRange(day, fuelRangeKm).exceedingCount > 0;

  useEffect(() => {
    if (!needsStations || !day) {
      setStations([]);
      return;
    }
    // Clear eagerly so a day switch doesn't briefly annotate the new
    // day's legs with the previous day's stops while the next fetch is
    // still in flight.
    setStations([]);
    let ignore = false;
    (async () => {
      try {
        const res = await api.listPoisAlongRoute(route, {
          kinds: ["fuel_station"],
        });
        if (ignore) return;
        setStations(
          res.pois.map((p: AlongRoutePoi) => ({
            name: p.name,
            hint: p.hint,
            distanceAlongRouteKm: p.distance_along_route_km,
            distanceFromRouteKm: p.distance_from_route_km,
          })),
        );
      } catch {
        if (!ignore) setStations([]);
      }
    })();
    return () => {
      ignore = true;
    };
    // Depth-equality for `route` would be expensive; key the effect on
    // the day id + length so a geometry update still triggers a refetch
    // (days are regenerated whole on trip edits, never patched in-place).
  }, [day?.id, routeLength, needsStations]);

  return stations;
}

function FuelRangeWarning({
  legs,
  fuelRangeKm,
  exceedingCount,
}: {
  legs: FuelLeg[];
  fuelRangeKm: number;
  exceedingCount: number;
}) {
  // US-10: surface the offending legs so the rider can eyeball where to
  // insert a refuel. We show all legs (not just the over-range ones) so
  // the warning is legible — the context makes it obvious which stretch
  // is the problem without extra prose.
  const longest = legs.reduce(
    (m, l) => (l.distanceKm > m ? l.distanceKm : m),
    0,
  );
  const headline =
    exceedingCount === 1
      ? "1 leg exceeds your fuel range"
      : `${exceedingCount} legs exceed your fuel range`;
  return (
    <View
      style={styles.fuelWarningCard}
      accessibilityRole="alert"
      accessibilityLabel={headline}
    >
      <View style={styles.fuelWarningHeader}>
        <Icon name="gas-station-off" size={22} color={colors.warning} />
        <Text style={styles.fuelWarningTitle}>{headline}</Text>
      </View>
      <Text style={styles.fuelWarningBody}>
        Longest leg is {formatKm(longest)} — beyond your {formatKm(fuelRangeKm)}{" "}
        range. Add a fuel stop or check that tank will make it.
      </Text>
      {legs.map((leg, idx) => (
        <View key={`${idx}-${leg.fromName}-${leg.toName}`}>
          <View style={styles.fuelLegRow}>
            <View
              style={[
                styles.fuelLegBullet,
                leg.exceedsRange
                  ? styles.fuelLegBulletOver
                  : styles.fuelLegBulletOk,
              ]}
            />
            <Text style={styles.fuelLegNames} numberOfLines={1}>
              {leg.fromName} → {leg.toName}
            </Text>
            <Text
              style={[
                styles.fuelLegDistance,
                leg.exceedsRange ? styles.fuelLegDistanceOver : null,
              ]}
            >
              {formatKm(leg.distanceKm)}
            </Text>
          </View>
          {leg.suggestedStops && leg.suggestedStops.length > 0 ? (
            <View style={styles.fuelLegStations}>
              <Text style={styles.fuelLegStationsLabel}>Refuel options</Text>
              {leg.suggestedStops.map((stop, sIdx) => (
                <View
                  key={`${idx}-station-${sIdx}`}
                  style={styles.fuelLegStationRow}
                >
                  <Icon
                    name="gas-station"
                    size={14}
                    color={colors.textSecondary}
                  />
                  <Text style={styles.fuelLegStationName} numberOfLines={1}>
                    {stop.hint ? `${stop.name} · ${stop.hint}` : stop.name}
                  </Text>
                  <Text style={styles.fuelLegStationDistance}>
                    {formatKm(stop.distanceFromLegStartKm)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/**
 * Open the first available external link for a nearby POI-ish row —
 * accommodations, restaurants, viewpoints, and cafés all share this
 * chain. Crowd-sourced data means a malformed or custom-scheme website
 * must not abort the fallback: we accept only http(s) websites, then
 * walk website → phone → OSM, swallowing per-step failures so a missing
 * target app on one row never leaves the row inert.
 */
async function openPoiFallback(item: {
  website: string | null;
  phone: string | null;
  lat: number;
  lng: number;
}): Promise<void> {
  const website =
    item.website && /^https?:\/\//i.test(item.website.trim())
      ? item.website.trim()
      : null;
  const candidates = [
    website,
    item.phone ? `tel:${item.phone.replace(/\s+/g, "")}` : null,
    `https://www.openstreetmap.org/?mlat=${item.lat}&mlon=${item.lng}#map=17/${item.lat}/${item.lng}`,
  ].filter((value): value is string => !!value);

  for (const url of candidates) {
    try {
      await Linking.openURL(url);
      return;
    } catch {
      // Try the next fallback.
    }
  }
}

const ACCOMMODATION_KIND_LABELS: Record<AccommodationKind, string> = {
  hotel: "Hotel",
  motel: "Motel",
  hostel: "Hostel",
  guest_house: "Guest house",
  apartment: "Apartment",
  chalet: "Chalet",
  camp_site: "Camp site",
};

const ACCOMMODATION_KIND_ICONS: Record<AccommodationKind, IconName> = {
  hotel: "bed",
  motel: "bed-outline",
  hostel: "account-group-outline",
  guest_house: "home-outline",
  apartment: "domain",
  chalet: "home-roof",
  camp_site: "tent",
};

function AccommodationsCard({
  day,
  onAccommodationsLoaded,
}: {
  day: TripDay;
  onAccommodationsLoaded?: (items: Accommodation[]) => void;
}) {
  // US-10: suggest overnight stops near each day-end waypoint so planners
  // don't have to jump out to a hotel search app mid-plan. Anchor is the
  // day's end point (last waypoint, falling back to the last geometry
  // vertex); if neither is known, the card hides itself.
  const anchor = useMemo(() => pickDayEndAnchor(day), [day]);
  const [items, setItems] = useState<Accommodation[] | null>(null);
  // Start in the loading state whenever there is an anchor to fetch for,
  // so the first paint shows the spinner instead of flashing the empty
  // state before the effect has a chance to run.
  const [loading, setLoading] = useState(!!anchor);
  const [error, setError] = useState<string | null>(null);
  const [radiusKm, setRadiusKm] = useState<number | null>(null);

  useEffect(() => {
    if (!anchor) return;
    let ignore = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await api.listAccommodations(anchor.lat, anchor.lng);
        if (ignore) return;
        setItems(res.accommodations);
        setRadiusKm(res.radius_km);
      } catch (e) {
        if (ignore) return;
        setError(e instanceof Error ? e.message : "Couldn't load nearby stays");
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [anchor?.lat, anchor?.lng]);

  useEffect(() => {
    if (!items || items.length === 0) return;
    onAccommodationsLoaded?.(items);
  }, [items, onAccommodationsLoaded]);

  if (!anchor) return null;

  return (
    <View style={styles.card}>
      <View style={styles.accommodationsHeader}>
        <Icon name="bed-outline" size={20} color={colors.primary} />
        <Text style={styles.sectionTitle}>Stays near day end</Text>
        {radiusKm !== null && items && items.length > 0 ? (
          <Text style={styles.accommodationsRadius}>
            within {Math.round(radiusKm)} km
          </Text>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.accommodationsEmpty}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : error ? (
        <Text style={styles.accommodationsEmptyBody}>{error}</Text>
      ) : !items || items.length === 0 ? (
        <Text style={styles.accommodationsEmptyBody}>
          No accommodations found near the end of this day. Try expanding the
          day or adjusting the end point.
        </Text>
      ) : (
        items.map((a) => <AccommodationRow key={a.external_id} item={a} />)
      )}
    </View>
  );
}

function AccommodationRow({ item }: { item: Accommodation }) {
  const label = item.name?.trim() || ACCOMMODATION_KIND_LABELS[item.kind];
  const icon = ACCOMMODATION_KIND_ICONS[item.kind];
  const metaParts = [
    ACCOMMODATION_KIND_LABELS[item.kind],
    `${item.distance_km.toFixed(1)} km`,
  ];
  if (item.stars) metaParts.push("★".repeat(item.stars));

  return (
    <TouchableOpacity
      style={styles.accommodationRow}
      onPress={() => {
        void openPoiFallback(item);
      }}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${item.distance_km.toFixed(1)} kilometres away`}
    >
      <View style={styles.accommodationIconWrap}>
        <Icon name={icon} size={18} color={colors.primary} />
      </View>
      <View style={styles.accommodationBody}>
        <Text style={styles.accommodationName} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.accommodationMeta} numberOfLines={1}>
          {metaParts.join(" · ")}
        </Text>
      </View>
      <Icon
        name="open-in-new"
        size={16}
        color={colors.textTertiary}
        style={styles.accommodationChevron}
      />
    </TouchableOpacity>
  );
}

const POI_KIND_LABELS: Record<PoiKind, string> = {
  restaurant: "Restaurant",
  viewpoint: "Viewpoint",
  cafe: "Café",
  fuel_station: "Fuel station",
};

const POI_KIND_ICONS: Record<PoiKind, IconName> = {
  restaurant: "silverware-fork-knife",
  viewpoint: "binoculars",
  cafe: "coffee",
  fuel_station: "gas-station",
};

function NearbyPoisCard({ day }: { day: TripDay }) {
  // US-10: restaurants / viewpoints / cafés near the day end. Anchored to
  // the same point the accommodations card uses so dinner-and-sleep
  // suggestions land in the same spatial context, which is what most
  // riders are planning on a long-distance day. If the day has no anchor
  // (no waypoints and no route geometry) the card hides itself.
  const anchor = useMemo(() => pickDayEndAnchor(day), [day]);
  const [items, setItems] = useState<Poi[] | null>(null);
  const [loading, setLoading] = useState(!!anchor);
  const [error, setError] = useState<string | null>(null);
  const [radiusKm, setRadiusKm] = useState<number | null>(null);

  useEffect(() => {
    if (!anchor) return;
    let ignore = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await api.listPois(anchor.lat, anchor.lng);
        if (ignore) return;
        setItems(res.pois);
        setRadiusKm(res.radius_km);
      } catch (e) {
        if (ignore) return;
        setError(
          e instanceof Error ? e.message : "Couldn't load nearby places",
        );
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [anchor?.lat, anchor?.lng]);

  if (!anchor) return null;

  return (
    <View style={styles.card}>
      <View style={styles.accommodationsHeader}>
        <Icon
          name="map-marker-radius-outline"
          size={20}
          color={colors.primary}
        />
        <Text style={styles.sectionTitle}>Places near day end</Text>
        {radiusKm !== null && items && items.length > 0 ? (
          <Text style={styles.accommodationsRadius}>
            within {Math.round(radiusKm)} km
          </Text>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.accommodationsEmpty}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : error ? (
        <Text style={styles.accommodationsEmptyBody}>{error}</Text>
      ) : !items || items.length === 0 ? (
        <Text style={styles.accommodationsEmptyBody}>
          No restaurants, viewpoints, cafés, or fuel stations found near the end
          of this day.
        </Text>
      ) : (
        items.map((p) => <PoiRow key={p.external_id} item={p} />)
      )}
    </View>
  );
}

function PoiRow({ item }: { item: Poi }) {
  const label = item.name?.trim() || POI_KIND_LABELS[item.kind];
  const icon = POI_KIND_ICONS[item.kind];
  const metaParts = [
    POI_KIND_LABELS[item.kind],
    `${item.distance_km.toFixed(1)} km`,
  ];
  if (item.hint) metaParts.push(item.hint);

  return (
    <TouchableOpacity
      style={styles.accommodationRow}
      onPress={() => {
        void openPoiFallback(item);
      }}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${item.distance_km.toFixed(1)} kilometres away`}
    >
      <View style={styles.accommodationIconWrap}>
        <Icon name={icon} size={18} color={colors.primary} />
      </View>
      <View style={styles.accommodationBody}>
        <Text style={styles.accommodationName} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.accommodationMeta} numberOfLines={1}>
          {metaParts.join(" · ")}
        </Text>
      </View>
      <Icon
        name="open-in-new"
        size={16}
        color={colors.textTertiary}
        style={styles.accommodationChevron}
      />
    </TouchableOpacity>
  );
}

function HighlightsCard({
  fuelStops,
  overnightStops,
}: {
  fuelStops: Waypoint[];
  overnightStops: Waypoint[];
}) {
  if (fuelStops.length === 0 && overnightStops.length === 0) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Highlights</Text>
      {fuelStops.length > 0 ? (
        <HighlightRow
          icon="gas-station"
          label="Fuel"
          value={`${fuelStops.length} stop${fuelStops.length === 1 ? "" : "s"}`}
          detail={fuelStops
            .map((f) => f.name)
            .filter((n): n is string => !!n)
            .join(" · ")}
        />
      ) : null}
      {overnightStops.length > 0 ? (
        <HighlightRow
          icon="bed"
          label="Overnight"
          value={`${overnightStops.length} stop${overnightStops.length === 1 ? "" : "s"}`}
          detail={overnightStops
            .map((h) => h.name)
            .filter((n): n is string => !!n)
            .join(" · ")}
        />
      ) : null}
    </View>
  );
}

function HighlightRow({
  icon,
  label,
  value,
  detail,
}: {
  icon: IconName;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <View style={styles.highlightRow}>
      <View style={styles.highlightIconWrap}>
        <Icon name={icon} size={20} color={colors.primary} />
      </View>
      <View style={styles.highlightBody}>
        <Text style={styles.highlightLabel}>{label}</Text>
        <Text style={styles.highlightValue}>{value}</Text>
        {detail ? (
          <Text style={styles.highlightDetail} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function WaypointRow({
  waypoint,
  isLast,
}: {
  waypoint: Waypoint;
  isLast: boolean;
}) {
  const isFuel = waypoint.waypoint_type === "fuel";
  const iconName = (WAYPOINT_ICONS[waypoint.waypoint_type] ??
    "map-marker") as IconName;
  const iconColor = isFuel ? colors.warning : colors.primary;

  return (
    <View style={styles.timelineRow}>
      <View style={styles.timelineGutter}>
        <View
          style={[styles.timelineBubble, isFuel && styles.timelineBubbleFuel]}
        >
          <Icon name={iconName} size={16} color={iconColor} />
        </View>
        {!isLast ? <View style={styles.timelineLine} /> : null}
      </View>
      <View style={styles.timelineBody}>
        <View style={styles.timelineHeader}>
          <Text style={styles.timelineTitle}>
            {waypoint.name ?? formatWaypointType(waypoint.waypoint_type)}
          </Text>
          {isFuel ? (
            <View style={styles.fuelBadge}>
              <Text style={styles.fuelBadgeText}>FUEL</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.timelineMeta}>
          {formatWaypointType(waypoint.waypoint_type)}
          {waypoint.duration_min
            ? ` · ${formatDurationMin(waypoint.duration_min)} stop`
            : ""}
        </Text>
        {waypoint.notes ? (
          <Text style={styles.timelineNotes}>{waypoint.notes}</Text>
        ) : null}
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
  errorTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.md,
    textAlign: "center",
  },
  errorBody: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: "center",
    lineHeight: 22,
  },
  emptyBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardBelowThreshold: {
    opacity: 0.7,
    borderColor: colors.borderLight,
  },
  thresholdBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.bgElevated,
  },
  thresholdBadgeLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  subLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  metricsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: spacing.md,
    rowGap: spacing.sm,
  },
  metric: {
    flex: 1,
    minWidth: 80,
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
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    marginTop: 2,
  },
  highlightRow: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "flex-start",
  },
  highlightIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryAlpha15,
  },
  highlightBody: {
    flex: 1,
    gap: 2,
  },
  highlightLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  highlightValue: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  highlightDetail: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  timelineRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  timelineGutter: {
    width: 32,
    alignItems: "center",
  },
  timelineBubble: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  timelineBubbleFuel: {
    borderColor: colors.warning,
    backgroundColor: "rgba(234, 179, 8, 0.1)",
  },
  timelineLine: {
    flex: 1,
    width: 2,
    backgroundColor: colors.border,
    marginTop: 4,
  },
  timelineBody: {
    flex: 1,
    paddingBottom: spacing.md,
    gap: 2,
  },
  timelineHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  timelineTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  timelineMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  timelineNotes: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 4,
    lineHeight: 20,
  },
  fuelBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.warning,
  },
  fuelBadgeText: {
    color: colors.textInverse,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.5,
  },
  navigateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  navigateBtnDisabled: {
    opacity: 0.5,
  },
  navigateLabel: {
    color: colors.textInverse,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  fuelWarningCard: {
    backgroundColor: colors.qualityAlpha.fair,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.warning,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  fuelWarningHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  fuelWarningTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    flex: 1,
  },
  fuelWarningBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 18,
  },
  fuelLegRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
  fuelLegBullet: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  fuelLegBulletOver: {
    backgroundColor: colors.warning,
  },
  fuelLegBulletOk: {
    backgroundColor: colors.textTertiary,
  },
  fuelLegNames: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  fuelLegDistance: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  fuelLegDistanceOver: {
    color: colors.warning,
  },
  fuelLegStations: {
    marginLeft: spacing.lg,
    marginTop: spacing.xs,
    gap: spacing.xs,
  },
  fuelLegStationsLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  fuelLegStationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  fuelLegStationName: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  fuelLegStationDistance: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  accommodationsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  accommodationsRadius: {
    marginLeft: "auto",
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  accommodationsEmpty: {
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  accommodationsEmptyBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  accommodationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  accommodationIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryAlpha15,
  },
  accommodationBody: {
    flex: 1,
    gap: 2,
  },
  accommodationName: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  accommodationMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
  },
  accommodationChevron: {
    marginLeft: spacing.xs,
  },
});
