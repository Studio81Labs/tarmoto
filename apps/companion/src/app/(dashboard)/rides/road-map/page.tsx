"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Crosshair,
  Loader2,
  MapPin,
  Navigation,
  Share2,
  Sparkles,
} from "lucide-react";
import type { UnitSystem } from "@tarmoto/shared";
import { explorationApi, mapSharesApi } from "@/lib/api";
import type {
  ExplorationStats,
  RiddenSegmentMeta,
  UnriddenSegment,
} from "@/lib/api";
import {
  QUALITY_CONFIG,
  formatDistance,
  formatDistanceFromMeters,
  scoreToTier,
} from "@/lib/utils";
import { fetchAllRides } from "@/lib/rides-fetch";
import { useAuthStore } from "@/stores/auth";
import type { RideForStats } from "@/lib/ride-stats";
import {
  TIME_PERIODS,
  TIME_PERIOD_LABELS,
  computePeriodStats,
  groupUnriddenByRegion,
  type TimePeriod,
} from "@/lib/exploration";
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
// Prague is a sensible neutral default for a motorcycle app whose spec targets
// Central Europe; the user can override via the "Use my location" button or by
// letting the coordinate inputs accept any lat/lng.
const FALLBACK_CENTER = { lat: 50.0755, lng: 14.4378, label: "Prague" };
const INITIAL_MAP_ZOOM = 8;
type ShareState =
  | {
      kind: "idle";
    }
  | {
      kind: "creating";
    }
  | {
      kind: "copied";
      url: string;
    }
  | {
      kind: "shared";
      url: string;
    }
  | {
      kind: "error";
      message: string;
    };
export default function RoadMapPage() {
  const [stats, setStats] = useState<ExplorationStats | null>(null);
  const [riddenSegments, setRiddenSegments] = useState<RiddenSegmentMeta[]>([]);
  const [rides, setRides] = useState<RideForStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [period, setPeriod] = useState<TimePeriod>("all");
  const [center, setCenter] = useState(FALLBACK_CENTER);
  const [nearby, setNearby] = useState<UnriddenSegment[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [shareState, setShareState] = useState<ShareState>({ kind: "idle" });
  // Track the auto-reset timer so back-to-back share clicks don't let a
  // stale timer stomp over the next call's `{ kind: "creating" }` state
  // (which would re-enable the button mid-flight).
  const shareResetTimerRef = useRef<number | null>(null);
  const mapRef = useRef<PersonalRoadMapHandle>(null);
  // Preferences are hydrated from localStorage on the client; during SSR the
  // store still returns the metric default so the server-rendered markup
  // matches the first client paint.
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);
  // Gate the exploration + rides fetch on auth so a cold visit to
  // `/rides/road-map` doesn't race AuthSync. The three Promise.all
  // calls all hit authed endpoints.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      explorationApi.getStats(),
      explorationApi.getRiddenSegments(),
      fetchAllRides(),
    ])
      .then(([statsRes, riddenRes, ridesList]) => {
        if (cancelled) return;
        setStats(statsRes.data);
        setRiddenSegments(riddenRes.data.segments);
        setRides(ridesList);
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
  const periodStats = useMemo(
    () => computePeriodStats(rides, period),
    [rides, period],
  );
  const filteredRidden = useMemo<RiddenSegment[]>(
    () => filterRiddenByPeriod(riddenSegments, period),
    [riddenSegments, period],
  );
  const regionBuckets = useMemo(() => groupUnriddenByRegion(nearby), [nearby]);
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
  // Schedule a single auto-reset back to "idle". Always cancels any
  // pending timer first so back-to-back share attempts don't have a
  // stale timer fire mid-flight and stomp over `{ kind: "creating" }`.
  const scheduleShareReset = useCallback((delayMs: number) => {
    if (shareResetTimerRef.current !== null) {
      window.clearTimeout(shareResetTimerRef.current);
    }
    shareResetTimerRef.current = window.setTimeout(() => {
      shareResetTimerRef.current = null;
      setShareState({ kind: "idle" });
    }, delayMs);
  }, []);
  // Cancel any in-flight reset on unmount so we don't `setState` after
  // the page has been torn down.
  useEffect(() => {
    return () => {
      if (shareResetTimerRef.current !== null) {
        window.clearTimeout(shareResetTimerRef.current);
        shareResetTimerRef.current = null;
      }
    };
  }, []);
  const handleShare = useCallback(async () => {
    if (!stats) return;
    // Cancel any pending reset BEFORE we touch shareState so a leftover
    // timer can't flip us back to "idle" while a fresh request is in
    // flight (cursor: stale timeout reset).
    if (shareResetTimerRef.current !== null) {
      window.clearTimeout(shareResetTimerRef.current);
      shareResetTimerRef.current = null;
    }
    // Capability check first: if neither Web Share nor the async
    // Clipboard API is available, the user has no way to retrieve the
    // generated URL. Bail BEFORE persisting so we don't orphan rows in
    // map_shares for browsers we can't deliver to (the previous flow
    // would POST and then surface "Sharing is not supported").
    const canWebShare =
      typeof navigator !== "undefined" && typeof navigator.share === "function";
    const canClipboard =
      typeof navigator !== "undefined" &&
      Boolean(navigator.clipboard?.writeText);
    if (!canWebShare && !canClipboard) {
      setShareState({
        kind: "error",
        message:
          "Your browser doesn't support sharing or clipboard access — try a different browser.",
      });
      scheduleShareReset(3500);
      return;
    }
    setShareState({ kind: "creating" });
    let createdShareId: string | null = null;
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
      const title = `My Tarmoto road map — ${stats.percent_explored}% explored`;
      const { data } = await mapSharesApi.create({
        title,
        // The DTO accepts an opaque JSON object — narrow the typed snapshot
        // shape to the API contract here so the rest of the function keeps
        // its real types.
        snapshot: snapshot as unknown as Record<string, unknown>,
      });
      createdShareId = data.id;
      const fullUrl =
        typeof window !== "undefined"
          ? new URL(data.share_url, window.location.origin).toString()
          : data.share_url;
      const shareData: ShareData = {
        title,
        text: `Check out the roads I've ridden on Tarmoto — ${stats.percent_explored}% explored.`,
        url: fullUrl,
      };
      if (
        canWebShare &&
        (!navigator.canShare || navigator.canShare(shareData))
      ) {
        await navigator.share(shareData);
        setShareState({ kind: "shared", url: fullUrl });
      } else if (canClipboard) {
        await navigator.clipboard.writeText(fullUrl);
        setShareState({ kind: "copied", url: fullUrl });
      } else {
        // Defensive: capability check above already guarantees one path
        // is available, but if `canShare` rejects the payload we still
        // need a fallback rather than silently doing nothing.
        throw new Error("Sharing is not supported");
      }
      // Delivery succeeded — clear the rollback marker so the catch
      // branch below doesn't revoke a share the user actually used.
      createdShareId = null;
    } catch (err) {
      // Roll back the share row whenever post-create delivery fails
      // (cancelled Web Share, denied clipboard write, unsupported
      // canShare, etc.). Without this, repeated cancellations would
      // accumulate orphaned `map_shares` rows.
      if (createdShareId) {
        // Best-effort cleanup: if the revoke itself fails we still want
        // to surface the original delivery error to the user, not the
        // cleanup error.
        void mapSharesApi.revoke(createdShareId).catch(() => undefined);
      }
      // A user-cancelled Web Share rejects with AbortError on iOS Safari —
      // treat that as idle (the user explicitly opted out) rather than as
      // an error toast.
      if (err instanceof Error && err.name === "AbortError") {
        setShareState({ kind: "idle" });
        return;
      }
      setShareState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Could not generate share link",
      });
    }
    scheduleShareReset(3500);
  }, [
    stats,
    period,
    filteredRidden,
    center.lat,
    center.lng,
    scheduleShareReset,
  ]);
  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader percentExplored={null} />
        <div className="flex-1 flex items-center justify-center text-fg-dim gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading road map\u2026 ")}
        </div>
      </div>
    );
  }
  if (loadError || !stats) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader percentExplored={null} />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
            {loadError ?? "Could not load exploration data"}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col h-full">
      <PageHeader percentExplored={stats.percent_explored} />

      <div className="px-6 pt-4 pb-2 flex flex-wrap items-center gap-2 border-b border-line">
        <div
          className="flex items-center gap-1.5 mr-2"
          role="group"
          aria-label={t("Filter by period")}
        >
          {TIME_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              aria-pressed={period === p}
              className={`px-3 py-1.5 rounded-lg text-sm transition ${
                period === p
                  ? "bg-accent/10 text-accent"
                  : "bg-paper text-ink hover:bg-paper-2"
              }`}
            >
              {TIME_PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <ShareButton state={shareState} onClick={handleShare} />
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_360px]">
        <div className="relative bg-cream border-b lg:border-b-0 lg:border-r border-line min-h-[320px]">
          <PersonalRoadMap
            ref={mapRef}
            initialCenter={{
              lat: center.lat,
              lng: center.lng,
              zoom: INITIAL_MAP_ZOOM,
            }}
            ridden={filteredRidden}
          />
          <MapLegend riddenCount={filteredRidden.length} />
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

        <aside className="overflow-y-auto bg-paper/60">
          <section className="p-5 border-b border-line space-y-4">
            <SummaryCards
              stats={stats}
              periodStats={periodStats}
              units={unitSystem}
              riddenInPeriod={filteredRidden.length}
            />
          </section>

          <section className="p-5 border-b border-line">
            <SectionHeader
              icon={<Crosshair size={14} />}
              title={t("Explore near")}
              subtitle={center.label}
            />
            <NearbyCenterControls
              center={center}
              locating={locating}
              onUseMyLocation={handleUseMyLocation}
              onCoordinatesChanged={(lat, lng, label) => {
                setCenter({ lat, lng, label });
                mapRef.current?.flyTo({ lat, lng });
              }}
            />
          </section>

          <section className="p-5 border-b border-line">
            <SectionHeader
              icon={<Sparkles size={14} />}
              title={t("Regional breakdown")}
              subtitle={`${nearby.length} unridden roads within ${formatDistance(NEARBY_DEFAULT_RADIUS_KM, unitSystem)}`}
            />
            {nearbyLoading ? (
              <LoaderRow label="Loading unridden roads…" />
            ) : nearbyError ? (
              <p className="text-sm text-red-400">{nearbyError}</p>
            ) : regionBuckets.length === 0 ? (
              <EmptyState label="No unridden roads found nearby. You've explored this area well!" />
            ) : (
              <ul className="space-y-2">
                {regionBuckets.slice(0, 6).map((bucket) => (
                  <li
                    key={bucket.key}
                    className="flex items-center justify-between rounded-lg bg-cream border border-line px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink truncate">
                        {bucket.label}
                      </p>
                      <p className="text-xs text-fg-dim">
                        {t(
                          bucket.segments.length === 1
                            ? "{count} segment to discover"
                            : "{count} segments to discover",
                          { count: bucket.segments.length },
                        )}
                      </p>
                    </div>
                    <span className="text-xs text-fg-dim tabular-nums">
                      {formatDistance(bucket.totalLengthKm, unitSystem)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="p-5">
            <SectionHeader
              icon={<Navigation size={14} />}
              title={t("Nearby unridden suggestions")}
              subtitle="Sorted by distance"
            />
            {nearbyLoading ? (
              <LoaderRow label="Loading suggestions…" />
            ) : nearbyError ? (
              <p className="text-sm text-red-400">{nearbyError}</p>
            ) : nearby.length === 0 ? (
              <EmptyState label="Nothing nearby — zoom out or pick a new centre." />
            ) : (
              <ul className="space-y-2">
                {nearbyByDistance.slice(0, 10).map((seg) => (
                  <NearbyRow key={seg.id} segment={seg} units={unitSystem} />
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
// ── Sub-components ──
interface PageHeaderProps {
  percentExplored: number | null;
}
function PageHeader({ percentExplored }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-line">
      <div>
        <h1 className="text-xl font-bold">{t("My Road Map")}</h1>
        <p className="text-sm text-fg-dim mt-0.5">
          {t("Every road you've ridden ")}
        </p>
      </div>
      <div className="px-4 py-2 rounded-xl bg-accent/10 text-accent font-semibold text-sm tabular-nums">
        {percentExplored == null ? "…" : `${percentExplored}% explored`}
      </div>
    </div>
  );
}
interface SummaryCardsProps {
  stats: ExplorationStats;
  periodStats: ReturnType<typeof computePeriodStats>;
  units: UnitSystem;
  riddenInPeriod: number;
}
function SummaryCards({
  stats,
  periodStats,
  units,
  riddenInPeriod,
}: SummaryCardsProps) {
  const isAllTime = periodStats.period === "all";
  const cards = [
    {
      label: isAllTime ? "Segments ridden" : "Segments highlighted",
      value: (isAllTime
        ? stats.ridden_segments
        : riddenInPeriod
      ).toLocaleString(),
      sub: isAllTime
        ? `of ${stats.total_segments.toLocaleString()} total`
        : `of ${stats.ridden_segments.toLocaleString()} all-time ridden`,
    },
    {
      label: "All-time distance",
      value: formatDistance(stats.total_distance_km, units),
      sub: `${stats.percent_explored}% explored`,
    },
    {
      label: `Rides — ${TIME_PERIOD_LABELS[periodStats.period]}`,
      value: periodStats.rideCount.toLocaleString(),
      sub:
        periodStats.rideCount === 0
          ? "No rides in this period"
          : `${formatDistance(periodStats.distanceKm, units)} · ${periodStats.activeDays} active day${periodStats.activeDays === 1 ? "" : "s"}`,
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-2">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-xl bg-cream border border-line p-3"
        >
          <p className="text-xs uppercase tracking-wider text-fg-dim">
            {c.label}
          </p>
          <p className="text-xl font-bold text-ink tabular-nums mt-0.5">
            {c.value}
          </p>
          <p className="text-xs text-fg-dim mt-0.5">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}
interface SectionHeaderProps {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}
function SectionHeader({ icon, title, subtitle }: SectionHeaderProps) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 text-ink">
        <span className="text-accent">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {subtitle && <p className="text-xs text-fg-dim mt-0.5">{subtitle}</p>}
    </div>
  );
}
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
      <button
        type="button"
        onClick={onUseMyLocation}
        disabled={locating}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-paper text-ink text-sm hover:bg-paper-2 transition disabled:opacity-60"
      >
        {locating ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Crosshair size={14} />
        )}
        {locating ? "Locating…" : "Use my location"}
      </button>
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
      <button
        type="button"
        onClick={apply}
        className="w-full px-3 py-1.5 rounded-lg bg-accent/10 text-accent text-sm hover:bg-accent/20 transition"
      >
        {t("Apply coordinates ")}
      </button>
    </div>
  );
}
interface NearbyRowProps {
  segment: UnriddenSegment;
  units: UnitSystem;
}
function NearbyRow({ segment, units }: NearbyRowProps) {
  const tier =
    segment.quality_score != null ? scoreToTier(segment.quality_score) : null;
  const tierInfo = tier ? QUALITY_CONFIG[tier] : null;
  return (
    <li className="flex items-center gap-3 rounded-lg bg-cream border border-line px-3 py-2">
      <span
        className={`w-2 h-2 rounded-full ${tierInfo?.bg ?? "bg-fg-mute"}`}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-ink truncate">
          {segment.road_name ?? "Unnamed road"}
        </p>
        <p className="text-xs text-fg-dim capitalize">
          {segment.surface_type}
          {tierInfo ? ` · ${tierInfo.label.toLowerCase()}` : ""} ·{" "}
          {formatDistanceFromMeters(segment.length_m, units)}
        </p>
      </div>
      <span className="text-xs text-fg-dim tabular-nums">
        {t("{distance} away", {
          distance: formatDistanceFromMeters(segment.distance_m, units),
        })}
      </span>
    </li>
  );
}
interface ShareButtonProps {
  state: ShareState;
  onClick: () => void;
}
function ShareButton({ state, onClick }: ShareButtonProps) {
  const label =
    state.kind === "creating"
      ? "Creating link…"
      : state.kind === "copied"
        ? "Link copied!"
        : state.kind === "shared"
          ? "Shared"
          : state.kind === "error"
            ? "Share failed"
            : "Share my map";
  const Icon =
    state.kind === "creating"
      ? Loader2
      : state.kind === "copied"
        ? Check
        : state.kind === "shared"
          ? Check
          : state.kind === "error"
            ? Copy
            : Share2;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state.kind === "creating"}
      title={state.kind === "error" ? state.message : undefined}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-ink font-bold text-[11px] uppercase tracking-[0.2px] hover:brightness-95 transition disabled:opacity-60"
    >
      <Icon
        size={14}
        className={state.kind === "creating" ? "animate-spin" : undefined}
      />
      {label}
    </button>
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
interface EmptyStateProps {
  label: string;
}
function EmptyState({ label }: EmptyStateProps) {
  return <p className="text-sm text-fg-dim">{label}</p>;
}
interface MapLegendProps {
  riddenCount: number;
}
function MapLegend({ riddenCount }: MapLegendProps) {
  return (
    <div className="absolute top-4 left-4 z-10 rounded-xl bg-paper/80 border border-line backdrop-blur px-4 py-3 text-xs text-ink space-y-2 pointer-events-none">
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
        <MapPin size={10} />
        {t("Hover a highlighted road for ride details ")}
      </div>
    </div>
  );
}
