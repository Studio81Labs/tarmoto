"use client";
import { t } from "@/i18n";
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
  MetricTile,
  Mono,
  QualityBars,
  Stamp,
} from "@tarmoto/ui";
import { RidesScaffold } from "../_RidesScaffold";
import { RidesEmptyState } from "../_RidesEmptyState";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import type { UnitSystem } from "@tarmoto/shared";
import { api, ApiError, explorationApi, roadsApi } from "@/lib/api";
import { shareRoadMap } from "@/lib/road-map-share";
import type {
  ExplorationStats,
  RiddenSegmentMeta,
  UnriddenSegment,
} from "@/lib/api";
import {
  formatDate,
  formatDistance,
  formatDistanceFromMeters,
  formatDuration,
  scoreToQualityTier,
} from "@/lib/utils";
import type { components } from "@tarmoto/openapi-client";
import { useAuthStore } from "@/stores/auth";
import { useTimeWindow } from "../_components/TimeWindowPills";
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
  // The tab-row time pills drive the window via `?window=`; the road-map
  // reads it (no local period state) so flipping a pill updates the map,
  // the legend count, and the share snapshot together. The `TimeWindow`
  // union is value-identical to the `TimePeriod` keys consumed by the
  // pure exploration/road-map helpers, so it's passed straight through.
  const period = useTimeWindow();
  // Which map view is active: the rider's finished ride routes (default) or the
  // ridden-segment coverage / exploration overlay behind a toggle.
  const [mapView, setMapView] = useState<"routes" | "coverage">("routes");
  // The rider's finished ride routes (GPS tracks). Drawn as the primary layer;
  // the ≤500 server cap is plenty for a personal history.
  const { tracks: rideTracks } = useUserRideTracks();
  const [stats, setStats] = useState<ExplorationStats | null>(null);
  const [riddenSegments, setRiddenSegments] = useState<RiddenSegmentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [center, setCenter] = useState(FALLBACK_CENTER);
  const [nearby, setNearby] = useState<UnriddenSegment[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
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
  // matches the first client paint.
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const { format } = useNumberFormat();
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);
  // Gate the exploration fetch on auth so a cold visit to
  // `/rides/road-map` doesn't race AuthSync. Both calls hit authed
  // endpoints.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([explorationApi.getStats(), explorationApi.getRiddenSegments()])
      .then(([statsRes, riddenRes]) => {
        if (cancelled) return;
        setStats(statsRes.data);
        setRiddenSegments(riddenRes.data.segments);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setLoadError(err.message || "Could not load exploration data");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady]);
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
    if (!authReady) return;
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
        setNearbyError("Could not load nearby unridden roads");
        setNearby([]);
        setNearbyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, center.lat, center.lng]);
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
          message:
            err instanceof Error
              ? err.message
              : "Could not load road segment details.",
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedSegmentId]);
  // The backend returns nearby-unridden sorted by distance today, but the UI
  // explicitly advertises "Sorted by distance" — sorting client-side makes
  // that claim resilient if the service ordering ever changes.
  const nearbyByDistance = useMemo(
    () => [...nearby].sort((a, b) => a.distance_m - b.distance_m),
    [nearby],
  );
  // Shared between the sidebar's "Use my location" and the map's
  // "Center on me" so denial messaging, coordinate rounding, and the
  // 10s timeout stay in lockstep across the two entry points.
  const requestUserLocation = useCallback(
    (onLocated: (lat: number, lng: number) => void) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        setNearbyError("Geolocation is not available in this browser");
        return;
      }
      setLocating(true);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setLocating(false);
          const lat = Number(pos.coords.latitude.toFixed(4));
          const lng = Number(pos.coords.longitude.toFixed(4));
          onLocated(lat, lng);
        },
        (err) => {
          setLocating(false);
          setNearbyError(
            err.code === err.PERMISSION_DENIED
              ? "Location permission denied. Enter coordinates below."
              : "Could not read your location. Enter coordinates below.",
          );
        },
        { timeout: 10000 },
      );
    },
    [],
  );
  const handleUseMyLocation = useCallback(() => {
    requestUserLocation((lat, lng) => {
      setCenter({ lat, lng, label: "My location" });
      // Centre the MapLibre view too — the AC's "Center on me" is the
      // same gesture as the Explore-near locator, so a single button
      // drives both panels.
      mapRef.current?.flyTo({ lat, lng });
    });
  }, [requestUserLocation]);
  const handleCenterOnMe = useCallback(() => {
    requestUserLocation((lat, lng) => {
      mapRef.current?.flyTo({ lat, lng });
    });
  }, [requestUserLocation]);
  // Open centred on the rider (same gesture as "Center on me") so the map lands
  // where they ride instead of the neutral fallback. Runs once; a denied prompt
  // just leaves the fallback centre + its inline message.
  const centeredOnLoadRef = useRef(false);
  useEffect(() => {
    if (centeredOnLoadRef.current) return;
    centeredOnLoadRef.current = true;
    handleUseMyLocation();
  }, [handleUseMyLocation]);
  const handleShare = useCallback(async () => {
    // Ref guard (not state) ignores a quick double-click without changing the
    // button's appearance — feedback is the toast inside `shareRoadMap`, so the
    // button stays visually identical to the community / ride-detail Share.
    if (!stats || sharingRef.current) return;
    sharingRef.current = true;
    try {
      const snapshot = buildMapShareSnapshot({
        stats,
        period,
        segments: filteredRidden,
        initialCenter: {
          lat: center.lat,
          lng: center.lng,
          zoom: INITIAL_MAP_ZOOM,
        },
      });
      // The DTO accepts an opaque JSON object — narrow the typed snapshot shape
      // to the API contract at the boundary.
      await shareRoadMap(
        "My Tarmoto road map",
        snapshot as unknown as Record<string, unknown>,
      );
    } finally {
      sharingRef.current = false;
    }
  }, [stats, period, filteredRidden, center.lat, center.lng]);
  if (loading) {
    return (
      <RidesScaffold fill>
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-dim">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading road map\u2026")}
        </div>
      </RidesScaffold>
    );
  }
  if (loadError || !stats) {
    return (
      <RidesScaffold fill>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
            {loadError ?? "Could not load exploration data"}
          </div>
        </div>
      </RidesScaffold>
    );
  }
  // Routes are the primary view, so any recorded ride keeps the map — not just
  // matched coverage segments.
  const hasAnyContent = stats.ridden_segments > 0 || rideTracks.length > 0;
  if (!hasAnyContent) {
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
  // `formatDistance` carries the metric/imperial conversion + decimal rule;
  // take its number for the tile (so the shared formatter applies locale
  // grouping) and its unit for the tile's small slot.
  const allTimeDistance = formatDistance(stats.total_distance_km, unitSystem);
  const distanceSpace = allTimeDistance.lastIndexOf(" ");
  const distanceValue = Number(
    distanceSpace > 0
      ? allTimeDistance.slice(0, distanceSpace)
      : allTimeDistance,
  );
  const distanceUnit =
    distanceSpace > 0 ? allTimeDistance.slice(distanceSpace + 1) : undefined;
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
          >
            {t("Share")}
          </Button>
        </div>
      }
    >
      <div className="flex-1 min-h-0 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
        <div className="relative min-h-[320px] overflow-hidden rounded-[14px] border border-line bg-cream">
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
            selectedSegmentId={selectedSegmentId}
            selectedRideId={selectedRideId}
            onSegmentSelect={(id) => {
              setSelectedRideId(null);
              setSelectedSegmentId(id);
            }}
            onRouteSelect={selectRide}
          />
          <MapViewToggle view={mapView} onChange={setMapView} />
          {/* Routes need no legend — this is the Ride History section, so a
              rider already knows the lines are their rides. */}
          {mapView === "coverage" && (
            <MapLegend riddenCount={filteredRidden.length} />
          )}
          <SegmentDetailSidebar
            state={segmentDetailState}
            onClose={() => setSelectedSegmentId(null)}
            anchor="viewport"
          />
          {selectedRideId && (
            <RideRoutePopover
              rideId={selectedRideId}
              unitSystem={unitSystem}
              onClose={() => setSelectedRideId(null)}
            />
          )}
          <button
            type="button"
            onClick={handleCenterOnMe}
            className="absolute bottom-4 right-4 z-10 flex items-center gap-2 px-3 py-2 rounded-xl bg-paper/85 border border-line backdrop-blur text-xs text-ink hover:bg-cream transition"
            title={t("Center on me")}
          >
            <Crosshair size={12} />
            {t("Center on me ")}
          </button>
        </div>

        <aside className="space-y-3.5 overflow-y-auto">
          {/* 1 — Hero tile. Routes view leads with the ride count; the coverage
               view leads with matched segments (period-aware, so an all-time
               total wouldn't contradict a windowed map). */}
          {mapView === "routes" ? (
            <MetricTile
              variant="ink"
              accentNumber
              formatValue={format}
              label={t("Rides on map")}
              value={rideTracks.length}
              delta={t("with a recorded route")}
            />
          ) : (
            <MetricTile
              variant="ink"
              accentNumber
              formatValue={format}
              label={t("Segments ridden")}
              value={
                period === "all" ? stats.ridden_segments : filteredRidden.length
              }
              delta={t("of {total} in region", {
                total: format(stats.total_segments),
              })}
            />
          )}

          {/* 2 — All-time (lifetime) distance ridden. */}
          <MetricTile
            formatValue={format}
            label={t("All-time distance")}
            value={distanceValue}
            {...(distanceUnit !== undefined ? { unit: distanceUnit } : {})}
          />

          {/* 3 + 4 — Coverage/exploration cards: region coverage and the
               nearby-unridden browser. Only relevant to the coverage view. */}
          {mapView === "coverage" && (
            <>
              <MetricTile
                accentNumber
                formatValue={format}
                label={t("Region coverage")}
                value={stats.percent_explored}
                unit="%"
              />

              <Card padded={false} className="overflow-hidden">
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
                    <LoaderRow label="Loading unridden roads…" />
                  ) : nearbyError ? (
                    <Alert compact intent="danger" title={nearbyError} />
                  ) : nearby.length === 0 ? (
                    <Alert compact intent="neutral" title={t("Nothing nearby")}>
                      {t("— zoom out or pick a new centre.")}
                    </Alert>
                  ) : (
                    <ul className="space-y-3">
                      {nearbyByDistance.slice(0, 10).map((seg) => (
                        <NearbyRow
                          key={seg.id}
                          segment={seg}
                          units={unitSystem}
                        />
                      ))}
                    </ul>
                  )}
                </div>
                <div className="border-t border-line px-[18px] py-3">
                  <NearbyCenterControls
                    center={center}
                    locating={locating}
                    onUseMyLocation={handleUseMyLocation}
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
        {locating ? t("Locating… ") : t("Use my location")}
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-fg-dim">
          <span className="block mb-1">{t("Latitude")}</span>
          <input
            type="number"
            step="0.0001"
            value={latInput}
            onChange={(e) => setLatInput(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-paper border border-line-strong text-sm text-ink focus:outline-none focus:border-accent"
          />
        </label>
        <label className="text-xs text-fg-dim">
          <span className="block mb-1">{t("Longitude")}</span>
          <input
            type="number"
            step="0.0001"
            value={lngInput}
            onChange={(e) => setLngInput(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-paper border border-line-strong text-sm text-ink focus:outline-none focus:border-accent"
          />
        </label>
      </div>
      <Button block size="sm" variant="accent" onClick={apply}>
        {t("Apply coordinates ")}
      </Button>
    </div>
  );
}
interface NearbyRowProps {
  segment: UnriddenSegment;
  units: UnitSystem;
}
function NearbyRow({ segment, units }: NearbyRowProps) {
  const tier = scoreToQualityTier(segment.quality_score);
  return (
    <li className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-bold text-ink">
          {segment.road_name ?? t("Unnamed road")}
        </p>
        <Mono className="text-[11px] text-fg-mute">
          {formatDistanceFromMeters(segment.distance_m, units)}
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
  unitSystem,
  onClose,
}: {
  rideId: string;
  unitSystem: UnitSystem;
  onClose: () => void;
}) {
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
                {ride.name || formatDate(ride.started_at)}
              </p>
              <p className="text-[11px] text-fg-dim">
                {formatDate(ride.started_at)}
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
                {formatDistance(ride.distance_km, unitSystem)}
              </span>
            )}
            {ride.duration_min != null && (
              <span>{formatDuration(ride.duration_min)}</span>
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
}
function MapLegend({ riddenCount }: MapLegendProps) {
  return (
    <div className="absolute top-[60px] left-4 z-10 rounded-xl bg-paper/80 border border-line backdrop-blur px-4 py-3 text-xs text-ink space-y-2 pointer-events-none">
      <div className="flex items-center gap-2">
        <span className="h-1 w-6 rounded-full bg-accent" />
        {t("Ridden ({count} segments)", {
          count: riddenCount.toLocaleString(),
        })}
      </div>
      <div className="flex items-center gap-2">
        <span className="h-1 w-6 rounded-full bg-fg-mute" />
        {t("Unridden ")}
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-fg-dim">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        {t("Click a road for details ")}
      </div>
    </div>
  );
}
