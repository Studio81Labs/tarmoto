"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Scale,
  TrendingDown,
  TrendingUp,
  Minus,
} from "lucide-react";
import { api } from "@/lib/api";
import type { QualityTier } from "@/lib/types";
import { QUALITY_CONFIG } from "@/lib/utils";
import {
  buildUnifiedRoutePreview,
  computeStatRows,
  deltaDirection,
  diffQualityBreakdown,
  formatDelta,
  formatStatValue,
  type ComparableRide,
  type DeltaDirection,
  type StatRow,
} from "@/lib/ride-compare";

/** Subset of `RideSummaryDto` fields we use in the picker. */
interface RideOption {
  id: string;
  started_at: string;
  distance_km: number | null;
  duration_min: number | null;
}

interface FetchedRide extends ComparableRide {
  ride_type: string;
}

function CompareRidesPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const selectedA = searchParams.get("a");
  const selectedB = searchParams.get("b");

  const [options, setOptions] = useState<RideOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOptionsLoading(true);
    api
      .GET("/api/v1/rides", { params: { query: { limit: 100 } } })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setOptionsError("Could not load ride list");
          return;
        }
        const rides = (data?.rides ?? []) as unknown as RideOption[];
        setOptions(rides);
      })
      .catch(() => {
        if (!cancelled) setOptionsError("Could not load ride list");
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-pick sensible defaults (two most recent rides) once options are
  // loaded and no selection is present in the URL. Users can still change
  // either slot via the dropdowns.
  useEffect(() => {
    if (optionsLoading) return;
    if (options.length < 2) return;
    if (selectedA && selectedB) return;
    const nextA = selectedA ?? options[0]!.id;
    const nextB = selectedB ?? options.find((r) => r.id !== nextA)?.id;
    if (nextA && nextB && (nextA !== selectedA || nextB !== selectedB)) {
      updateParams(nextA, nextB, { replace: true });
    }
    // We only want to run this after load; deps are intentionally narrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsLoading, options.length]);

  function updateParams(
    a: string | null,
    b: string | null,
    { replace = false }: { replace?: boolean } = {},
  ) {
    const params = new URLSearchParams(searchParams.toString());
    if (a) params.set("a", a);
    else params.delete("a");
    if (b) params.set("b", b);
    else params.delete("b");
    const url = params.toString() ? `${pathname}?${params}` : pathname;
    if (replace) router.replace(url, { scroll: false });
    else router.push(url, { scroll: false });
  }

  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <div className="flex items-center gap-4 mb-6">
        <Link
          href="/rides"
          className="p-2 rounded-lg hover:bg-slate-800 transition"
          aria-label="Back to rides"
        >
          <ArrowLeft size={20} className="text-slate-400" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Scale size={22} className="text-tarmoto-cyan" /> Compare rides
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Pick two rides to see stats, route, and road quality side-by-side.
          </p>
        </div>
      </div>

      {optionsError && (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300"
        >
          {optionsError}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <RidePicker
          label="Ride A"
          value={selectedA}
          options={options}
          loading={optionsLoading}
          onChange={(id) => updateParams(id, selectedB)}
        />
        <RidePicker
          label="Ride B"
          value={selectedB}
          options={options}
          loading={optionsLoading}
          onChange={(id) => updateParams(selectedA, id)}
        />
      </div>

      {options.length < 2 && !optionsLoading && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-10 text-center text-sm text-slate-400">
          You need at least two rides to run a comparison. Keep riding with the
          Tarmoto mobile app!
        </div>
      )}

      {selectedA && selectedB && selectedA !== selectedB && (
        <ComparisonView rideAId={selectedA} rideBId={selectedB} />
      )}

      {selectedA && selectedB && selectedA === selectedB && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200">
          Pick two different rides to compare.
        </div>
      )}
    </div>
  );
}

function RidePicker({
  label,
  value,
  options,
  loading,
  onChange,
}: {
  label: string;
  value: string | null;
  options: RideOption[];
  loading: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <label className="block rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <span className="block text-xs uppercase tracking-wider text-slate-500 mb-2">
        {label}
      </span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading || options.length === 0}
        className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:outline-none focus:border-tarmoto-cyan disabled:opacity-50"
      >
        <option value="" disabled>
          {loading ? "Loading rides…" : "Select a ride"}
        </option>
        {options.map((ride) => (
          <option key={ride.id} value={ride.id}>
            {formatRideOption(ride)}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatRideOption(ride: RideOption): string {
  const date = new Date(ride.started_at).toLocaleDateString();
  const distance =
    ride.distance_km != null ? ` · ${ride.distance_km.toFixed(1)} km` : "";
  return `${date}${distance}`;
}

function ComparisonView({
  rideAId,
  rideBId,
}: {
  rideAId: string;
  rideBId: string;
}) {
  const [rideA, setRideA] = useState<FetchedRide | null>(null);
  const [rideB, setRideB] = useState<FetchedRide | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRideA(null);
    setRideB(null);
    Promise.all([fetchRide(rideAId), fetchRide(rideBId)])
      .then(([a, b]) => {
        if (cancelled) return;
        if (!a || !b) {
          setError("Could not load one or both rides");
          return;
        }
        setRideA(a);
        setRideB(b);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load rides");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rideAId, rideBId]);

  const unified = useMemo(() => {
    if (!rideA || !rideB) return null;
    return buildUnifiedRoutePreview(rideA, rideB, 600, 16);
  }, [rideA, rideB]);
  const statRows = useMemo(() => {
    if (!rideA || !rideB) return [];
    return computeStatRows(rideA, rideB);
  }, [rideA, rideB]);
  const qualityDiff = useMemo(() => {
    if (!rideA || !rideB) return [];
    return diffQualityBreakdown(rideA, rideB);
  }, [rideA, rideB]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 mt-4">
        <Loader2 size={16} className="animate-spin" /> Loading rides…
      </div>
    );
  }

  if (error || !rideA || !rideB) {
    return (
      <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
        {error ?? "Could not load rides"}
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-slide-up">
      <RouteCompareSection rideA={rideA} rideB={rideB} unified={unified} />
      <StatsTable rows={statRows} />
      <ElevationCompareSection rideA={rideA} rideB={rideB} />
      <QualityDiffSection rows={qualityDiff} />
    </div>
  );
}

async function fetchRide(rideId: string): Promise<FetchedRide | null> {
  const { data, error } = await api.GET("/api/v1/rides/{rideId}", {
    params: { path: { rideId } },
  });
  if (error || !data) return null;
  return data as unknown as FetchedRide;
}

function RouteCompareSection({
  rideA,
  rideB,
  unified,
}: {
  rideA: FetchedRide;
  rideB: FetchedRide;
  unified: ReturnType<typeof buildUnifiedRoutePreview> | null;
}) {
  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
      <h2 className="text-sm font-semibold text-white mb-1">
        Routes (same scale)
      </h2>
      <p className="text-xs text-slate-500 mb-4">
        Both tracks projected into a shared coordinate frame so the visual
        comparison is meaningful. Zoom/pan is synced because the viewBox is
        shared.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <RouteBox
          label="Ride A"
          meta={rideHeaderMeta(rideA)}
          svg={unified?.a?.path}
          viewBox={unified?.viewBox}
          color="#0ED3CF"
        />
        <RouteBox
          label="Ride B"
          meta={rideHeaderMeta(rideB)}
          svg={unified?.b?.path}
          viewBox={unified?.viewBox}
          color="#F472B6"
        />
      </div>
    </section>
  );
}

function rideHeaderMeta(ride: FetchedRide): string {
  const date = new Date(ride.started_at).toLocaleDateString();
  const dist =
    ride.distance_km != null ? ` · ${ride.distance_km.toFixed(1)} km` : "";
  return `${date}${dist}`;
}

function RouteBox({
  label,
  meta,
  svg,
  viewBox,
  color,
}: {
  label: string;
  meta: string;
  svg: string | undefined;
  viewBox: string | undefined;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
      <div className="flex items-center justify-between mb-3">
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color }}
        >
          {label}
        </span>
        <span className="text-[11px] text-slate-500">{meta}</span>
      </div>
      {svg && viewBox ? (
        <svg
          viewBox={viewBox}
          className="w-full max-h-72"
          role="img"
          aria-label={`${label} route preview`}
        >
          <path
            d={svg}
            fill="none"
            stroke={color}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-800 p-8 text-center text-xs text-slate-500">
          No GPS track recorded
        </div>
      )}
    </div>
  );
}

function StatsTable({ rows }: { rows: StatRow[] }) {
  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
      <h2 className="text-sm font-semibold text-white mb-1">Stats overlay</h2>
      <p className="text-xs text-slate-500 mb-4">
        Delta column is B − A. Arrow color reflects whether higher values are
        better for that metric.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="py-2 pr-4 font-semibold">Metric</th>
              <th className="py-2 pr-4 font-semibold text-right">Ride A</th>
              <th className="py-2 pr-4 font-semibold text-right">Ride B</th>
              <th className="py-2 pr-0 font-semibold text-right">Δ (B − A)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((row) => {
              const dir = deltaDirection(
                row.delta,
                row.higherIsBetter,
                row.digits,
              );
              return (
                <tr key={row.key} className="text-slate-200">
                  <td className="py-2 pr-4">{row.label}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatStatValue(row.a, row.digits)}
                    {row.unit && (
                      <span className="text-slate-500 ml-1">{row.unit}</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatStatValue(row.b, row.digits)}
                    {row.unit && (
                      <span className="text-slate-500 ml-1">{row.unit}</span>
                    )}
                  </td>
                  <td className="py-2 pr-0 text-right tabular-nums">
                    <DeltaChip
                      delta={row.delta}
                      digits={row.digits}
                      direction={dir}
                      unit={row.unit}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DeltaChip({
  delta,
  digits,
  direction,
  unit,
}: {
  delta: number | null;
  digits: number;
  direction: DeltaDirection;
  unit?: string;
}) {
  const color =
    direction === "improved"
      ? "text-quality-excellent"
      : direction === "regressed"
        ? "text-quality-very-poor"
        : "text-slate-400";
  const Icon =
    direction === "improved"
      ? TrendingUp
      : direction === "regressed"
        ? TrendingDown
        : Minus;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-semibold ${color}`}
    >
      <Icon size={12} aria-hidden />
      <span>
        {formatDelta(delta, digits)}
        {unit && delta != null && (
          <span className="text-slate-500 ml-1 font-normal">{unit}</span>
        )}
      </span>
    </span>
  );
}

function ElevationCompareSection({
  rideA,
  rideB,
}: {
  rideA: FetchedRide;
  rideB: FetchedRide;
}) {
  const max = Math.max(
    rideA.elevation_gain ?? 0,
    rideA.elevation_loss ?? 0,
    rideB.elevation_gain ?? 0,
    rideB.elevation_loss ?? 0,
    1,
  );
  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
      <h2 className="text-sm font-semibold text-white mb-1">Elevation</h2>
      <p className="text-xs text-slate-500 mb-4">
        Bars share a scale so gain/loss are visually comparable across both
        rides.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ElevationBars
          label="Ride A"
          color="#0ED3CF"
          gain={rideA.elevation_gain}
          loss={rideA.elevation_loss}
          max={max}
        />
        <ElevationBars
          label="Ride B"
          color="#F472B6"
          gain={rideB.elevation_gain}
          loss={rideB.elevation_loss}
          max={max}
        />
      </div>
    </section>
  );
}

function ElevationBars({
  label,
  color,
  gain,
  loss,
  max,
}: {
  label: string;
  color: string;
  gain: number | null;
  loss: number | null;
  max: number;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color }}
        >
          {label}
        </span>
      </div>
      <ElevationBar value={gain} max={max} color={color} kind="gain" />
      <ElevationBar value={loss} max={max} color={color} kind="loss" />
    </div>
  );
}

function ElevationBar({
  value,
  max,
  color,
  kind,
}: {
  value: number | null;
  max: number;
  color: string;
  kind: "gain" | "loss";
}) {
  const pct = value != null ? Math.round((value / max) * 100) : 0;
  const label = kind === "gain" ? "Gain" : "Loss";
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
        <span className="inline-flex items-center gap-1">
          {kind === "gain" ? (
            <ArrowRight size={10} className="rotate-[-45deg]" aria-hidden />
          ) : (
            <ArrowRight size={10} className="rotate-[45deg]" aria-hidden />
          )}
          {label}
        </span>
        <span className="tabular-nums text-slate-300">
          {value == null ? "—" : `${Math.round(value)} m`}
        </span>
      </div>
      <div
        className="h-2 rounded-full bg-slate-800 overflow-hidden"
        aria-hidden
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function QualityDiffSection({
  rows,
}: {
  rows: ReturnType<typeof diffQualityBreakdown>;
}) {
  const total = rows.reduce((acc, row) => acc + row.percent + row.bPercent, 0);
  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
      <h2 className="text-sm font-semibold text-white mb-1">Road quality</h2>
      <p className="text-xs text-slate-500 mb-4">
        Share of segments by quality tier. Arrows indicate change on Ride B
        relative to Ride A — improved tiers (more excellent/good, less
        poor/very-poor) are shown in green.
      </p>
      {total === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-xs text-slate-500">
          Neither ride recorded per-segment quality readings.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const higherIsBetter = isBetterTier(row.tier);
            const dir = deltaDirection(row.deltaPercent, higherIsBetter, 0);
            return (
              <li
                key={row.tier}
                className="grid grid-cols-12 items-center gap-2 text-sm"
              >
                <div className="col-span-3 flex items-center gap-2 text-slate-300">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: row.color }}
                  />
                  {QUALITY_CONFIG[row.tier].label}
                </div>
                <div className="col-span-4 flex items-center gap-2 text-xs text-slate-400">
                  <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${row.percent}%`,
                        backgroundColor: row.color,
                      }}
                    />
                  </div>
                  <span className="tabular-nums w-10 text-right">
                    {row.percent}%
                  </span>
                </div>
                <div className="col-span-4 flex items-center gap-2 text-xs text-slate-400">
                  <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${row.bPercent}%`,
                        backgroundColor: row.color,
                      }}
                    />
                  </div>
                  <span className="tabular-nums w-10 text-right">
                    {row.bPercent}%
                  </span>
                </div>
                <div className="col-span-1 text-right tabular-nums">
                  <DeltaChip
                    delta={row.deltaPercent}
                    digits={0}
                    direction={dir}
                    unit="pp"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// More segments in the top tiers is better; more in the bottom tiers is worse.
// Fair is neutral so it doesn't get flagged either way.
function isBetterTier(tier: QualityTier): boolean | null {
  switch (tier) {
    case "excellent":
    case "good":
      return true;
    case "poor":
    case "very-poor":
      return false;
    default:
      return null;
  }
}

export default function CompareRidesPage() {
  return (
    <Suspense fallback={null}>
      <CompareRidesPageInner />
    </Suspense>
  );
}
