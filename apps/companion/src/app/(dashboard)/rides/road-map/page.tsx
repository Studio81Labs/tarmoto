"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage } from "@/i18n";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Crosshair,
  Loader2,
  Map as MapIcon,
  Share2,
  X,
} from "lucide-react";
import {
  Alert,
  Button,
  Card,
  Input,
  MetricTile,
  Mono,
  QualityBars,
  Stamp,
} from "@tarmoto/ui";
import { RidesScaffold } from "../_RidesScaffold";
import { RidesEmptyState } from "../_RidesEmptyState";
import { useFormat } from "@/format/FormatProvider";
import type { Formatters } from "@tarmoto/shared";
import { api, ApiError, explorationApi, roadsApi } from "@/lib/api";
import { shareRoadMap } from "@/lib/road-map-share";
import type {
  ExplorationStats,
  RiddenSegmentMeta,
  UnriddenSegment,
} from "@/lib/api";
import { scoreToQualityTier } from "@/lib/utils";
import type { components } from "@tarmoto/openapi-client";
import { useAuthStore } from "@/stores/auth";
import { useTimeWindow, windowStartISO } from "../_components/TimeWindowPills";
import {
  buildMapShareSnapshot,
  filterRiddenByPeriod,
  type RiddenSegment,
} from "@/lib/road-map-layer";
import { usePreferencesStore } from "@/stores/preferences";
import {
  PersonalRoadMap,
  type PersonalRoadMapHandle,
} from "./_components/PersonalRoadMap";
import { useUserRideTracks } from "@/hooks/useUserRideTracks";
import {
  SegmentDetailSidebar,
  type SegmentDetailPanelState,
} from "@/components/roads/SegmentDetailSidebar";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useFeatureKillSwitch, useSystemSwitch } from "@/hooks/useEntitlements";
import { SystemSwitchGate } from "@/components/entitlements/SystemSwitchGate";
/**
 * Personal road map (US-50).
 *
 * The MapLibre overlay (PersonalRoadMap) paints a dim base + a Tarmoto
 * Cyan layer for ridden segments using `feature-state` so 10k+ segments
 * don't stall the main thread. Period chips drive a client-side filter
 * over the in-memory ridden list — no extra round-trip when the user
 * flips between "this year" and "all time".
 */
const NEARBY_DEFAULT_RADIUS_KM = 15;
const NEARBY_LIMIT = 25;
// Fallback coordinate used when the browser blocks or doesn't have geolocation.
// Prague (50.0755, 14.4378) is a neutral Central-European anchor for the
// initial nearby-roads fetch; the rider replaces it via "Use my location" or
// the lat/lng inputs. Empty label so the default centre shows no placeholder
// chip in the card header (only real picks — "My location" / "Custom point" —
// surface a label there).
const FALLBACK_CENTER = {
  lat: 50.0755,
  lng: 14.4378,
  label: "",
};
const INITIAL_MAP_ZOOM = 8;
// The public share serializes a viewport centre. Round it to ~0.1° (≈11 km) so
// a shared coverage map opens over the rider's riding region — not the neutral
// Prague fallback, which would leave their highlighted roads off-screen — while
// still stripping the street-level precision of a raw geolocation fix. A
// coverage map inherently reveals the region; it must not reveal a home address.
const SHARE_CENTER_PRECISION = 10;
const coarsenForShare = (coord: number): number =>
  Math.round(coord * SHARE_CENTER_PRECISION) / SHARE_CENTER_PRECISION;
export default function RoadMapPage() {
  // `useTimeWindow` (below) reads `?window=` via useSearchParams, which needs
  // a Suspense boundary for Next.js static prerender (mirrors the All-rides
  // page wrapper).
  return (
    <Suspense fallback={null}>
      <RoadMapPageInner />
    </Suspense>
  );
}

function RoadMapPageInner() {
  const t = useTranslation();
  // The tab-row time pills drive the window via `?window=`; the road-map
  // reads it (no local period state) so flipping a pill updates the map,
  // the legend count, and the share snapshot together. The `TimeWindow`
  // union is value-identical to the `TimePeriod` keys consumed by the
  // pure exploration/road-map helpers, so it's passed straight through.
  const period = useTimeWindow();
  // Which map view is active: the rider's finished ride routes (default) or the
  // ridden-segment coverage / exploration overlay behind a toggle.
  const [mapViewPref, setMapViewPref] = useState<"routes" | "coverage">(
    "routes",
  );
  const { enabled: coverageEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  // The EFFECTIVE view. Collapsing it here rather than gating each consumer is
  // deliberate: `mapView === "coverage"` is the single condition behind the
  // nearby-unridden fetch, the segment drawer, the legend and the coverage
  // cards, so one derivation takes all of them down together and cannot drift
  // as new coverage UI is added. The rider's own preference is preserved in
  // `mapViewPref`, so restoring the switch puts them back where they were.
  const mapView = coverageEnabled ? mapViewPref : "routes";
  // The rider's finished ride routes (GPS tracks), windowed to the same time
  // period as the coverage view + sidebar so the map doesn't contradict the
  // active pill. `truncated` flags when the ≤500 server cap hides older rides.
  const tracksStartedFrom = useMemo(() => windowStartISO(period), [period]);
  const {
    tracks: rideTracks,
    truncated: rideTracksTruncated,
    loading: tracksLoading,
    error: tracksError,
  } = useUserRideTracks({ startedFrom: tracksStartedFrom });
  // Drop the ride popover when it no longer applies — switched to Coverage, or
  // the ride fell out of the windowed track set — so a stale card can't link to
  // a ride that isn't on the active map.
  useEffect(() => {
    setSelectedRideId((current) =>
      current &&
      mapView === "routes" &&
      rideTracks.some((track) => track.id === current)
        ? current
        : null,
    );
  }, [mapView, rideTracks]);
  // Likewise, drop the segment drawer + road highlight when leaving Coverage so
  // stale coverage detail doesn't sit over the Routes map.
  useEffect(() => {
    if (mapView !== "coverage") setSelectedSegmentId(null);
  }, [mapView]);
  const [stats, setStats] = useState<ExplorationStats | null>(null);
  const [riddenSegments, setRiddenSegments] = useState<RiddenSegmentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  // Debounced: fast loads render content directly, no spinner flash.
  const showLoader = useDelayedLoading(loading);
  const [loadError, setLoadError] = useState<string | null>(null);
  // `center` is the live view/query centre: it tracks the rider's geolocated
  // position (auto-center + explicit "Centre on me"/"Use my location") so the
  // map camera, the "Nearby unridden" query, and the coordinate inputs all stay
  // pointed at the same place. The public share coarsens it (see `handleShare`).
  const [center, setCenter] = useState(FALLBACK_CENTER);
  const [nearby, setNearby] = useState<UnriddenSegment[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  // Geolocation failure, kept separate from `nearbyError` (a coverage-only
  // card): the "Centre on me" button lives on the map in both views, so its
  // error must be visible from Routes too.
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  // The ridden segment whose detail popover is open (clicked on the map).
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );
  // Routes view: the ride whose popover is open (clicked route line).
  const [selectedRideId, setSelectedRideId] = useState<string | null>(null);
  // Only one map selection at a time — opening a ride closes any segment drawer.
  const selectRide = useCallback((rideId: string) => {
    setSelectedSegmentId(null);
    setSelectedRideId(rideId);
  }, []);
  // In-flight guard (a ref, not state) so the button looks identical to the
  // ride-detail / community Share — no loading/label multistate — while still
  // ignoring a double-click that would POST a second map_shares row.
  const sharingRef = useRef(false);
  // Track the auto-reset timer so back-to-back share clicks don't let a
  // stale timer stomp over the next call's `{ kind: "creating" }` state
  // (which would re-enable the button mid-flight).
  const mapRef = useRef<PersonalRoadMapHandle>(null);
  // Preferences are hydrated from localStorage on the client; during SSR the
  // store still returns the metric default so the server-rendered markup
  // matches the first client paint. The format seam already reads the
  // account's unit preference, so there's no separate `unitSystem` read here.
  const format = useFormat();
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);
  // Gate the exploration fetch on auth so a cold visit to
  // `/rides/road-map` doesn't race AuthSync. Both calls hit authed
  // endpoints.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  // The registry scopes `sys_gamification` to "badges, challenges, personal
  // road map", so exploration is part of it.
  const { enabled: gamificationEnabled } = useSystemSwitch("sys_gamification");
  useEffect(() => {
    if (!authReady) return;
    // With the subsystem off these endpoints answer empty, so fetching would
    // render 0% explored — a number the rider reads as their own coverage
    // rather than as a shutdown.
    if (!gamificationEnabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([explorationApi.getStats(), explorationApi.getRiddenSegments()])
      .then(([statsRes, riddenRes]) => {
        if (cancelled) return;
        setStats(statsRes.data);
        setRiddenSegments(riddenRes.data.segments);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          getUserFacingErrorMessage(err, t("Could not load exploration data")),
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, authReady, gamificationEnabled]);
  // `cancelled` guards against stale responses when the centre changes faster
  // than the network round-trip (e.g. pasting coordinates, then immediately
  // clicking "Use my location"). Without it, a late-resolving request would
  // overwrite fresher results.
  useEffect(() => {
    // Must gate on `authReady` for the same reason as the exploration
    // bootstrap effect above: a cold visit races AuthSync. Worse here,
    // a 401 against `getNearbyUnridden` would trip the shared OpenAPI
    // client's `onUnauthorized` hook and `clearSession()` would wipe
    // the just-hydrated token, leaving the whole app unauthenticated
    // for the rest of the navigation.
    //
    // Only the Coverage view shows the "Nearby unridden" card, so gate the
    // fetch on it: no point running the PostGIS nearby query for hidden UI, and
    // (privacy) it stops the auto-geolocated `center` being sent to the backend
    // in the default Routes view before the rider opens Coverage.
    // ...and on the subsystem: this is an exploration query, so it must stop
    // with the rest of it. Hooks run regardless of the render branch above, so
    // gating the surface alone would leave this firing on every centre change.
    if (!authReady || mapView !== "coverage" || !gamificationEnabled) return;
    let cancelled = false;
    setNearbyLoading(true);
    setNearbyError(null);
    explorationApi
      .getNearbyUnridden({
        lat: center.lat,
        lng: center.lng,
        radius_km: NEARBY_DEFAULT_RADIUS_KM,
        limit: NEARBY_LIMIT,
      })
      .then(({ data }) => {
        if (cancelled) return;
        setNearby(data);
        setNearbyLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setNearbyError(t("Could not load nearby unridden roads"));
        setNearby([]);
        setNearbyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, authReady, mapView, center.lat, center.lng, gamificationEnabled]);
  const filteredRidden = useMemo<RiddenSegment[]>(
    () => filterRiddenByPeriod(riddenSegments, period),
    [riddenSegments, period],
  );
  // Full segment detail for the drawer, fetched by id (mirrors /explore). Any
  // road is selectable now, ridden or not, so this drives off the id, not the
  // ridden set.
  const [segmentDetailState, setSegmentDetailState] =
    useState<SegmentDetailPanelState>({ status: "idle" });
  useEffect(() => {
    if (!selectedSegmentId) {
      setSegmentDetailState({ status: "idle" });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setSegmentDetailState({ status: "loading", segmentId: selectedSegmentId });
    roadsApi
      .getSegmentDetail(selectedSegmentId, { signal: controller.signal })
      .then(({ data }) => {
        if (cancelled) return;
        setSegmentDetailState({ status: "ready", segment: data });
      })
      .catch((err) => {
        if ((err as { name?: string }).name === "AbortError" || cancelled)
          return;
        if (err instanceof ApiError && err.status === 404) {
          setSegmentDetailState({
            status: "not-found",
            segmentId: selectedSegmentId,
          });
          return;
        }
        setSegmentDetailState({
          status: "error",
          segmentId: selectedSegmentId,
          message: getUserFacingErrorMessage(
            err,
            t("Could not load road segment details."),
          ),
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [t, selectedSegmentId]);
  // The backend returns nearby-unridden sorted by distance today, but the UI
  // explicitly advertises "Sorted by distance" — sorting client-side makes
  // that claim resilient if the service ordering ever changes.
  const nearbyByDistance = useMemo(
    () => [...nearby].sort((a, b) => a.distance_m - b.distance_m),
    [nearby],
  );
  // Shared between the sidebar's "Use my location" and the map's
  // "Centre on me" so denial messaging, coordinate rounding, and the
  // 10s timeout stay in lockstep across the two entry points.
  const requestUserLocation = useCallback(
    (
      onLocated: (lat: number, lng: number) => void,
      // `silent` suppresses error surfacing — used by the auto locate on load so
      // a rider who has denied permission isn't nagged on every visit; explicit
      // button clicks still surface the failure.
      options?: { silent?: boolean },
    ) => {
      const surface = (message: string) => {
        if (!options?.silent) setLocationError(message);
      };
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        surface("Geolocation is not available in this browser");
        return;
      }
      setLocating(true);
      setLocationError(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setLocating(false);
          const lat = Number(pos.coords.latitude.toFixed(4));
          const lng = Number(pos.coords.longitude.toFixed(4));
          onLocated(lat, lng);
        },
        (err) => {
          setLocating(false);
          surface(
            err.code === err.PERMISSION_DENIED
              ? "Location permission denied — enter coordinates instead."
              : "Couldn't read your location — enter coordinates instead.",
          );
        },
        { timeout: 10000 },
      );
    },
    [],
  );
  // Fly the map to a located point, or — if the map hasn't mounted yet (the page
  // is still in its `loading` branch, so `mapRef.current` is null) — stash the
  // target so the flush effect below can replay it once the map exists. Without
  // this, a cached geolocation response that resolves before the map mounts is
  // silently dropped and the map opens at the neutral fallback.
  const pendingCenterRef = useRef<{ lat: number; lng: number } | null>(null);
  const flyToWhenReady = useCallback((lat: number, lng: number) => {
    if (mapRef.current) {
      mapRef.current.flyTo({ lat, lng });
    } else {
      pendingCenterRef.current = { lat, lng };
    }
  }, []);
  // Locate the rider and point the live view at them: write `center` (drives the
  // "Nearby unridden" query + coordinate inputs) and fly the camera. Shared by
  // the map's "Centre on me" button, the sidebar's "Use my location", and the
  // load-time auto-center so denial messaging, coordinate rounding, and the 10 s
  // timeout stay in lockstep. The share coarsens `center` to a region grid
  // (`handleShare`), so a located position never leaks at street precision.
  const locateAndCenter = useCallback(
    (options?: { silent?: boolean }) => {
      requestUserLocation((lat, lng) => {
        setCenter({ lat, lng, label: t("My location") });
        flyToWhenReady(lat, lng);
      }, options);
    },
    [t, requestUserLocation, flyToWhenReady],
  );
  // Open centred on the rider so the map lands where they ride instead of the
  // neutral fallback. Runs once; a denied prompt just leaves the fallback centre.
  // Silent: don't nag a rider who has denied permission on every visit.
  //
  // Gated on the loaded, non-empty state: don't prompt for location (or read a
  // cached precise fix) until we know the map will actually render. While the
  // page is loading/errored, or when the rider has no content (the empty state),
  // `<PersonalRoadMap>` never mounts — requesting geolocation there would prompt
  // for a screen the rider can't see. `hasContent` flips true once stats show a
  // ridden segment or the tracks fetch resolves a route; explicit "Centre on me"
  // stays available on the rendered map regardless.
  const centeredOnLoadRef = useRef(false);
  const hasContent = stats
    ? stats.ridden_segments > 0 || rideTracks.length > 0
    : false;
  useEffect(() => {
    if (centeredOnLoadRef.current) return;
    if (loading || loadError || !hasContent) return;
    centeredOnLoadRef.current = true;
    locateAndCenter({ silent: true });
  }, [loading, loadError, hasContent, locateAndCenter]);
  // Replay a locate target captured before the map mounted. Runs after every
  // render but only acts once the map exists and there's a pending target, so
  // the auto-center survives the loading→loaded transition.
  useEffect(() => {
    if (loading || !stats) return;
    const target = pendingCenterRef.current;
    if (!target) return;
    pendingCenterRef.current = null;
    mapRef.current?.flyTo(target);
  }, [loading, stats]);
  const handleShare = useCallback(async () => {
    // Ref guard (not state) ignores a quick double-click without changing the
    // button's appearance — feedback is the toast inside `shareRoadMap`, so the
    // button stays visually identical to the community / ride-detail Share.
    if (!stats || sharingRef.current) return;
    sharingRef.current = true;
    try {
      const shareViewCenter = mapRef.current?.getCenter() ?? center;
      const snapshot = buildMapShareSnapshot({
        stats,
        period,
        segments: filteredRidden,
        // Centre the shared map on the live map camera — which reflects manual
        // panning, unlike `center` (only moved by geolocation/coordinate entry)
        // — coarsened to a ~11 km region grid so the highlighted roads are
        // on-screen without leaking a street-level fix. Falls back to `center`
        // if the map isn't ready (Share only renders with the map, so rare).
        initialCenter: {
          lat: coarsenForShare(shareViewCenter.lat),
          lng: coarsenForShare(shareViewCenter.lng),
          zoom: INITIAL_MAP_ZOOM,
        },
      });
      // The DTO accepts an opaque JSON object — narrow the typed snapshot shape
      // to the API contract at the boundary.
      await shareRoadMap(
        t("My Tarmoto road map"),
        snapshot as unknown as Record<string, unknown>,
        t,
      );
    } finally {
      sharingRef.current = false;
    }
  }, [stats, period, filteredRidden, center, t]);
  if (loading) {
    return (
      <RidesScaffold fill>
        {showLoader && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-dim">
            <Loader2 size={16} className="animate-spin" />
            {t("Loading road map\u2026")}
          </div>
        )}
      </RidesScaffold>
    );
  }
  // Before the error branch. With the subsystem off there is no `stats` — not
  // because anything failed, but because we deliberately did not ask — and
  // "Could not load exploration data" would blame a failure for an operator
  // shutdown, which is the mislabelling this epic exists to prevent.
  //
  // Not `&& !stats`: a rider already on the page keeps their loaded stats, and
  // gating only the fresh load left the whole coverage map, the exploration
  // totals and every ridden segment on screen after an operator flip — while
  // the map's own centre-change effect kept fetching. The switch state decides
  // this, not whether we happen to hold data.
  if (!gamificationEnabled) {
    return (
      <RidesScaffold fill>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md">
            <SystemSwitchGate feature="sys_gamification">
              {null}
            </SystemSwitchGate>
          </div>
        </div>
      </RidesScaffold>
    );
  }
  if (loadError || !stats) {
    return (
      <RidesScaffold fill>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-700">
            {loadError ?? t("Could not load exploration data")}
          </div>
        </div>
      </RidesScaffold>
    );
  }
  // Routes are the primary view, so any recorded ride keeps the map — not just
  // matched coverage segments. Only declare "empty" once tracks have actually
  // settled: while they're loading (or if the request failed) a rider with
  // routes but no matched segments would otherwise be wrongly told they have
  // nothing — the exact case the Routes view exists to rescue.
  const tracksSettled = !tracksLoading && !tracksError;
  if (!hasContent && tracksSettled) {
    return (
      <RidesScaffold fill>
        <RidesEmptyState
          icon={<MapIcon size={18} strokeWidth={2} />}
          title={t("Your road map is empty")}
          body={t(
            "Every road you ride gets layered onto the regional basemap. Take your first ride to start filling it in.",
          )}
        />
      </RidesScaffold>
    );
  }
  // `splitDistanceKm` already returns the value pre-formatted (locale
  // grouping applied) and the converted unit label, in one call — no more
  // manual re-splitting of a rendered "1,234.5 km" string.
  const allTimeDistance = format.splitDistanceKm(stats.total_distance_km);
  return (
    <RidesScaffold
      fill
      headerRight={
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            uppercase
            onClick={handleShare}
            leftIcon={<Share2 size={14} />}
            // A shared road map is a coverage snapshot (routes aren't shared),
            // so there's nothing to share without ridden segments — a route-only
            // rider would otherwise publish a link that opens to an empty map.
            disabled={filteredRidden.length === 0}
            title={
              filteredRidden.length === 0
                ? t("Ride some roads to share your coverage map")
                : undefined
            }
          >
            {t("Share")}
          </Button>
        </div>
      }
    >
      <div className="flex-1 min-h-0 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
        {/* Below lg the map + aside stack in one grid column, so the grid's
            height gets shared between them; a taller aside (coverage view has
            an extra tile + the nearby card) would otherwise shrink the map.
            Pin a fixed map height below lg so it stays consistent across views;
            at lg it fills its own grid track. */}
        <div className="relative min-h-[320px] overflow-hidden rounded-[14px] border border-line bg-cream max-lg:h-[60vh]">
          <PersonalRoadMap
            ref={mapRef}
            initialCenter={{
              lat: center.lat,
              lng: center.lng,
              zoom: INITIAL_MAP_ZOOM,
            }}
            ridden={filteredRidden}
            rideTracks={rideTracks}
            showRoutes={mapView === "routes"}
            showCoverage={mapView === "coverage"}
            selectedSegmentId={
              mapView === "coverage" ? selectedSegmentId : null
            }
            selectedRideId={selectedRideId}
            onSegmentSelect={(id) => {
              setSelectedRideId(null);
              setSelectedSegmentId(id);
            }}
            onRouteSelect={selectRide}
          />
          {coverageEnabled && (
            <MapViewToggle view={mapView} onChange={setMapViewPref} />
          )}
          {/* Routes need no legend — this is the Ride History section, so a
              rider already knows the lines are their rides. */}
          {mapView === "coverage" && (
            <MapLegend riddenCount={filteredRidden.length} format={format} />
          )}
          {/* Routes failed to load: say so rather than let the empty map read
              as "you have no rides" (Coverage stays available via the toggle). */}
          {mapView === "routes" && tracksError && (
            <div className="pointer-events-none absolute top-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-quality-q1/40 bg-quality-q1/10 px-3 py-1.5 text-[11px] font-semibold text-red-700 backdrop-blur">
              {t("Couldn't load your rides — try again")}
            </div>
          )}
          {/* The route overlay is capped server-side; say so rather than let a
              partial map read as the rider's whole history. */}
          {mapView === "routes" && !tracksError && rideTracksTruncated && (
            <div className="pointer-events-none absolute top-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-paper/85 px-3 py-1.5 text-[11px] font-semibold text-fg-dim backdrop-blur">
              {t(
                "Showing your {count, plural, one {# most recent ride} other {# most recent rides}}",
                {
                  count: rideTracks.length,
                },
              )}
            </div>
          )}
          <SegmentDetailSidebar
            state={segmentDetailState}
            onClose={() => setSelectedSegmentId(null)}
            anchor="viewport"
          />
          {mapView === "routes" && selectedRideId && (
            <RideRoutePopover
              rideId={selectedRideId}
              format={format}
              onClose={() => setSelectedRideId(null)}
            />
          )}
          {/* Geolocation failed for an explicit "Centre on me" — surface it by
              the button so it isn't hidden with the Coverage-only nearby card. */}
          {locationError && (
            <div
              role="alert"
              className="absolute bottom-16 right-4 z-10 max-w-[240px] rounded-xl border border-quality-q1/40 bg-quality-q1/10 px-3 py-2 text-[11px] font-semibold text-red-700 backdrop-blur"
            >
              {locationError}
            </div>
          )}
          <button
            type="button"
            onClick={() => locateAndCenter()}
            className="absolute bottom-4 right-4 z-10 flex items-center gap-2 px-3 py-2 rounded-xl bg-paper/85 border border-line backdrop-blur text-xs text-ink hover:bg-cream transition"
            title={t("Centre on me")}
          >
            <Crosshair size={12} />
            {t("Centre on me")}
          </button>
        </div>

        {/* Data tiles go 2-up through the tablet range (matching the other KPI
            rows), collapsing to the single 360px rail column at lg. The nearby
            card spans both columns below lg. */}
        {/* content-start: on lg the fill layout gives this rail a definite
            height; without it the grid stretches its row tracks to fill the
            viewport, expanding the KPI tiles (e.g. Routes view's two cards).
            Pack the rows at the top so tiles keep their natural height. */}
        <aside className="grid grid-cols-2 content-start gap-3.5 overflow-y-auto lg:grid-cols-1">
          {/* 1 — Hero tile. Routes view leads with the ride count; the coverage
               view leads with matched segments (period-aware, so an all-time
               total wouldn't contradict a windowed map). */}
          {mapView === "routes" ? (
            <MetricTile
              variant="ink"
              accentNumber
              formatValue={format.integer}
              label={t("Rides on map")}
              value={rideTracks.length}
              delta={
                tracksError
                  ? t("couldn't load — try again")
                  : t("with a recorded route")
              }
            />
          ) : (
            <MetricTile
              variant="ink"
              accentNumber
              formatValue={format.integer}
              label={t("Segments ridden")}
              value={
                period === "all" ? stats.ridden_segments : filteredRidden.length
              }
              delta={t("of {total} in region", {
                total: format.integer(stats.total_segments),
              })}
            />
          )}

          {/* 2 — All-time (lifetime) distance ridden. */}
          <MetricTile
            label={t("All-time distance")}
            value={allTimeDistance.value}
            unit={allTimeDistance.unit}
            unitPosition={allTimeDistance.unitPosition}
          />

          {/* 3 + 4 — Coverage/exploration cards: region coverage and the
               nearby-unridden browser. Only relevant to the coverage view. */}
          {mapView === "coverage" && (
            <>
              <MetricTile
                accentNumber
                label={t("Region coverage")}
                value={format.number(stats.percent_explored / 100, {
                  style: "percent",
                  maximumFractionDigits: 0,
                })}
              />

              <Card
                padded={false}
                className="col-span-2 overflow-hidden lg:col-span-1"
              >
                <div className="flex items-center justify-between border-b border-line px-[18px] py-3">
                  <Stamp>{t("Nearby unridden")}</Stamp>
                  {center.label && (
                    <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-fg-mute">
                      {center.label}
                    </span>
                  )}
                </div>
                <div className="px-[18px] py-3">
                  {nearbyLoading ? (
                    <LoaderRow label={t("Loading unridden roads…")} />
                  ) : nearbyError ? (
                    <Alert compact intent="danger" title={nearbyError} />
                  ) : nearby.length === 0 ? (
                    <Alert compact intent="neutral" title={t("Nothing nearby")}>
                      {t("— zoom out or pick a new centre.")}
                    </Alert>
                  ) : (
                    <ul className="space-y-3">
                      {nearbyByDistance.slice(0, 10).map((seg) => (
                        <NearbyRow key={seg.id} segment={seg} format={format} />
                      ))}
                    </ul>
                  )}
                </div>
                <div className="border-t border-line px-[18px] py-3">
                  <NearbyCenterControls
                    center={center}
                    locating={locating}
                    onUseMyLocation={() => locateAndCenter()}
                    onCoordinatesChanged={(lat, lng, label) => {
                      setCenter({ lat, lng, label });
                      mapRef.current?.flyTo({ lat, lng });
                    }}
                  />
                </div>
              </Card>
            </>
          )}
        </aside>
      </div>
    </RidesScaffold>
  );
}
// ── Sub-components ──
interface NearbyCenterControlsProps {
  center: {
    lat: number;
    lng: number;
    label: string;
  };
  locating: boolean;
  onUseMyLocation: () => void;
  onCoordinatesChanged: (lat: number, lng: number, label: string) => void;
}
function NearbyCenterControls({
  center,
  locating,
  onUseMyLocation,
  onCoordinatesChanged,
}: NearbyCenterControlsProps) {
  const t = useTranslation();
  const [latInput, setLatInput] = useState(String(center.lat));
  const [lngInput, setLngInput] = useState(String(center.lng));
  useEffect(() => {
    setLatInput(String(center.lat));
    setLngInput(String(center.lng));
  }, [center.lat, center.lng]);
  const apply = () => {
    // `Number("")` is 0, which would quietly snap the map to Null Island.
    // Reject blank inputs before coercing so an empty field is an error, not
    // a valid coordinate.
    if (latInput.trim() === "" || lngInput.trim() === "") return;
    const lat = Number(latInput);
    const lng = Number(lngInput);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return;
    }
    onCoordinatesChanged(lat, lng, "Custom point");
  };
  return (
    <div className="space-y-2">
      <Button
        block
        size="sm"
        variant="secondary"
        onClick={onUseMyLocation}
        loading={locating}
        leftIcon={<Crosshair size={14} />}
      >
        {locating ? t("Locating…") : t("Use my location")}
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <div className="text-xs text-fg-dim">
          <label htmlFor="nearby-center-lat" className="block mb-1">
            {t("Latitude")}
          </label>
          <Input
            id="nearby-center-lat"
            value={latInput}
            onChange={setLatInput}
          />
        </div>
        <div className="text-xs text-fg-dim">
          <label htmlFor="nearby-center-lng" className="block mb-1">
            {t("Longitude")}
          </label>
          <Input
            id="nearby-center-lng"
            value={lngInput}
            onChange={setLngInput}
          />
        </div>
      </div>
      <Button block size="sm" variant="accent" onClick={apply}>
        {t("Apply coordinates")}
      </Button>
    </div>
  );
}
interface NearbyRowProps {
  segment: UnriddenSegment;
  format: Formatters;
}
function NearbyRow({ segment, format }: NearbyRowProps) {
  const t = useTranslation();
  const tier = scoreToQualityTier(segment.quality_score);
  return (
    <li className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-bold text-ink">
          {segment.road_name ?? t("Unnamed road")}
        </p>
        <Mono className="text-[11px] text-fg-mute">
          {format.distanceM(segment.distance_m)}
        </Mono>
      </div>
      {tier != null ? (
        <QualityBars q={tier} size={4} />
      ) : (
        <span className="text-fg-mute">—</span>
      )}
    </li>
  );
}
interface LoaderRowProps {
  label: string;
}
function LoaderRow({ label }: LoaderRowProps) {
  return (
    <div className="flex items-center gap-2 text-sm text-fg-dim">
      <Loader2 size={14} className="animate-spin" /> {label}
    </div>
  );
}
type RideDetail = components["schemas"]["RideDetailDto"];

/**
 * Popover for a clicked ride line (routes view): basic stats + a link to the
 * full ride detail — the same `/rides/:id` the All-rides list links to. Fetches
 * its own detail so the page doesn't carry ride state.
 */
function RideRoutePopover({
  rideId,
  format,
  onClose,
}: {
  rideId: string;
  format: Formatters;
  onClose: () => void;
}) {
  const t = useTranslation();
  const [ride, setRide] = useState<RideDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setStatus("loading");
    setRide(null);
    api
      .GET("/api/v1/rides/{rideId}", {
        params: { path: { rideId } },
        signal: controller.signal,
      })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          setStatus("error");
          return;
        }
        setRide(data as RideDetail);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [rideId]);
  return (
    <div className="absolute bottom-4 left-4 z-20 w-[264px] rounded-xl border border-line bg-cream p-3.5 shadow-[0_8px_24px_rgba(14,14,16,0.14)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {status === "ready" && ride ? (
            <>
              <p className="truncate text-sm font-extrabold text-ink">
                {ride.name || format.date(ride.started_at)}
              </p>
              <p className="text-[11px] text-fg-dim">
                {format.date(ride.started_at)}
              </p>
            </>
          ) : status === "error" ? (
            <p className="text-sm font-bold text-ink">
              {t("Couldn't load ride")}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-xs text-fg-dim">
              <Loader2 size={13} aria-hidden className="animate-spin" />
              {t("Loading ride…")}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close ride")}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-line-strong text-fg-dim transition hover:border-ink hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
      {status === "ready" && ride && (
        <>
          <div className="mt-2 flex items-center gap-3 text-xs text-fg-dim">
            {ride.distance_km != null && (
              <span className="font-bold text-ink">
                {format.distanceKm(ride.distance_km)}
              </span>
            )}
            {ride.duration_min != null && (
              <span>{format.duration(ride.duration_min)}</span>
            )}
          </div>
          <Link
            href={`/rides/${ride.id}`}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-ink px-3 py-2 text-[12.5px] font-bold text-cream transition hover:brightness-110"
          >
            {t("Open ride")}
            <ArrowUpRight size={14} strokeWidth={2.5} />
          </Link>
        </>
      )}
    </div>
  );
}

type MapView = "routes" | "coverage";

function MapViewToggle({
  view,
  onChange,
}: {
  view: MapView;
  onChange: (view: MapView) => void;
}) {
  const t = useTranslation();
  const options: { key: MapView; label: string }[] = [
    { key: "routes", label: t("Routes") },
    { key: "coverage", label: t("Coverage") },
  ];
  return (
    <div
      role="group"
      aria-label={t("Map view")}
      className="absolute top-4 left-4 z-10 inline-flex rounded-xl border border-line bg-paper/85 p-0.5 backdrop-blur"
    >
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          aria-pressed={view === option.key}
          onClick={() => onChange(option.key)}
          className={`rounded-[9px] px-3 py-1.5 text-xs font-bold uppercase tracking-[0.4px] transition ${
            view === option.key
              ? "bg-ink text-cream"
              : "text-fg-dim hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface MapLegendProps {
  riddenCount: number;
  format: Formatters;
}
function MapLegend({ riddenCount, format }: MapLegendProps) {
  const t = useTranslation();
  return (
    <div className="absolute top-[60px] left-4 z-10 rounded-xl bg-paper/80 border border-line backdrop-blur px-4 py-3 text-xs text-ink space-y-2 pointer-events-none">
      <div className="flex items-center gap-2">
        <span className="h-1 w-6 rounded-full bg-accent" />
        {t(
          "{count, plural, one {Ridden ({n} segment)} other {Ridden ({n} segments)}}",
          {
            count: riddenCount,
            n: format.integer(riddenCount),
          },
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="h-1 w-6 rounded-full bg-fg-mute" />
        {t("Unridden")}
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-fg-dim">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        {t("Click a road for details")}
      </div>
    </div>
  );
}
