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
import {
  AlertTriangle,
  Check,
  Copy,
  Crosshair,
  Loader2,
  Map as MapIcon,
  MapPin,
} from "lucide-react";
import { Card, Mono, QualityBars, Stamp } from "@tarmoto/ui";
import { RidesScaffold } from "../_RidesScaffold";
import { RidesEmptyState } from "../_RidesEmptyState";
import { Link2 } from "lucide-react";
import type { UnitSystem } from "@tarmoto/shared";
import { explorationApi, mapSharesApi } from "@/lib/api";
import type {
  ExplorationStats,
  RiddenSegmentMeta,
  UnriddenSegment,
} from "@/lib/api";
import {
  formatDistance,
  formatDistanceFromMeters,
  scoreToQualityTier,
} from "@/lib/utils";
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
// the lat/lng inputs. Label deliberately reads as a placeholder so it doesn't
// look like a curated suggestion of "Prague" specifically.
const FALLBACK_CENTER = {
  lat: 50.0755,
  lng: 14.4378,
  label: "Default — pick yours below",
};
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
  const [stats, setStats] = useState<ExplorationStats | null>(null);
  const [riddenSegments, setRiddenSegments] = useState<RiddenSegmentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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
      const title = "My Tarmoto road map";
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
        text: "Check out the roads I've ridden on Tarmoto.",
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
      <RidesScaffold>
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-dim">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading road map\u2026")}
        </div>
      </RidesScaffold>
    );
  }
  if (loadError || !stats) {
    return (
      <RidesScaffold>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
            {loadError ?? "Could not load exploration data"}
          </div>
        </div>
      </RidesScaffold>
    );
  }
  const hasAnyRiddenSegments = stats.ridden_segments > 0;
  if (!hasAnyRiddenSegments) {
    return (
      <RidesScaffold>
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
  // Share-button copy mirrors the post-action state so a click still
  // surfaces the same "Creating link…" / "Link copied!" / "Shared" /
  // "Share failed" feedback the previous chrome carried — visual is
  // spec-styled outline pill matching the design's `Share map` CTA.
  const shareLabel =
    shareState.kind === "creating"
      ? t("Creating link…")
      : shareState.kind === "copied"
        ? t("Link copied!")
        : shareState.kind === "shared"
          ? t("Shared")
          : shareState.kind === "error"
            ? t("Share failed")
            : t("Share map");
  const ShareIcon =
    shareState.kind === "creating"
      ? Loader2
      : shareState.kind === "copied" || shareState.kind === "shared"
        ? Check
        : shareState.kind === "error"
          ? Copy
          : Link2;
  return (
    <RidesScaffold
      headerRight={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleShare}
            disabled={shareState.kind === "creating"}
            title={shareState.kind === "error" ? shareState.message : undefined}
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-line-strong bg-transparent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper disabled:opacity-60"
          >
            <ShareIcon
              size={14}
              className={
                shareState.kind === "creating" ? "animate-spin" : undefined
              }
            />
            {shareLabel}
          </button>
        </div>
      }
    >
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

        <aside className="overflow-y-auto bg-paper/60 p-5 space-y-3.5">
          {/* 1 — Segments ridden (ink hero card, accent number). */}
          <Card variant="ink">
            <Stamp tone="on-dark">{t("Segments ridden")}</Stamp>
            <div className="mt-2 text-[36px] font-extrabold leading-none tracking-[-1px] text-accent tabular-nums">
              {stats.ridden_segments.toLocaleString()}
            </div>
            <p className="mt-2 text-[12px] text-fg-on-dark-dim">
              {t("of {total} in region", {
                total: stats.total_segments.toLocaleString(),
              })}
            </p>
          </Card>

          {/* 2 — All-time (lifetime) distance ridden. */}
          <Card>
            <Stamp>{t("All-time distance")}</Stamp>
            <div className="mt-2 text-[28px] font-extrabold leading-none tracking-[-0.5px] text-ink tabular-nums">
              {formatDistance(stats.total_distance_km, unitSystem)}
            </div>
          </Card>

          {/* 3 — Region coverage. No region label backing data → no subline. */}
          <Card>
            <Stamp>{t("Region coverage")}</Stamp>
            <div className="mt-2 text-[28px] font-extrabold leading-none tracking-[-0.5px] text-accent tabular-nums">
              {stats.percent_explored}%
            </div>
          </Card>

          {/* 4 — Nearby unridden roads (name · km · quality bars). */}
          <Card padded={false} className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-[18px] py-3">
              <Stamp>{t("Nearby unridden")}</Stamp>
              <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-fg-mute">
                {center.label}
              </span>
            </div>
            <div className="px-[18px] py-3">
              {nearbyLoading ? (
                <LoaderRow label="Loading unridden roads…" />
              ) : nearbyError ? (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-quality-q1/30 bg-quality-q1/10 px-3 py-2 text-sm text-red-400"
                >
                  <AlertTriangle
                    size={14}
                    className="mt-0.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{nearbyError}</span>
                </div>
              ) : nearby.length === 0 ? (
                <EmptyState label="Nothing nearby — zoom out or pick a new centre." />
              ) : (
                <ul className="space-y-3">
                  {nearbyByDistance.slice(0, 10).map((seg) => (
                    <NearbyRow key={seg.id} segment={seg} units={unitSystem} />
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
