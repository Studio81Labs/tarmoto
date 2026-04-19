"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { api, explorationApi } from "@/lib/api";
import type { ExplorationStats, UnriddenSegment } from "@/lib/api";
import { QUALITY_CONFIG, scoreToTier } from "@/lib/utils";
import type { RideForStats } from "@/lib/ride-stats";
import {
  TIME_PERIODS,
  TIME_PERIOD_LABELS,
  buildShareSummary,
  computePeriodStats,
  formatDistanceMeters,
  formatKilometers,
  groupUnriddenByRegion,
  type TimePeriod,
} from "@/lib/exploration";

/**
 * Personal road map (US-50).
 *
 * Global ridden/unridden totals come from `/exploration/stats`. The map layer
 * itself is a placeholder until INFRA #79 (MapLibre integration) lands; we
 * still fetch `/exploration/ridden-ids` so the page can report how many
 * segments the layer would render. Period chips only filter the rides list
 * (the exploration stats endpoint is not time-bucketed) so the global %
 * remains visible no matter which period is active.
 */

const NEARBY_DEFAULT_RADIUS_KM = 15;
const NEARBY_LIMIT = 25;

// Fallback coordinate used when the browser blocks or doesn't have geolocation.
// Prague is a sensible neutral default for a motorcycle app whose spec targets
// Central Europe; the user can override via the "Use my location" button or by
// letting the coordinate inputs accept any lat/lng.
const FALLBACK_CENTER = { lat: 50.0755, lng: 14.4378, label: "Prague" };

async function fetchAllRides(): Promise<RideForStats[]> {
  const collected: RideForStats[] = [];
  const PAGE_SIZE = 100;
  const MAX_PAGES = 100;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await api.GET("/api/v1/rides", {
      params: { query: { limit: PAGE_SIZE, offset: page * PAGE_SIZE } },
    });
    if (error) throw new Error("Could not load ride history");
    const batch = (data?.rides ?? []) as RideForStats[];
    collected.push(...batch);
    const total = data?.total ?? collected.length;
    if (collected.length >= total || batch.length < PAGE_SIZE) break;
  }
  return collected;
}

export default function RoadMapPage() {
  const [stats, setStats] = useState<ExplorationStats | null>(null);
  const [riddenSegmentIds, setRiddenSegmentIds] = useState<string[]>([]);
  const [rides, setRides] = useState<RideForStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [period, setPeriod] = useState<TimePeriod>("all");

  const [center, setCenter] = useState(FALLBACK_CENTER);
  const [centerLabel, setCenterLabel] = useState<string>(FALLBACK_CENTER.label);
  const [nearby, setNearby] = useState<UnriddenSegment[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const [shareState, setShareState] = useState<
    "idle" | "copied" | "shared" | "error"
  >("idle");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      explorationApi.getStats(),
      explorationApi.getRiddenIds(),
      fetchAllRides(),
    ])
      .then(([statsRes, riddenRes, ridesList]) => {
        if (cancelled) return;
        setStats(statsRes.data);
        setRiddenSegmentIds(riddenRes.data.segment_ids);
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
  }, []);

  const fetchNearby = useCallback(async (lat: number, lng: number) => {
    setNearbyLoading(true);
    setNearbyError(null);
    try {
      const { data } = await explorationApi.getNearbyUnridden({
        lat,
        lng,
        radius_km: NEARBY_DEFAULT_RADIUS_KM,
        limit: NEARBY_LIMIT,
      });
      setNearby(data);
    } catch {
      setNearbyError("Could not load nearby unridden roads");
      setNearby([]);
    } finally {
      setNearbyLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchNearby(center.lat, center.lng);
  }, [center.lat, center.lng, fetchNearby]);

  const periodStats = useMemo(
    () => computePeriodStats(rides, period),
    [rides, period],
  );

  const regionBuckets = useMemo(() => groupUnriddenByRegion(nearby), [nearby]);

  const handleUseMyLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setNearbyError("Geolocation is not available in this browser");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setCenter({
          lat: Number(pos.coords.latitude.toFixed(4)),
          lng: Number(pos.coords.longitude.toFixed(4)),
          label: "My location",
        });
        setCenterLabel("My location");
      },
      (err) => {
        setLocating(false);
        setNearbyError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Enter coordinates below."
            : "Could not read your location. Enter coordinates below.",
        );
      },
      { timeout: 10_000 },
    );
  }, []);

  const handleShare = useCallback(async () => {
    if (!stats) return;
    const text = buildShareSummary(stats, periodStats);
    const url =
      typeof window !== "undefined" ? window.location.href : undefined;
    const shareData: ShareData = {
      title: "My Tarmoto exploration",
      text,
      ...(url ? { url } : {}),
    };
    try {
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function" &&
        (!navigator.canShare || navigator.canShare(shareData))
      ) {
        await navigator.share(shareData);
        setShareState("shared");
      } else if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(text);
        setShareState("copied");
      } else {
        setShareState("error");
      }
    } catch {
      // A user-cancelled share on iOS Safari rejects; treat as idle, not error.
      setShareState("idle");
      return;
    }
    window.setTimeout(() => setShareState("idle"), 2500);
  }, [stats, periodStats]);

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader percentExplored={null} />
        <div className="flex-1 flex items-center justify-center text-slate-400 gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading road map…
        </div>
      </div>
    );
  }

  if (loadError || !stats) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader percentExplored={null} />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-300">
            {loadError ?? "Could not load exploration data"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader percentExplored={stats.percent_explored} />

      <div className="px-6 pt-4 pb-2 flex flex-wrap items-center gap-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5 mr-2">
          {TIME_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-lg text-sm transition ${
                period === p
                  ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {TIME_PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        <div className="ml-auto">
          <ShareButton state={shareState} onClick={handleShare} />
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_360px]">
        {/* Map placeholder */}
        <div className="relative bg-slate-900 border-b lg:border-b-0 lg:border-r border-slate-800 min-h-[320px]">
          <MapLegend riddenCount={riddenSegmentIds.length} />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <MapPin size={56} className="mx-auto text-slate-700 mb-4" />
              <p className="text-slate-500 text-lg font-medium">
                Personal Road Map
              </p>
              <p className="text-slate-600 text-sm mt-1 max-w-md mx-auto px-4">
                Ridden roads in Tarmoto Cyan, unridden dimmed. Full-screen
                MapLibre layer lands with INFRA #79.
              </p>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <aside className="overflow-y-auto bg-slate-950/60">
          <section className="p-5 border-b border-slate-800 space-y-4">
            <SummaryCards stats={stats} periodStats={periodStats} />
          </section>

          <section className="p-5 border-b border-slate-800">
            <SectionHeader
              icon={<Crosshair size={14} />}
              title="Explore near"
              subtitle={centerLabel}
            />
            <NearbyCenterControls
              center={center}
              locating={locating}
              onUseMyLocation={handleUseMyLocation}
              onCoordinatesChanged={(lat, lng, label) => {
                setCenter({ lat, lng, label });
                setCenterLabel(label);
              }}
            />
          </section>

          <section className="p-5 border-b border-slate-800">
            <SectionHeader
              icon={<Sparkles size={14} />}
              title="Regional breakdown"
              subtitle={`${nearby.length} unridden roads within ${NEARBY_DEFAULT_RADIUS_KM} km`}
            />
            {nearbyLoading ? (
              <LoaderRow label="Loading unridden roads…" />
            ) : regionBuckets.length === 0 ? (
              <EmptyState label="No unridden roads found nearby. You've explored this area well!" />
            ) : (
              <ul className="space-y-2">
                {regionBuckets.slice(0, 6).map((bucket) => (
                  <li
                    key={bucket.key}
                    className="flex items-center justify-between rounded-lg bg-slate-900 border border-slate-800 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">
                        {bucket.label}
                      </p>
                      <p className="text-xs text-slate-500">
                        {bucket.segments.length} segment
                        {bucket.segments.length === 1 ? "" : "s"} to discover
                      </p>
                    </div>
                    <span className="text-xs text-slate-400 tabular-nums">
                      {formatKilometers(bucket.totalLengthKm)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="p-5">
            <SectionHeader
              icon={<Navigation size={14} />}
              title="Nearby unridden suggestions"
              subtitle="Sorted by distance"
            />
            {nearbyLoading ? (
              <LoaderRow label="Loading suggestions…" />
            ) : nearbyError ? (
              <p className="text-sm text-red-300">{nearbyError}</p>
            ) : nearby.length === 0 ? (
              <EmptyState label="Nothing nearby — zoom out or pick a new centre." />
            ) : (
              <ul className="space-y-2">
                {nearby.slice(0, 10).map((seg) => (
                  <NearbyRow key={seg.id} segment={seg} />
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
    <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
      <div>
        <h1 className="text-xl font-bold">My Road Map</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          Every road you&apos;ve ridden
        </p>
      </div>
      <div className="px-4 py-2 rounded-xl bg-tarmoto-cyan/10 text-tarmoto-cyan font-semibold text-sm tabular-nums">
        {percentExplored == null ? "…" : `${percentExplored}% explored`}
      </div>
    </div>
  );
}

interface SummaryCardsProps {
  stats: ExplorationStats;
  periodStats: ReturnType<typeof computePeriodStats>;
}

function SummaryCards({ stats, periodStats }: SummaryCardsProps) {
  const cards = [
    {
      label: "Segments ridden",
      value: stats.ridden_segments.toLocaleString(),
      sub: `of ${stats.total_segments.toLocaleString()} total`,
    },
    {
      label: "All-time distance",
      value: formatKilometers(stats.total_distance_km),
      sub: `${stats.percent_explored}% explored`,
    },
    {
      label: `Rides — ${TIME_PERIOD_LABELS[periodStats.period]}`,
      value: periodStats.rideCount.toLocaleString(),
      sub:
        periodStats.rideCount === 0
          ? "No rides in this period"
          : `${formatKilometers(periodStats.distanceKm)} · ${periodStats.activeDays} active day${periodStats.activeDays === 1 ? "" : "s"}`,
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-2">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-xl bg-slate-900 border border-slate-800 p-3"
        >
          <p className="text-xs uppercase tracking-wider text-slate-500">
            {c.label}
          </p>
          <p className="text-xl font-bold text-white tabular-nums mt-0.5">
            {c.value}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">{c.sub}</p>
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
      <div className="flex items-center gap-2 text-white">
        <span className="text-tarmoto-cyan">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
    </div>
  );
}

interface NearbyCenterControlsProps {
  center: { lat: number; lng: number; label: string };
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
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700 transition disabled:opacity-60"
      >
        {locating ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Crosshair size={14} />
        )}
        {locating ? "Locating…" : "Use my location"}
      </button>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-slate-400">
          <span className="block mb-1">Latitude</span>
          <input
            type="number"
            step="0.0001"
            value={latInput}
            onChange={(e) => setLatInput(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-sm text-white focus:outline-none focus:border-tarmoto-cyan"
          />
        </label>
        <label className="text-xs text-slate-400">
          <span className="block mb-1">Longitude</span>
          <input
            type="number"
            step="0.0001"
            value={lngInput}
            onChange={(e) => setLngInput(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-sm text-white focus:outline-none focus:border-tarmoto-cyan"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={apply}
        className="w-full px-3 py-1.5 rounded-lg bg-tarmoto-cyan/10 text-tarmoto-cyan text-sm hover:bg-tarmoto-cyan/20 transition"
      >
        Apply coordinates
      </button>
    </div>
  );
}

interface NearbyRowProps {
  segment: UnriddenSegment;
}

function NearbyRow({ segment }: NearbyRowProps) {
  const tier =
    segment.quality_score != null ? scoreToTier(segment.quality_score) : null;
  const tierInfo = tier ? QUALITY_CONFIG[tier] : null;
  return (
    <li className="flex items-center gap-3 rounded-lg bg-slate-900 border border-slate-800 px-3 py-2">
      <span
        className={`w-2 h-2 rounded-full ${tierInfo?.bg ?? "bg-slate-600"}`}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">
          {segment.road_name ?? "Unnamed road"}
        </p>
        <p className="text-xs text-slate-500 capitalize">
          {segment.surface_type}
          {tierInfo ? ` · ${tierInfo.label.toLowerCase()}` : ""} ·{" "}
          {formatDistanceMeters(segment.length_m)}
        </p>
      </div>
      <span className="text-xs text-slate-400 tabular-nums">
        {formatDistanceMeters(segment.distance_m)} away
      </span>
    </li>
  );
}

interface ShareButtonProps {
  state: "idle" | "copied" | "shared" | "error";
  onClick: () => void;
}

function ShareButton({ state, onClick }: ShareButtonProps) {
  const label =
    state === "copied"
      ? "Copied!"
      : state === "shared"
        ? "Shared"
        : state === "error"
          ? "Share unavailable"
          : "Share stats";
  const Icon =
    state === "copied"
      ? Check
      : state === "shared"
        ? Check
        : state === "error"
          ? Copy
          : Share2;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-medium hover:bg-cyan-300 transition"
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

interface LoaderRowProps {
  label: string;
}

function LoaderRow({ label }: LoaderRowProps) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-400">
      <Loader2 size={14} className="animate-spin" /> {label}
    </div>
  );
}

interface EmptyStateProps {
  label: string;
}

function EmptyState({ label }: EmptyStateProps) {
  return <p className="text-sm text-slate-500">{label}</p>;
}

interface MapLegendProps {
  riddenCount: number;
}

function MapLegend({ riddenCount }: MapLegendProps) {
  return (
    <div className="absolute top-4 left-4 z-10 rounded-xl bg-slate-950/80 border border-slate-800 backdrop-blur px-4 py-3 text-xs text-slate-300 space-y-2">
      <div className="flex items-center gap-2">
        <span className="h-1 w-6 rounded-full bg-tarmoto-cyan" />
        Ridden ({riddenCount.toLocaleString()} segments)
      </div>
      <div className="flex items-center gap-2">
        <span className="h-1 w-6 rounded-full bg-slate-600" />
        Unridden
      </div>
    </div>
  );
}
