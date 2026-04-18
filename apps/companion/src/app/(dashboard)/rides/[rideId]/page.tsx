"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Clock,
  Download,
  Gauge,
  Loader2,
  Mountain,
  Route,
  Share2,
  Thermometer,
} from "lucide-react";
import { api } from "@/lib/api";
import { API_BASE } from "@/lib/config";
import { useAuthStore } from "@/stores/auth";
import type { QualityTier } from "@/lib/types";
import { formatDuration, QUALITY_CONFIG } from "@/lib/utils";
import {
  buildRoutePreview,
  computeQualityBreakdown,
  formatNumber,
  readingToTier,
  type RideSegmentLike,
} from "@/lib/ride-detail";

interface RideDetail {
  id: string;
  status: string;
  ride_type: string;
  started_at: string;
  ended_at: string | null;
  distance_km: number | null;
  duration_min: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  avg_road_quality: number | null;
  elevation_gain: number | null;
  elevation_loss: number | null;
  curve_count: number | null;
  max_lean_angle: number | null;
  fuel_estimate_l: number | null;
  route_geometry: Array<{ lat: number; lng: number }> | null;
  segments: RideSegmentLike[];
}

export default function RideDetailPage() {
  const { rideId } = useParams<{ rideId: string }>();
  const [ride, setRide] = useState<RideDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    if (!rideId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    api
      .GET("/api/v1/rides/{rideId}", { params: { path: { rideId } } })
      .then(({ data, error: apiError, response }) => {
        if (cancelled) return;
        if (response?.status === 404) {
          setNotFound(true);
          return;
        }
        if (apiError || !data) {
          setError("Could not load ride");
          return;
        }
        setRide(data as unknown as RideDetail);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load ride");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rideId]);

  const breakdown = useMemo(
    () => computeQualityBreakdown(ride?.segments ?? []),
    [ride?.segments],
  );
  const preview = useMemo(
    () => buildRoutePreview(ride?.route_geometry ?? null, 800, 12),
    [ride?.route_geometry],
  );
  const maxSegmentSpeed = useMemo(() => {
    if (!ride) return 0;
    return ride.segments.reduce(
      (acc, s) => (s.speed_avg != null ? Math.max(acc, s.speed_avg) : acc),
      0,
    );
  }, [ride]);

  async function handleExportGpx() {
    if (!ride || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const token = useAuthStore.getState().accessToken;
      const res = await fetch(`${API_BASE}/rides/${ride.id}/gpx`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `tarmoto-ride-${ride.id}.gpx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      // Keep this separate from the page-level `error` state so a transient
      // export failure doesn't replace the whole ride view with an error card.
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function handleShare() {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      // Clipboard API can reject on insecure origins; fall back silently.
    }
  }

  if (loading) {
    return (
      <PageShell>
        <div className="flex items-center gap-2 text-slate-400">
          <Loader2 size={16} className="animate-spin" /> Loading ride…
        </div>
      </PageShell>
    );
  }

  if (notFound) {
    return (
      <PageShell>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-10 text-center">
          <Route size={40} className="mx-auto text-slate-600 mb-3" />
          <p className="text-slate-200 font-medium mb-1">Ride not found</p>
          <p className="text-sm text-slate-500">
            This ride may have been deleted or doesn&apos;t belong to your
            account.
          </p>
        </div>
      </PageShell>
    );
  }

  if (error || !ride) {
    return (
      <PageShell>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-300">
          {error ?? "Could not load ride"}
        </div>
      </PageShell>
    );
  }

  const rideName = `Ride on ${new Date(ride.started_at).toLocaleDateString()}`;
  const avgTier = readingToTier(ride.avg_road_quality);

  return (
    <PageShell
      header={
        <div className="flex items-center gap-4 mb-6">
          <Link
            href="/rides"
            className="p-2 rounded-lg hover:bg-slate-800 transition"
            aria-label="Back to rides"
          >
            <ArrowLeft size={20} className="text-slate-400" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold truncate">{rideName}</h1>
            <p className="text-sm text-slate-400 mt-0.5">
              {new Date(ride.started_at).toLocaleString()} ·{" "}
              {ride.ride_type[0]!.toUpperCase() + ride.ride_type.slice(1)} ride
            </p>
          </div>
          <button
            type="button"
            onClick={handleShare}
            className="p-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
            aria-label="Copy share link"
            title={shareCopied ? "Link copied" : "Copy share link"}
          >
            <Share2 size={16} />
          </button>
          <button
            type="button"
            onClick={handleExportGpx}
            disabled={exporting}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {exporting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Export GPX
          </button>
        </div>
      }
    >
      {exportError && (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300 flex items-center justify-between gap-3"
        >
          <span>GPX export failed: {exportError}</span>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="text-xs text-red-300/70 hover:text-red-200 transition"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Route preview */}
      <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5 mb-6">
        <SectionHeader
          icon={<Route size={16} />}
          title="Route"
          subtitle="Polyline preview of your ride. Full map coming with the explorer."
        />
        {preview ? (
          <div className="mt-4 flex justify-center">
            <svg
              viewBox={preview.viewBox}
              className="max-h-80 w-full"
              role="img"
              aria-label="Ride route preview"
            >
              <path
                d={preview.path}
                fill="none"
                stroke="#0ED3CF"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
            No GPS track was recorded for this ride.
          </div>
        )}
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard
          icon={<Route size={14} />}
          label="Distance"
          value={formatNumber(ride.distance_km, 1)}
          unit="km"
        />
        <StatCard
          icon={<Clock size={14} />}
          label="Duration"
          value={formatDuration(ride.duration_min)}
        />
        <StatCard
          icon={<Gauge size={14} />}
          label="Avg speed"
          value={formatNumber(ride.avg_speed, 0)}
          unit="km/h"
        />
        <StatCard
          icon={<Gauge size={14} />}
          label="Max speed"
          value={formatNumber(ride.max_speed, 0)}
          unit="km/h"
        />
        <StatCard
          icon={<Mountain size={14} />}
          label="Elevation gain"
          value={formatNumber(ride.elevation_gain, 0)}
          unit="m"
        />
        <StatCard
          icon={<Mountain size={14} />}
          label="Elevation loss"
          value={formatNumber(ride.elevation_loss, 0)}
          unit="m"
        />
        <StatCard
          icon={<Route size={14} />}
          label="Curve count"
          value={
            ride.curve_count == null ? "—" : ride.curve_count.toLocaleString()
          }
        />
        <StatCard
          icon={<Thermometer size={14} />}
          label="Max lean"
          value={formatNumber(ride.max_lean_angle, 0)}
          unit="°"
        />
      </section>

      {/* Quality breakdown + fuel */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="md:col-span-2 rounded-2xl bg-slate-900 border border-slate-800 p-5">
          <SectionHeader
            icon={<Gauge size={16} />}
            title="Road quality breakdown"
            subtitle={
              ride.segments.length === 0
                ? "No segment data recorded for this ride."
                : `Across ${ride.segments.length} segment${ride.segments.length === 1 ? "" : "s"}.`
            }
          />
          <QualityBar breakdown={breakdown} />
          <ul className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-3">
            {breakdown.map((row) => (
              <li
                key={row.tier}
                className="flex items-center gap-2 text-xs text-slate-300"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: row.color }}
                />
                <span className="flex-1 truncate">{row.label}</span>
                <span className="tabular-nums text-slate-400">
                  {row.percent}%
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl bg-slate-900 border border-slate-800 p-5 flex flex-col gap-5">
          <div>
            <p className="text-xs text-slate-500 mb-1">Avg road quality</p>
            {avgTier ? (
              <span
                className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-semibold quality-${avgTier}`}
              >
                {QUALITY_CONFIG[avgTier].label}
                <span className="text-[10px] opacity-70 tabular-nums">
                  {formatNumber(ride.avg_road_quality, 1)}/5
                </span>
              </span>
            ) : (
              <span className="text-slate-500 text-sm">—</span>
            )}
          </div>
          <div>
            <p className="text-xs text-slate-500 mb-1">Fuel estimate</p>
            <p className="text-xl font-bold text-white tabular-nums">
              {formatNumber(ride.fuel_estimate_l, 2)}
              <span className="text-sm font-normal text-slate-400 ml-1">L</span>
            </p>
          </div>
        </div>
      </section>

      {/* Segments table */}
      {ride.segments.length > 0 && (
        <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
          <SectionHeader
            icon={<Route size={16} />}
            title="Segments"
            subtitle="Per-segment road quality, speed, and lean angle."
          />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="py-2 pr-4 font-semibold">Road</th>
                  <th className="py-2 pr-4 font-semibold">Quality</th>
                  <th className="py-2 pr-4 font-semibold text-right">
                    Avg speed
                  </th>
                  <th className="py-2 pr-4 font-semibold text-right">
                    Max lean
                  </th>
                  <th className="py-2 pr-0 font-semibold">Speed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {ride.segments.map((seg, index) => {
                  const tier = readingToTier(seg.quality_reading);
                  const pct =
                    maxSegmentSpeed > 0 && seg.speed_avg != null
                      ? Math.max(
                          4,
                          Math.round((seg.speed_avg / maxSegmentSpeed) * 100),
                        )
                      : 0;
                  return (
                    <tr key={index} className="text-slate-200">
                      <td className="py-2 pr-4">
                        {seg.road_name ?? (
                          <span className="text-slate-500">Unnamed</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {tier ? (
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold quality-${tier}`}
                          >
                            {QUALITY_CONFIG[tier].label}
                          </span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatNumber(seg.speed_avg, 0)}
                        <span className="text-slate-500 ml-1">km/h</span>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {seg.lean_angle_max == null
                          ? "—"
                          : `${formatNumber(seg.lean_angle_max, 0)}°`}
                      </td>
                      <td className="py-2 pr-0 w-40">
                        <div
                          className="h-1.5 rounded-full bg-slate-800"
                          aria-hidden
                        >
                          <div
                            className="h-full rounded-full bg-tarmoto-cyan"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </PageShell>
  );
}

function PageShell({
  children,
  header,
}: {
  children: React.ReactNode;
  header?: React.ReactNode;
}) {
  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      {header ?? (
        <div className="flex items-center gap-4 mb-6">
          <Link
            href="/rides"
            className="p-2 rounded-lg hover:bg-slate-800 transition"
            aria-label="Back to rides"
          >
            <ArrowLeft size={20} className="text-slate-400" />
          </Link>
          <h1 className="text-2xl font-bold flex-1">Ride</h1>
        </div>
      )}
      {children}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  unit,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
        <span className="text-tarmoto-cyan">{icon}</span>
        {label}
      </div>
      <p className="text-xl font-bold text-white tabular-nums">
        {value}
        {unit && (
          <span className="text-sm font-normal text-slate-400 ml-1">
            {unit}
          </span>
        )}
      </p>
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-white">
        <span className="text-tarmoto-cyan">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
    </div>
  );
}

function QualityBar({
  breakdown,
}: {
  breakdown: { tier: QualityTier; color: string; percent: number }[];
}) {
  const total = breakdown.reduce((acc, row) => acc + row.percent, 0);
  if (total === 0) {
    return <div className="mt-4 h-3 rounded-full bg-slate-800" aria-hidden />;
  }
  return (
    <div
      className="mt-4 flex h-3 rounded-full overflow-hidden bg-slate-800"
      role="img"
      aria-label="Road quality distribution"
    >
      {breakdown
        .filter((row) => row.percent > 0)
        .map((row) => (
          <div
            key={row.tier}
            style={{ width: `${row.percent}%`, backgroundColor: row.color }}
            title={`${row.percent}% ${row.tier}`}
          />
        ))}
    </div>
  );
}
