"use client";
import { t } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Loader2,
  Pencil,
  Scale,
  Share2,
  X,
} from "lucide-react";
import {
  Button,
  Card,
  DataTable,
  MetricTile,
  Mono,
  QualityBars,
  Stamp,
  type DataTableColumn,
  type MetricTileProps,
} from "@tarmoto/ui";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { usePreferencesStore } from "@/stores/preferences";
import {
  formatDurationCompact,
  scoreToQualityTier,
  splitFormattedDistance,
  splitFormattedElevation,
  splitFormattedSpeed,
} from "@/lib/utils";
import { buildSpeedProfile, formatNumber } from "@/lib/ride-detail";
import { kmToMiles, type UnitSystem } from "@tarmoto/shared";
import { downloadRideExport, type RideExportFormat } from "@/lib/ride-export";
import { RideRouteMap } from "../_components/RideRouteMap";

interface LeanDistribution {
  "0_10": number;
  "10_20": number;
  "20_30": number;
  "30_plus": number;
}

interface RideSegment {
  road_name: string | null;
  quality_reading: number | null;
  speed_avg: number | null;
  speed_max: number | null;
  lean_angle_max: number | null;
}

interface RideDetail {
  id: string;
  name: string | null;
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
  lean_distribution: LeanDistribution | null;
  fuel_estimate_l: number | null;
  route_geometry: Array<{ lat: number; lng: number }> | null;
  segments: RideSegment[];
}

// Lean buckets the backend reports (US-19). The v2 "Time spent leaning" chart
// uses these 4 buckets directly rather than the design mock's 5 — we render the
// data we actually have rather than fabricating finer bands.
const LEAN_BUCKETS: Array<{
  key: keyof LeanDistribution;
  label: string;
  mid: number;
}> = [
  { key: "0_10", label: "0–10°", mid: 5 },
  { key: "10_20", label: "10–20°", mid: 15 },
  { key: "20_30", label: "20–30°", mid: 25 },
  { key: "30_plus", label: "30°+", mid: 35 },
];

export default function RideDetailPage() {
  const { rideId } = useParams<{ rideId: string }>();
  const { format } = useNumberFormat();
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const [ride, setRide] = useState<RideDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [exporting, setExporting] = useState<RideExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // Gate the fetch on the access token being hydrated by AuthSync (same
  // pattern as useRidesQuery) so the first GET carries a Bearer header.
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

  async function handleExport(format: RideExportFormat) {
    if (!ride || exporting) return;
    setExporting(format);
    setExportError(null);
    try {
      await downloadRideExport(ride.id, format);
    } catch (err) {
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
      // Clipboard can reject on insecure origins; fail silently.
    }
  }
  async function saveRename() {
    if (renameSaving) return;
    setRenameSaving(true);
    setRenameError(null);
    const trimmed = renameDraft.trim();
    try {
      const { data, error: apiError } = await api.PATCH(
        "/api/v1/rides/{rideId}",
        {
          params: { path: { rideId } },
          body: { name: trimmed === "" ? null : trimmed },
        } as never,
      );
      if (apiError) throw new Error("Rename failed");
      const nextName =
        (data as { name?: string | null } | undefined)?.name ??
        (trimmed === "" ? null : trimmed);
      setRide((r) => (r ? { ...r, name: nextName } : r));
      setRenaming(false);
    } catch {
      setRenameError("Couldn't rename this ride. Try again.");
    } finally {
      setRenameSaving(false);
    }
  }

  const avgLean = useMemo(() => {
    const d = ride?.lean_distribution;
    if (!d) return null;
    const total = LEAN_BUCKETS.reduce((acc, b) => acc + (d[b.key] ?? 0), 0);
    if (total === 0) return null;
    const weighted = LEAN_BUCKETS.reduce(
      (acc, b) => acc + (d[b.key] ?? 0) * b.mid,
      0,
    );
    return weighted / total;
  }, [ride?.lean_distribution]);

  if (loading) {
    return (
      <PageShell>
        <div className="flex items-center gap-2 text-fg-dim">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading ride… ")}
        </div>
      </PageShell>
    );
  }
  if (notFound) {
    return (
      <PageShell>
        <Card padded={false} className="p-10 text-center">
          <p className="mb-1 font-bold text-ink">{t("Ride not found")}</p>
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

  const rideName = ride.name?.trim()
    ? ride.name
    : `Ride on ${new Date(ride.started_at).toLocaleDateString()}`;
  const avgTier = scoreToQualityTier(ride.avg_road_quality);
  const startedDate = new Date(ride.started_at).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  // All metrics honour the rider's unit preference (km/m·mph·ft) so the grid
  // stays internally consistent — not a mix of converted distance and raw
  // metric speed/elevation.
  const distance = splitFormattedDistance(ride.distance_km ?? 0, unitSystem);
  const duration = splitDuration(ride.duration_min);
  const avgSpeed = splitFormattedSpeed(ride.avg_speed ?? 0, unitSystem);
  const topSpeed = splitFormattedSpeed(ride.max_speed ?? 0, unitSystem);
  const ascent = splitFormattedElevation(ride.elevation_gain ?? 0, unitSystem);
  const descent = splitFormattedElevation(ride.elevation_loss ?? 0, unitSystem);
  const speedUnit = avgSpeed.unit;

  // Distance / Duration / Avg / Top / Max lean / Ascent — the design's 2×3 grid.
  const tiles: MetricTileProps[] = [
    {
      label: "Distance",
      value: ride.distance_km != null ? distance.value : "—",
      unit: distance.unit,
      variant: "ink",
      accentNumber: true,
    },
    { label: "Duration", value: duration.value, unit: duration.unit },
    {
      label: "Avg speed",
      value: ride.avg_speed != null ? avgSpeed.value : "—",
      unit: speedUnit,
    },
    {
      label: "Top speed",
      value: ride.max_speed != null ? topSpeed.value : "—",
      unit: speedUnit,
    },
    {
      label: "Max lean",
      value:
        ride.max_lean_angle != null
          ? `${Math.round(ride.max_lean_angle)}°`
          : "—",
    },
    {
      label: "Ascent",
      value: ride.elevation_gain != null ? ascent.value : "—",
      unit: ascent.unit,
      accentNumber: true,
    },
  ];

  return (
    <PageShell
      header={
        <>
          <Link
            href="/rides"
            className="inline-flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.3px] text-fg-dim transition hover:text-ink"
          >
            <ArrowLeft size={14} />
            {t("Ride History · All rides")}
          </Link>

          <div className="mt-3.5 mb-[22px] flex items-end justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <Mono className="text-[10px] uppercase tracking-[1.6px] text-fg-dim">
                  {ride.ride_type}
                </Mono>
                <span className="h-[3px] w-[3px] rounded-full bg-fg-mute" />
                <Mono className="text-[10px] uppercase tracking-[1.6px] text-fg-dim">
                  {startedDate}
                </Mono>
              </div>

              {renaming ? (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    autoFocus
                    value={renameDraft}
                    maxLength={120}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveRename();
                      if (e.key === "Escape") setRenaming(false);
                    }}
                    aria-label={t("Ride name")}
                    className="min-w-0 flex-1 rounded-lg border border-line bg-cream px-2.5 py-1.5 text-2xl font-extrabold text-ink focus:border-ink focus:outline-none"
                  />
                  <Button
                    iconOnly
                    size="sm"
                    variant="secondary"
                    onClick={() => void saveRename()}
                    loading={renameSaving}
                    aria-label={t("Save name")}
                  >
                    <Check size={16} />
                  </Button>
                  <Button
                    iconOnly
                    size="sm"
                    variant="ghost"
                    onClick={() => setRenaming(false)}
                    aria-label={t("Cancel")}
                  >
                    <X size={16} />
                  </Button>
                </div>
              ) : (
                <div className="group mt-2 flex items-center gap-3.5">
                  <h1 className="truncate text-[34px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
                    {rideName}
                  </h1>
                  {avgTier != null && <QualityBars q={avgTier} size={8} />}
                  <button
                    type="button"
                    onClick={() => {
                      setRenameDraft(ride.name ?? "");
                      setRenameError(null);
                      setRenaming(true);
                    }}
                    aria-label={t("Rename ride")}
                    className="rounded-lg p-1.5 text-fg-mute opacity-100 transition hover:bg-paper-2 hover:text-ink focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              )}
              {renameError && (
                <p className="mt-1 text-xs text-red-400">{renameError}</p>
              )}
            </div>

            <div className="flex flex-shrink-0 gap-2">
              <Button
                variant="secondary"
                uppercase
                leftIcon={<Scale size={16} />}
                renderLink={({ className, children }) => (
                  <Link
                    href={`/rides/compare?a=${ride.id}`}
                    className={className}
                  >
                    {children}
                  </Link>
                )}
              >
                {t("Compare")}
              </Button>
              <Button
                variant="secondary"
                uppercase
                leftIcon={<Share2 size={14} />}
                onClick={handleShare}
                title={shareCopied ? t("Link copied") : t("Copy share link")}
              >
                {shareCopied ? t("Copied") : t("Share")}
              </Button>
              <Button
                variant="primary"
                uppercase
                loading={exporting === "gpx"}
                leftIcon={<ArrowUpRight size={14} />}
                onClick={() => handleExport("gpx")}
                disabled={exporting !== null}
              >
                {t("Export GPX")}
              </Button>
              <Button
                variant="secondary"
                uppercase
                loading={exporting === "csv"}
                leftIcon={<ArrowUpRight size={14} />}
                onClick={() => handleExport("csv")}
                disabled={exporting !== null}
              >
                {t("Export CSV")}
              </Button>
            </div>
          </div>
        </>
      }
    >
      {exportError && (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-400"
        >
          <span>
            {t("Export failed: ")}
            {exportError}
          </span>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="text-xs text-red-400/70 transition hover:text-red-400"
          >
            {t("Dismiss ")}
          </button>
        </div>
      )}

      {/* Route map + stats grid */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {ride.route_geometry && ride.route_geometry.length >= 2 ? (
          <div className="relative h-[440px]">
            <RideRouteMap
              geometry={ride.route_geometry}
              containerClassName="h-full"
            />
            <div className="absolute bottom-4 left-4 flex gap-4 rounded-[10px] border border-line-strong bg-cream px-3 py-2.5 shadow-[0_6px_16px_rgba(14,14,16,0.08)]">
              <LegendDot label={t("Start")} ink />
              <LegendDot label={t("Finish")} />
            </div>
          </div>
        ) : (
          <div className="flex h-[440px] items-center justify-center rounded-[14px] border border-dashed border-line text-sm text-fg-dim">
            {t("No GPS track was recorded for this ride.")}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 lg:content-start">
          {tiles.map((tile) => (
            <MetricTile key={tile.label} formatValue={format} {...tile} />
          ))}
        </div>
      </div>

      {/* Elevation summary (per-sample profile not recorded yet) */}
      <Card className="mb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Stamp>{t("Elevation profile")}</Stamp>
            <div className="mt-1 text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
              {t("Climb & descent")}
            </div>
          </div>
          <div className="flex gap-7 text-right">
            <ElevationStat
              label={t("Total ascent")}
              value={
                ride.elevation_gain != null
                  ? `+${format(ascent.value)} ${ascent.unit.toLowerCase()}`
                  : "—"
              }
            />
            <ElevationStat
              label={t("Total descent")}
              value={
                ride.elevation_loss != null
                  ? `−${format(descent.value)} ${descent.unit.toLowerCase()}`
                  : "—"
              }
            />
          </div>
        </div>
        <div className="mt-4 flex h-[120px] items-center justify-center rounded-xl border border-dashed border-line text-center text-sm text-fg-dim">
          {t("Per-sample elevation isn't recorded yet — totals above.")}
        </div>
      </Card>

      {/* Speed profile (US-48): per-segment avg/max speed for populated rides */}
      <SpeedProfileCard segments={ride.segments} unitSystem={unitSystem} />

      {/* Ride dynamics + character */}
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <div className="flex items-start justify-between">
            <div>
              <Stamp>{t("Ride dynamics")}</Stamp>
              <div className="mt-1 text-[18px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
                {t("Time spent leaning")}
              </div>
            </div>
            <div className="text-right">
              <Stamp>{t("Avg lean")}</Stamp>
              <div className="mt-0.5 text-[18px] font-extrabold text-accent">
                {avgLean != null ? `${Math.round(avgLean)}°` : "—"}
              </div>
            </div>
          </div>
          <LeanHistogram distribution={ride.lean_distribution} />
        </Card>

        <Card>
          <Stamp>{t("Conditions & setup")}</Stamp>
          <div className="mt-1 text-[18px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
            {t("How it rode")}
          </div>
          {/* Weather / temperature / bike / surface aren't recorded per ride
              yet, so we surface the character data we do have. */}
          <div className="mt-4 grid grid-cols-2 gap-3.5">
            <CharacterStat
              label={t("Avg road quality")}
              value={
                ride.avg_road_quality != null
                  ? `${formatNumber(ride.avg_road_quality, 1)} / 5`
                  : "—"
              }
            />
            <CharacterStat
              label={t("Curves")}
              value={ride.curve_count != null ? format(ride.curve_count) : "—"}
            />
            <CharacterStat
              label={t("Fuel estimate")}
              value={
                ride.fuel_estimate_l != null
                  ? `${formatNumber(ride.fuel_estimate_l, 1)} L`
                  : "—"
              }
            />
            <CharacterStat
              label={t("Elev. descent")}
              value={
                ride.elevation_loss != null
                  ? `${format(descent.value)} ${descent.unit.toLowerCase()}`
                  : "—"
              }
            />
          </div>
        </Card>
      </div>

      {/* Road segments */}
      {ride.segments.length > 0 && (
        <RoadSegments
          segments={ride.segments}
          distanceKm={ride.distance_km}
          format={format}
          unitSystem={unitSystem}
        />
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
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      {header ?? (
        <Link
          href="/rides"
          className="mb-6 inline-flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.3px] text-fg-dim transition hover:text-ink"
        >
          <ArrowLeft size={14} />
          {t("Ride History · All rides")}
        </Link>
      )}
      {children}
    </div>
  );
}

function LegendDot({ label, ink = false }: { label: string; ink?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`grid h-4 w-4 place-items-center rounded-full ${
          ink ? "bg-ink text-cream" : "bg-accent text-ink"
        }`}
      >
        <span className="font-mono text-[9px] font-extrabold">
          {ink ? "A" : "B"}
        </span>
      </span>
      <span className="text-[11px] font-semibold text-ink">{label}</span>
    </div>
  );
}

function ElevationStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Stamp>{label}</Stamp>
      <div className="mt-0.5 text-[18px] font-extrabold tracking-[-0.4px] text-ink">
        {value}
      </div>
    </div>
  );
}

function CharacterStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l-2 border-line-strong pl-3">
      <Stamp>{label}</Stamp>
      <div className="mt-1 text-[14px] font-bold text-ink">{value}</div>
    </div>
  );
}

function LeanHistogram({
  distribution,
}: {
  distribution: LeanDistribution | null;
}) {
  if (!distribution) {
    return (
      <div className="mt-[18px] flex h-[150px] items-center justify-center rounded-xl border border-dashed border-line text-center text-sm text-fg-dim">
        {t("No lean samples were recorded for this ride.")}
      </div>
    );
  }
  const counts = LEAN_BUCKETS.map((b) => distribution[b.key] ?? 0);
  const total = counts.reduce((a, c) => a + c, 0);
  const pcts = counts.map((c) =>
    total > 0 ? Math.round((c / total) * 100) : 0,
  );
  const peak = Math.max(...pcts, 1);
  // The fullest bucket is the rider's "comfort" lean — highlight it in accent.
  const peakIdx = pcts.indexOf(Math.max(...pcts));
  return (
    <div className="mt-[18px] flex h-[150px] items-end gap-3">
      {LEAN_BUCKETS.map((bucket, i) => (
        <div
          key={bucket.key}
          className="flex flex-1 flex-col items-center justify-end gap-1.5"
        >
          <Mono className="text-[10px] text-fg-mute">{pcts[i]}%</Mono>
          <div
            className={`w-full rounded-t ${
              i === peakIdx ? "bg-accent" : "bg-ink/[0.82]"
            }`}
            style={{ height: `${Math.max(4, (pcts[i]! / peak) * 110)}px` }}
          />
          <Mono className="text-[9px] font-bold text-fg-mute">
            {bucket.label}
          </Mono>
        </div>
      ))}
    </div>
  );
}

function RoadSegments({
  segments,
  distanceKm,
  format,
  unitSystem,
}: {
  segments: RideSegment[];
  distanceKm: number | null;
  format: (n: number, o?: Intl.NumberFormatOptions) => string;
  unitSystem: UnitSystem;
}) {
  const total =
    distanceKm != null ? splitFormattedDistance(distanceKm, unitSystem) : null;
  const speedUnit = splitFormattedSpeed(0, unitSystem).unit;
  // KM-per-segment, surface, and character aren't on the segment payload, so
  // the table surfaces the telemetry we do record (avg / max speed, lean,
  // quality) — the design's missing columns degrade rather than fabricate.
  const columns: DataTableColumn<RideSegment & { idx: number }>[] = [
    {
      key: "idx",
      label: "#",
      size: "40px",
      render: (s) => (
        <Mono className="font-bold text-fg-mute">
          {String(s.idx + 1).padStart(2, "0")}
        </Mono>
      ),
    },
    {
      key: "segment",
      label: "SEGMENT",
      primary: true,
      render: (s) => (
        <span className="truncate font-bold text-ink">
          {s.road_name ?? t("Unnamed road")}
        </span>
      ),
    },
    {
      key: "avg",
      label: `AVG ${speedUnit}`,
      size: "100px",
      render: (s) => (
        <Mono className="text-ink">
          {s.speed_avg != null
            ? splitFormattedSpeed(s.speed_avg, unitSystem).value
            : "—"}
        </Mono>
      ),
    },
    {
      key: "max",
      label: `MAX ${speedUnit}`,
      size: "100px",
      render: (s) => (
        <Mono className="text-ink">
          {s.speed_max != null
            ? splitFormattedSpeed(s.speed_max, unitSystem).value
            : "—"}
        </Mono>
      ),
    },
    {
      key: "lean",
      label: "LEAN",
      size: "70px",
      render: (s) => (
        <Mono className="text-ink">
          {s.lean_angle_max != null ? `${Math.round(s.lean_angle_max)}°` : "—"}
        </Mono>
      ),
    },
    {
      key: "quality",
      label: "QUALITY",
      size: "110px",
      render: (s) => {
        const tier = scoreToQualityTier(s.quality_reading);
        return tier != null ? (
          <QualityBars q={tier} size={4} />
        ) : (
          <span className="text-fg-mute">—</span>
        );
      },
    },
  ];
  return (
    <DataTable<RideSegment & { idx: number }>
      ariaLabel={t("Road segments")}
      showCaret={false}
      columns={columns}
      rows={segments.map((s, idx) => ({ ...s, idx }))}
      rowKey={(s) => String(s.idx)}
      header={
        <div className="flex items-center justify-between px-5 py-3">
          <div>
            <Stamp>{t("Road segments")}</Stamp>
            <div className="mt-0.5 text-[15px] font-extrabold text-ink">
              {t("{count} roads ridden", { count: segments.length })}
            </div>
          </div>
          {total != null && (
            <Mono className="text-[11px] text-fg-dim">
              {format(total.value)} {total.unit} {t("TOTAL")}
            </Mono>
          )}
        </div>
      }
    />
  );
}

/** Duration split into a big value + small unit for the MetricTile. */
function splitDuration(min: number | null): { value: string; unit: string } {
  if (min == null) return { value: "—", unit: "" };
  const compact = formatDurationCompact(min); // "4h 12m" or "52m"
  const space = compact.indexOf(" ");
  if (space < 0) return { value: compact, unit: "" };
  return { value: compact.slice(0, space), unit: compact.slice(space + 1) };
}

/**
 * Per-segment speed visualisation (US-48 / T31). The map + tiles give totals;
 * this restores the speed graph the product spec requires for populated rides,
 * unit-aware (km/h vs mph).
 */
function SpeedProfileCard({
  segments,
  unitSystem,
}: {
  segments: RideSegment[];
  unitSystem: UnitSystem;
}) {
  const points = buildSpeedProfile(segments);
  const conv = (kmh: number) =>
    unitSystem === "imperial" ? kmToMiles(kmh) : kmh;
  const unit = splitFormattedSpeed(0, unitSystem).unit;
  const avg = points
    .filter((p) => p.avgKmh != null)
    .map((p) => ({ x: p.segmentNumber, y: conv(p.avgKmh!) }));
  const max = points
    .filter((p) => p.maxKmh != null)
    .map((p) => ({ x: p.segmentNumber, y: conv(p.maxKmh!) }));
  const peak = Math.max(...[...avg, ...max].map((p) => p.y), 1);
  return (
    <Card className="mb-4">
      <div className="flex items-start justify-between">
        <div>
          <Stamp>{t("Speed profile")}</Stamp>
          <div className="mt-1 text-[18px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
            {t("Per-segment speed")}
          </div>
        </div>
        {points.length > 0 && (
          <Mono className="text-[11px] text-fg-dim">
            {Math.round(peak)} {unit} {t("PEAK")}
          </Mono>
        )}
      </div>
      {points.length === 0 ? (
        <div className="mt-4 flex h-[150px] items-center justify-center rounded-xl border border-dashed border-line text-center text-sm text-fg-dim">
          {t("No speed samples were recorded for this ride.")}
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-4 text-[11px] text-fg-dim">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-accent" />
              {t("Avg")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-pink-400" />
              {t("Max")}
            </span>
          </div>
          <SpeedLineChart
            points={avg}
            secondaryPoints={max}
            minY={0}
            maxY={peak}
            unit={unit}
          />
        </>
      )}
    </Card>
  );
}

function SpeedLineChart({
  points,
  secondaryPoints,
  minY,
  maxY,
  unit,
}: {
  points: Array<{ x: number; y: number }>;
  secondaryPoints: Array<{ x: number; y: number }>;
  minY: number;
  maxY: number;
  unit: string;
}) {
  const all = [...points, ...secondaryPoints];
  const minX = Math.min(...all.map((p) => p.x));
  const maxX = Math.max(...all.map((p) => p.x));
  const ySpan = Math.max(maxY - minY, 1);
  const xSpan = Math.max(maxX - minX, 1);
  const project = (p: { x: number; y: number }) => ({
    x: 16 + ((p.x - minX) / xSpan) * 368,
    y: 132 - ((p.y - minY) / ySpan) * 108,
  });
  const renderSeries = (
    series: Array<{ x: number; y: number }>,
    stroke: string,
    width: string,
    dash?: string,
  ) => {
    if (series.length === 0) return null;
    if (series.length === 1) {
      const p = project(series[0]!);
      return <circle cx={p.x} cy={p.y} r="4" fill={stroke} />;
    }
    return (
      <polyline
        points={series
          .map((p) => {
            const q = project(p);
            return `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
          })
          .join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={dash}
      />
    );
  };
  const lastY = all.at(-1)?.y;
  return (
    <div className="mt-4">
      <svg
        viewBox="0 0 400 152"
        className="h-[150px] w-full"
        role="img"
        aria-label={t("Ride speed graph")}
      >
        {[24, 78, 132].map((y) => (
          <line
            key={y}
            x1="16"
            x2="384"
            y1={y}
            y2={y}
            stroke="rgba(14,14,16,0.10)"
            strokeWidth="1"
            strokeDasharray="3 4"
          />
        ))}
        {renderSeries(points, "#FF6A1A", "3")}
        {renderSeries(secondaryPoints, "#f472b6", "2.5", "6 5")}
      </svg>
      <div className="flex items-center justify-between text-[11px] text-fg-mute">
        <span>1</span>
        {lastY != null && (
          <Mono>
            {Math.round(lastY)} {unit}
          </Mono>
        )}
        <span>{maxX}</span>
      </div>
    </div>
  );
}
