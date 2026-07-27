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
import { Icon } from "@/components/Icon";
import { meetsQualityThreshold, qualityLabel } from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  qualityBrandColor,
  statusFg,
  UNSCORED_COLOR,
} from "@/theme/brand";
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
  formatElevationM,
  formatKm,
  formatNearbyPlaceAccessibilityLabel,
  formatNearbyPlaceMeta,
  formatNearbyRadius,
  formatWaypointDisplayName,
  formatWaypointSemanticLabel,
  isLastDay,
  pickDayEndAnchor,
  poiOpenCandidates,
  summarizeFuelRange,
  summarizeWaypoints,
  withSuggestedOvernightStop,
  type FuelLeg,
  type FuelStationAnchor,
} from "./TripScreens.helpers";
import { getUserFacingErrorMessage, type EnglishMessageKey } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";

type DayRoute = RouteProp<TripsStackParamList, "TripDay">;
type Nav = NativeStackNavigationProp<TripsStackParamList, "TripDay">;
type IconName = ComponentProps<typeof Icon>["name"];

const t = brandColorsLight;

export default function TripDayScreen() {
  const translate = useTranslation();
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
        setError(getUserFacingErrorMessage(e, translate("Failed to load day")));
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
        <ActivityIndicator size="large" color={t.fg} />
      </View>
    );
  }

  if (error || !trip) {
    return (
      <View style={styles.centered}>
        <Icon name="alert-circle-outline" size={48} color={statusFg.danger} />
        <Text style={styles.errorTitle}>{translate("Unable to load day")}</Text>
        {error ? <Text style={styles.errorBody}>{error}</Text> : null}
      </View>
    );
  }

  if (!day) {
    return (
      <View style={styles.centered}>
        <Icon name="calendar-remove-outline" size={48} color={t.dim} />
        <Text style={styles.errorTitle}>
          {translate("Day {day} not found", { day: dayNumber })}
        </Text>
        <Text style={styles.errorBody}>
          {translate(
            "The trip doesn't include this day. It may have been regenerated with a different number of days.",
          )}
        </Text>
      </View>
    );
  }

  const qColor =
    day.avg_quality > 0 ? qualityBrandColor(day.avg_quality) : UNSCORED_COLOR;
  // US-5: flag days whose aggregate quality sits below the rider's minimum
  // so trip planners notice a day that doesn't match their expectations
  // without having to scan every segment manually.
  const belowThreshold =
    day.avg_quality > 0 && !meetsQualityThreshold(day.avg_quality, minQuality);
  const summary = summarizeWaypoints(
    day.waypoints,
    isLastDay(trip?.days ?? [], day.day_number),
  );
  const fuelRange = summarizeFuelRange(day, fuelRangeKm, fuelStations);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View
        style={[styles.card, belowThreshold ? styles.cardBelowThreshold : null]}
      >
        <Text style={styles.subLabel}>
          {translate("Day {day}", { day: day.day_number })}
        </Text>
        <Text style={styles.title}>
          {day.title ?? translate("Day {value0}", { value0: day.day_number })}
        </Text>
        {belowThreshold ? (
          <View style={styles.thresholdBadge}>
            <Icon name="eye-off-outline" size={12} color={t.dim} />
            <Text style={styles.thresholdBadgeLabel}>
              {translate("Below your minimum ({quality})", {
                quality: qualityLabel(minQuality),
              })}
            </Text>
          </View>
        ) : null}
        <View style={styles.metricsRow}>
          <Metric
            label={translate("Distance")}
            value={formatKm(day.distance_km)}
          />
          <Metric
            label={translate("Time")}
            value={formatDurationMin(day.estimated_time_min)}
          />
          <Metric
            label={translate("Elevation")}
            value={formatElevationM(day.elevation_gain, "+")}
          />
          <Metric
            label={translate("Quality")}
            value={day.avg_quality > 0 ? qualityLabel(day.avg_quality) : "—"}
            swatchColor={day.avg_quality > 0 ? qColor : undefined}
          />
        </View>
      </View>

      <StartNavigationButton
        disabled={day.route_geometry.length < 2}
        onPress={() =>
          navigation.navigate("Navigate", {
            source: "trip-day",
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
        <Text style={styles.sectionTitle}>{translate("Route")}</Text>
        {day.waypoints.length === 0 ? (
          <Text style={styles.emptyBody}>
            {translate(
              "No waypoints for this day yet. Try regenerating the trip.",
            )}
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
  const translate = useTranslation();
  // US-16 entry point. Disabled when the planner hasn't filled in a
  // polyline for this day (e.g., a half-generated draft) — starting a nav
  // session over < 2 points has nothing to project onto.
  return (
    <TouchableOpacity
      style={[styles.navigateBtn, disabled && styles.navigateBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={translate("Start navigation")}
      accessibilityState={{ disabled }}
    >
      <Icon name="navigation-variant" size={22} color={t.invFg} />
      <Text style={styles.navigateLabel}>{translate("Start navigation")}</Text>
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
  const translate = useTranslation();
  // US-10: surface the offending legs so the rider can eyeball where to
  // insert a refuel. We show all legs (not just the over-range ones) so
  // the warning is legible — the context makes it obvious which stretch
  // is the problem without extra prose.
  const longest = legs.reduce(
    (m, l) => (l.distanceKm > m ? l.distanceKm : m),
    0,
  );
  const headline = translate(
    "{count, plural, one {# leg exceeds} other {# legs exceed}} your fuel range",
    { count: exceedingCount },
  );
  return (
    <View
      style={styles.fuelWarningCard}
      accessibilityRole="alert"
      accessibilityLabel={headline}
    >
      <View style={styles.fuelWarningHeader}>
        <Icon name="gas-station-off" size={22} color={statusFg.warning} />
        <Text style={styles.fuelWarningTitle}>{headline}</Text>
      </View>
      <Text style={styles.fuelWarningBody}>
        {translate(
          "Longest leg is {longest} — beyond your {range} range. Add a fuel stop or check that tank will make it.",
          {
            longest: formatKm(longest),
            range: formatKm(fuelRangeKm),
          },
        )}
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
              {translate("{start} → {end}", {
                start: leg.fromName,
                end: leg.toName,
              })}
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
              <Text style={styles.fuelLegStationsLabel}>
                {translate("Refuel options")}
              </Text>
              {leg.suggestedStops.map((stop, sIdx) => (
                <View
                  key={`${idx}-station-${sIdx}`}
                  style={styles.fuelLegStationRow}
                >
                  <Icon name="gas-station" size={14} color={t.dim} />
                  <Text style={styles.fuelLegStationName} numberOfLines={1}>
                    {stop.hint
                      ? translate("{value0} · {value1}", {
                          value0: stop.name,
                          value1: stop.hint,
                        })
                      : stop.name}
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
  maps_url: string;
  lat: number;
  lng: number;
}): Promise<void> {
  for (const url of poiOpenCandidates(item)) {
    try {
      await Linking.openURL(url);
      return;
    } catch {
      // Try the next fallback.
    }
  }
}

const ACCOMMODATION_KIND_LABELS: Record<AccommodationKind, EnglishMessageKey> =
  {
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
  const translate = useTranslation();
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
        setError(
          getUserFacingErrorMessage(e, translate("Couldn't load nearby stays")),
        );
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
        <Icon name="bed-outline" size={20} color={t.fg} />
        <Text style={styles.sectionTitle}>
          {translate("Stays near day end")}
        </Text>
        {radiusKm !== null && items && items.length > 0 ? (
          <Text style={styles.accommodationsRadius}>
            {formatNearbyRadius(radiusKm)}
          </Text>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.accommodationsEmpty}>
          <ActivityIndicator size="small" color={t.fg} />
        </View>
      ) : error ? (
        <Text style={styles.accommodationsEmptyBody}>{error}</Text>
      ) : !items || items.length === 0 ? (
        <Text style={styles.accommodationsEmptyBody}>
          {translate(
            "No accommodations found near the end of this day. Try expanding the day or adjusting the end point.",
          )}
        </Text>
      ) : (
        items.map((a) => <AccommodationRow key={a.external_id} item={a} />)
      )}
    </View>
  );
}

function AccommodationRow({ item }: { item: Accommodation }) {
  const translate = useTranslation();
  const kindLabel = translate(ACCOMMODATION_KIND_LABELS[item.kind]);
  const label = item.name?.trim() || kindLabel;
  const icon = ACCOMMODATION_KIND_ICONS[item.kind];
  const meta = formatNearbyPlaceMeta(
    kindLabel,
    item.distance_km,
    item.stars ? "★".repeat(item.stars) : undefined,
  );

  return (
    <TouchableOpacity
      style={styles.accommodationRow}
      onPress={() => {
        void openPoiFallback(item);
      }}
      accessibilityRole="button"
      accessibilityLabel={formatNearbyPlaceAccessibilityLabel(
        label,
        item.distance_km,
      )}
    >
      <View style={styles.accommodationIconWrap}>
        <Icon name={icon} size={18} color={t.dim} />
      </View>
      <View style={styles.accommodationBody}>
        <Text style={styles.accommodationName} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.accommodationMeta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <Icon
        name="open-in-new"
        size={16}
        color={t.dim}
        style={styles.accommodationChevron}
      />
    </TouchableOpacity>
  );
}

const POI_KIND_LABELS: Record<PoiKind, EnglishMessageKey> = {
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
  const translate = useTranslation();
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
          getUserFacingErrorMessage(
            e,
            translate("Couldn't load nearby places"),
          ),
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
        <Icon name="map-marker-radius-outline" size={20} color={t.fg} />
        <Text style={styles.sectionTitle}>
          {translate("Places near day end")}
        </Text>
        {radiusKm !== null && items && items.length > 0 ? (
          <Text style={styles.accommodationsRadius}>
            {formatNearbyRadius(radiusKm)}
          </Text>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.accommodationsEmpty}>
          <ActivityIndicator size="small" color={t.fg} />
        </View>
      ) : error ? (
        <Text style={styles.accommodationsEmptyBody}>{error}</Text>
      ) : !items || items.length === 0 ? (
        <Text style={styles.accommodationsEmptyBody}>
          {translate(
            "No restaurants, viewpoints, cafés, or fuel stations found near the end of this day.",
          )}
        </Text>
      ) : (
        items.map((p) => <PoiRow key={p.external_id} item={p} />)
      )}
    </View>
  );
}

function PoiRow({ item }: { item: Poi }) {
  const translate = useTranslation();
  const kindLabel = translate(POI_KIND_LABELS[item.kind]);
  const label = item.name?.trim() || kindLabel;
  const icon = POI_KIND_ICONS[item.kind];
  const meta = formatNearbyPlaceMeta(
    kindLabel,
    item.distance_km,
    item.hint ?? undefined,
  );

  return (
    <TouchableOpacity
      style={styles.accommodationRow}
      onPress={() => {
        void openPoiFallback(item);
      }}
      accessibilityRole="button"
      accessibilityLabel={formatNearbyPlaceAccessibilityLabel(
        label,
        item.distance_km,
      )}
    >
      <View style={styles.accommodationIconWrap}>
        <Icon name={icon} size={18} color={t.dim} />
      </View>
      <View style={styles.accommodationBody}>
        <Text style={styles.accommodationName} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.accommodationMeta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <Icon
        name="open-in-new"
        size={16}
        color={t.dim}
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
  const translate = useTranslation();
  if (fuelStops.length === 0 && overnightStops.length === 0) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>{translate("Highlights")}</Text>
      {fuelStops.length > 0 ? (
        <HighlightRow
          icon="gas-station"
          label={translate("Fuel")}
          value={translate("{count, plural, one {# stop} other {# stops}}", {
            count: fuelStops.length,
          })}
          detail={fuelStops
            .map((f) => f.name)
            .filter((n): n is string => !!n)
            .join(" · ")}
        />
      ) : null}
      {overnightStops.length > 0 ? (
        <HighlightRow
          icon="bed"
          label={translate("Overnight")}
          value={translate("{count, plural, one {# stop} other {# stops}}", {
            count: overnightStops.length,
          })}
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
        <Icon name={icon} size={20} color={t.fg} />
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
  const translate = useTranslation();
  const isFuel = waypoint.waypoint_type === "fuel";
  const iconName = WAYPOINT_ICONS[waypoint.waypoint_type] ?? "map-marker";
  const iconColor = isFuel ? statusFg.warning : t.fg;
  const semanticLabel = formatWaypointSemanticLabel(waypoint);

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
            {formatWaypointDisplayName(waypoint)}
          </Text>
          {isFuel ? (
            <View style={styles.fuelBadge}>
              <Text style={styles.fuelBadgeText}>{translate("FUEL")}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.timelineMeta}>
          {waypoint.duration_min
            ? translate("{type} · {duration} stop", {
                type: semanticLabel,
                duration: formatDurationMin(waypoint.duration_min),
              })
            : semanticLabel}
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
  swatchColor,
}: {
  label: string;
  value: string;
  // Ramp colour for the quality metric. Rendered as a swatch dot beside the
  // ink value — the Q1–Q5 ramp fails AA as text on the cream card, so the
  // colour lives on the swatch (rule #4) and the label stays ink.
  swatchColor?: string | undefined;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <View style={styles.metricValueRow}>
        {swatchColor ? (
          <View
            style={[styles.qualitySwatch, { backgroundColor: swatchColor }]}
          />
        ) : null}
        <Text style={styles.metricValue}>{value}</Text>
      </View>
    </View>
  );
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
  centered: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  errorTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "700",
    marginTop: brandSpacing.s3,
    textAlign: "center",
  },
  errorBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
  emptyBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
  },
  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  cardBelowThreshold: {
    opacity: 0.7,
    borderColor: t.lineStrong,
  },
  thresholdBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s2,
    paddingVertical: brandSpacing.s1,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised2,
  },
  thresholdBadgeLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
  subLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  title: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  sectionTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  metricsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: brandSpacing.s3,
    rowGap: brandSpacing.s2,
  },
  metric: {
    flex: 1,
    minWidth: 80,
  },
  metricLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  metricValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    marginTop: 2,
  },
  metricValue: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  qualitySwatch: {
    width: 12,
    height: 12,
    borderRadius: 3,
  },
  highlightRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
    alignItems: "flex-start",
  },
  highlightIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
  },
  highlightBody: {
    flex: 1,
    gap: 2,
  },
  highlightLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  highlightValue: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  highlightDetail: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
  },
  timelineRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
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
    backgroundColor: t.raised2,
    borderWidth: 1,
    borderColor: t.line,
  },
  timelineBubbleFuel: {
    borderColor: statusFg.warning,
    backgroundColor: t.raised2,
  },
  timelineLine: {
    flex: 1,
    width: 2,
    backgroundColor: t.line,
    marginTop: 4,
  },
  timelineBody: {
    flex: 1,
    paddingBottom: brandSpacing.s3,
    gap: 2,
  },
  timelineHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  timelineTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  timelineMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  timelineNotes: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    marginTop: 4,
    lineHeight: 20,
  },
  fuelBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: brandRadii.sm,
    backgroundColor: statusFg.warning,
  },
  fuelBadgeText: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  navigateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 44,
    paddingVertical: brandSpacing.s4,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  navigateBtnDisabled: {
    opacity: 0.5,
  },
  navigateLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  fuelWarningCard: {
    backgroundColor: t.raised2,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: statusFg.warning,
    padding: brandSpacing.s4,
    gap: brandSpacing.s2,
  },
  fuelWarningHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  fuelWarningTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
    flex: 1,
  },
  fuelWarningBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    lineHeight: 18,
  },
  fuelLegRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingTop: brandSpacing.s1,
  },
  fuelLegBullet: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  fuelLegBulletOver: {
    backgroundColor: statusFg.warning,
  },
  fuelLegBulletOk: {
    backgroundColor: t.dim,
  },
  fuelLegNames: {
    flex: 1,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    fontWeight: "600",
  },
  fuelLegDistance: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    fontWeight: "600",
  },
  fuelLegDistanceOver: {
    color: statusFg.warning,
  },
  fuelLegStations: {
    marginLeft: brandSpacing.s4,
    marginTop: brandSpacing.s1,
    gap: brandSpacing.s1,
  },
  fuelLegStationsLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  fuelLegStationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
  },
  fuelLegStationName: {
    flex: 1,
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
  },
  fuelLegStationDistance: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
  accommodationsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  accommodationsRadius: {
    marginLeft: "auto",
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
  accommodationsEmpty: {
    paddingVertical: brandSpacing.s3,
    alignItems: "center",
  },
  accommodationsEmptyBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    lineHeight: 20,
  },
  accommodationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    minHeight: 44,
    paddingVertical: brandSpacing.s2,
  },
  accommodationIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
  },
  accommodationBody: {
    flex: 1,
    gap: 2,
  },
  accommodationName: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  accommodationMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  accommodationChevron: {
    marginLeft: brandSpacing.s1,
  },
});
