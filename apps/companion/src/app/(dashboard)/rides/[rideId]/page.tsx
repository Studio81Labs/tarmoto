"use client";
import { t } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useAuthStore } from "@/stores/auth";
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
import type { QualityTier } from "@/lib/types";
import { formatDuration, QUALITY_CONFIG } from "@/lib/utils";
import {
  buildSpeedProfile,
  computeQualityBreakdown,
  formatNumber,
  readingToTier,
  type RideSegmentLike,
  type SpeedProfilePoint,
} from "@/lib/ride-detail";
import { downloadRideExport, type RideExportFormat } from "@/lib/ride-export";
import { RideRouteMap } from "../_components/RideRouteMap";
import { Card } from "@tarmoto/ui";
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
  route_geometry: Array<{
    lat: number;
    lng: number;
  }> | null;
  segments: RideSegmentLike[];
}
export default function RideDetailPage() {
  const { rideId } = useParams<{
    rideId: string;
  }>();
  const [ride, setRide] = useState<RideDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [exporting, setExporting] = useState<RideExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  // Gate the detail fetch on the access token being hydrated by
  // `AuthSync`. Without this, the initial mount races AuthSync and
  // the first GET goes out without a Bearer header → backend 401s.
  // Same pattern as `useRidesQuery` and `useUserTrips`.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  useEffect(() => {
    if (!rideId || !authReady) return;
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
  }, [rideId, authReady]);
  const breakdown = useMemo(
    () => computeQualityBreakdown(ride?.segments ?? []),
    [ride?.segments],
  );
  const speedProfile = useMemo(
    () => buildSpeedProfile(ride?.segments ?? []),
    [ride?.segments],
  );
  const maxSegmentSpeed = useMemo(() => {
    if (!ride) return 0;
    return ride.segments.reduce((acc, s) => {
      const avg =
        s.speed_avg != null && Number.isFinite(s.speed_avg) ? s.speed_avg : 0;
      const max =
        s.speed_max != null && Number.isFinite(s.speed_max) ? s.speed_max : 0;
      return Math.max(acc, avg, max);
    }, 0);
  }, [ride]);
  async function handleExport(format: RideExportFormat) {
    if (!ride || exporting) return;
    setExporting(format);
    setExportError(null);
    try {
      await downloadRideExport(ride.id, format);
    } catch (err) {
      // Keep this separate from the page-level `error` state so a transient
      // export failure doesn't replace the whole ride view with an error card.
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(null);
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
        <div className="flex items-center gap-2 text-fg-dim">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading ride\u2026 ")}
        </div>
      </PageShell>
    );
  }
  if (notFound) {
    return (
      <PageShell>
        <Card padded={false} className="p-10 text-center">
          <Route size={40} className="mx-auto mb-3 text-fg-mute" />
          <p className="mb-1 font-medium text-ink">{t("Ride not found")}</p>
          <p className="text-sm text-fg-dim">
            {t(
              "This ride may have been deleted or doesn't belong to your account. ",
            )}
          </p>
        </Card>
      </PageShell>
    );
  }
  if (error || !ride) {
    return (
      <PageShell>
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
          {error ?? "Could not load ride"}
        </div>
      </PageShell>
    );
  }
  const rideName = `Ride on ${new Date(ride.started_at).toLocaleDateString()}`;
  const avgTier = readingToTier(ride.avg_road_quality);
  // Guard against empty strings from the API; the `as unknown as RideDetail`
  // cast bypasses the type system, so we can't assume a non-empty value.
  const rideTypeLabel = ride.ride_type
    ? ride.ride_type[0]!.toUpperCase() + ride.ride_type.slice(1)
    : "Unknown";
  return (
    <PageShell
      header={
        <div className="flex items-center gap-4 mb-6">
          <Link
            href="/rides"
            className="p-2 rounded-lg hover:bg-paper transition"
            aria-label={t("Back to rides")}
          >
            <ArrowLeft size={20} className="text-fg-dim" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold truncate">{rideName}</h1>
            <p className="text-sm text-fg-dim mt-0.5">
              {new Date(ride.started_at).toLocaleString()} ·{" "}
              {t("{rideType} ride", { rideType: rideTypeLabel })}
            </p>
          </div>
          <button
            type="button"
            onClick={handleShare}
            className="p-2 rounded-lg bg-paper text-ink hover:bg-paper-2 transition"
            aria-label={t("Copy share link")}
            title={shareCopied ? "Link copied" : "Copy share link"}
          >
            <Share2 size={16} />
          </button>
          <button
            type="button"
            onClick={() => handleExport("gpx")}
            disabled={exporting !== null}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-paper text-ink text-sm hover:bg-paper-2 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {exporting === "gpx" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            {t("Export GPX ")}
          </button>
          <button
            type="button"
            onClick={() => handleExport("csv")}
            disabled={exporting !== null}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-paper text-ink text-sm hover:bg-paper-2 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {exporting === "csv" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            {t("Export CSV ")}
          </button>
        </div>
      }
    >
      {exportError && (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-400 flex items-center justify-between gap-3"
        >
          <span>
            {t("Export failed: ")}
            {exportError}
          </span>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="text-xs text-red-400/70 hover:text-red-400 transition"
          >
            {t("Dismiss ")}
          </button>
        </div>
      )}

      {/* Route map */}
      <Card padded={false} className="mb-6 p-5">
        <SectionHeader
          icon={<Route size={16} />}
          title={t("Route")}
          subtitle="Interactive ride route with road quality overlay where Tarmoto has segment data."
        />
        {ride.route_geometry && ride.route_geometry.length >= 2 ? (
          <div className="mt-4">
            <RideRouteMap geometry={ride.route_geometry} />
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-line p-10 text-center text-sm text-fg-dim">
            {t("No GPS track was recorded for this ride.")}
          </div>
        )}
      </Card>

      <section className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card padded={false} className="p-5">
          <SectionHeader
            icon={<Mountain size={16} />}
            title={t("Elevation profile")}
            subtitle="Elevation gain/loss is available in the stats below; per-sample ride elevation is not recorded yet."
          />
          <ElevationProfileChart />
        </Card>
        <Card padded={false} className="p-5">
          <SectionHeader
            icon={<Gauge size={16} />}
            title={t("Speed graph")}
            subtitle={
              speedProfile.length > 0
                ? `${formatNumber(maxSegmentSpeed, 0)} km/h peak across recorded segments.`
                : "Speed samples are attached once segment telemetry is available."
            }
          />
          <SpeedProfileChart points={speedProfile} />
        </Card>
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
      <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card padded={false} className="p-5 md:col-span-2">
          <SectionHeader
            icon={<Gauge size={16} />}
            title={t("Road quality breakdown")}
            subtitle={
              ride.segments.length === 0
                ? "No segment data recorded for this ride."
                : `Across ${ride.segments.length} segment${ride.segments.length === 1 ? "" : "s"}.`
            }
          />
          <QualityBar breakdown={breakdown} />
          <ul className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            {breakdown.map((row) => (
              <li
                key={row.tier}
                className="flex items-center gap-2 text-xs text-ink"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: row.color }}
                />
                <span className="flex-1 truncate">{row.label}</span>
                <span className="tabular-nums text-fg-dim">{row.percent}%</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card padded={false} className="flex flex-col gap-5 p-5">
          <div>
            <p className="mb-1 text-xs text-fg-dim">{t("Avg road quality")}</p>
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
              <span className="text-fg-dim text-sm">—</span>
            )}
          </div>
          <div>
            <p className="mb-1 text-xs text-fg-dim">{t("Fuel estimate")}</p>
            <p className="text-xl font-bold tabular-nums text-ink">
              {formatNumber(ride.fuel_estimate_l, 2)}
              <span className="ml-1 text-sm font-normal text-fg-dim">
                {t("L")}
              </span>
            </p>
          </div>
        </Card>
      </section>

      {/* Segments table */}
      {ride.segments.length > 0 && (
        <Card padded={false} className="p-5">
          <SectionHeader
            icon={<Route size={16} />}
            title={t("Segments")}
            subtitle="Per-segment road quality, speed, and lean angle."
          />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-fg-dim">
                  <th className="py-2 pr-4 font-semibold">{t("Road")}</th>
                  <th className="py-2 pr-4 font-semibold">{t("Quality")}</th>
                  <th className="py-2 pr-4 font-semibold text-right">
                    {t("Avg speed ")}
                  </th>
                  <th className="py-2 pr-4 font-semibold text-right">
                    {t("Max lean ")}
                  </th>
                  <th className="py-2 pr-0 font-semibold">{t("Speed")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
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
                    <tr key={index} className="text-ink">
                      <td className="py-2 pr-4">
                        {seg.road_name ?? (
                          <span className="text-fg-dim">{t("Unnamed")}</span>
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
                          <span className="text-fg-dim">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatNumber(seg.speed_avg, 0)}
                        <span className="text-fg-dim ml-1">{t("km/h")}</span>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {seg.lean_angle_max == null
                          ? "—"
                          : `${formatNumber(seg.lean_angle_max, 0)}°`}
                      </td>
                      <td className="py-2 pr-0 w-40">
                        <div
                          className="h-1.5 rounded-full bg-paper"
                          aria-hidden
                        >
                          <div
                            className="h-full rounded-full bg-accent"
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
        </Card>
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
    <div className="mx-auto w-full max-w-page animate-fade-in p-7">
      {header ?? (
        <div className="mb-6 flex items-center gap-4">
          <Link
            href="/rides"
            className="p-2 rounded-lg hover:bg-paper transition"
            aria-label={t("Back to rides")}
          >
            <ArrowLeft size={20} className="text-fg-dim" />
          </Link>
          <h1 className="text-2xl font-bold flex-1">{t("Ride")}</h1>
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
    <Card padded={false} className="p-4">
      <div className="mb-1 flex items-center gap-2 text-xs text-fg-dim">
        <span className="text-accent">{icon}</span>
        {label}
      </div>
      <p className="text-xl font-bold tabular-nums text-ink">
        {value}
        {unit && (
          <span className="ml-1 text-sm font-normal text-fg-dim">{unit}</span>
        )}
      </p>
    </Card>
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
      <div className="flex items-center gap-2 text-ink">
        <span className="text-accent">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {subtitle && <p className="text-xs text-fg-dim mt-0.5">{subtitle}</p>}
    </div>
  );
}
function QualityBar({
  breakdown,
}: {
  breakdown: {
    tier: QualityTier;
    color: string;
    percent: number;
  }[];
}) {
  const total = breakdown.reduce((acc, row) => acc + row.percent, 0);
  if (total === 0) {
    return <div className="mt-4 h-3 rounded-full bg-paper" aria-hidden />;
  }
  return (
    <div
      className="mt-4 flex h-3 rounded-full overflow-hidden bg-paper"
      role="img"
      aria-label={t("Road quality distribution")}
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

function ElevationProfileChart() {
  return (
    <EmptyChartState>
      {t("No elevation profile was recorded for this ride.")}
    </EmptyChartState>
  );
}

function SpeedProfileChart({ points }: { points: SpeedProfilePoint[] }) {
  if (points.length === 0) {
    return (
      <EmptyChartState>
        {t("No speed samples were recorded for this ride.")}
      </EmptyChartState>
    );
  }
  const avgPoints = points
    .filter((point) => point.avgKmh != null)
    .map((point) => ({ x: point.segmentNumber, y: point.avgKmh! }));
  const maxPoints = points
    .filter((point) => point.maxKmh != null)
    .map((point) => ({ x: point.segmentNumber, y: point.maxKmh! }));
  const values = [...avgPoints, ...maxPoints].map((point) => point.y);
  const peak = values.length ? Math.max(...values) : 1;
  return (
    <div>
      <div className="mt-4 flex items-center gap-4 text-[11px] text-fg-dim">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-accent" />
          {t("Avg")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-pink-400" />
          {t("Max")}
        </span>
      </div>
      <LineSeriesChart
        points={avgPoints}
        secondaryPoints={maxPoints}
        color="#FF6A1A"
        secondaryColor="#f472b6"
        minY={0}
        maxY={peak}
        ariaLabel={t("Ride speed graph")}
        xSuffix="seg"
        valueSuffix="km/h"
      />
    </div>
  );
}

function EmptyChartState({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex h-56 items-center justify-center rounded-xl border border-dashed border-line px-4 text-center text-sm text-fg-dim">
      {children}
    </div>
  );
}

function LineSeriesChart({
  points,
  secondaryPoints = [],
  color,
  secondaryColor,
  minY,
  maxY,
  ariaLabel,
  xSuffix = "km",
  valueSuffix,
}: {
  points: Array<{ x: number; y: number }>;
  secondaryPoints?: Array<{ x: number; y: number }>;
  color: string;
  secondaryColor?: string;
  minY: number;
  maxY: number;
  ariaLabel: string;
  xSuffix?: string;
  valueSuffix: string;
}) {
  const allPoints = [...points, ...secondaryPoints];
  if (allPoints.length === 0) return null;
  const minX = Math.min(...allPoints.map((point) => point.x));
  const maxX = Math.max(...allPoints.map((point) => point.x));
  const ySpan = Math.max(maxY - minY, 1);
  const xSpan = Math.max(maxX - minX, 1);
  const project = (point: { x: number; y: number }) => {
    const x = 16 + ((point.x - minX) / xSpan) * 368;
    const y = 152 - ((point.y - minY) / ySpan) * 128;
    return { x, y };
  };
  const path = (series: Array<{ x: number; y: number }>) =>
    series
      .map((point) => {
        const projected = project(point);
        return `${projected.x.toFixed(1)},${projected.y.toFixed(1)}`;
      })
      .join(" ");
  const last = allPoints.at(-1);
  const renderSeries = (
    series: Array<{ x: number; y: number }>,
    stroke: string,
    strokeWidth: string,
    strokeDasharray?: string,
  ) => {
    if (series.length === 0) return null;
    if (series.length === 1) {
      const projected = project(series[0]!);
      return (
        <circle
          cx={projected.x}
          cy={projected.y}
          r="4"
          fill={stroke}
          stroke="#0f172a"
          strokeWidth="2"
        />
      );
    }

    return (
      <polyline
        points={path(series)}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={strokeDasharray}
      />
    );
  };

  return (
    <div className="mt-4">
      <svg
        viewBox="0 0 400 176"
        className="h-56 w-full"
        role="img"
        aria-label={ariaLabel}
      >
        <line x1="16" y1="24" x2="384" y2="24" stroke="#1e293b" />
        <line x1="16" y1="88" x2="384" y2="88" stroke="#1e293b" />
        <line x1="16" y1="152" x2="384" y2="152" stroke="#334155" />
        {renderSeries(points, color, "3")}
        {secondaryColor &&
          renderSeries(secondaryPoints, secondaryColor, "2.5", "6 5")}
      </svg>
      <div className="flex items-center justify-between text-[11px] text-fg-dim">
        <span>
          {formatChartXAxisValue(minX)} {xSuffix}
        </span>
        {last && (
          <span>
            {formatNumber(last.y, 0)} {valueSuffix}
          </span>
        )}
        <span>
          {formatChartXAxisValue(maxX)} {xSuffix}
        </span>
      </div>
    </div>
  );
}

function formatChartXAxisValue(value: number): string {
  return Number.isInteger(value) ? String(value) : formatNumber(value, 1);
}
