"use client";
import { t } from "@/i18n";
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
import { useAuthStore } from "@/stores/auth";
import type { QualityTier } from "@/lib/types";
import { QUALITY_CONFIG } from "@/lib/utils";
import { formatNumber } from "@/lib/ride-detail";
import {
  computeStatRows,
  deltaDirection,
  diffQualityBreakdown,
  formatDelta,
  type ComparableRide,
  type DeltaDirection,
  type StatRow,
} from "@/lib/ride-compare";
import { RideRouteMap, type RouteMapBounds } from "../_components/RideRouteMap";
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
  // Wait for `AuthSync` to populate the bearer token; without this the
  // initial GET races and 401s, the dropdowns stay disabled, and the
  // compare flow never gets off the ground.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  useEffect(() => {
    if (!authReady) return;
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
  }, [authReady]);
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
    {
      replace = false,
    }: {
      replace?: boolean;
    } = {},
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
          className="p-2 rounded-lg hover:bg-paper transition"
          aria-label={t("Back to rides")}
        >
          <ArrowLeft size={20} className="text-fg-dim" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Scale size={22} className="text-accent" />
            {t("Compare rides ")}
          </h1>
          <p className="text-sm text-fg-dim mt-0.5">
            {t(
              "Pick two rides to see stats, route, and road quality side-by-side. ",
            )}
          </p>
        </div>
      </div>

      {optionsError && (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-400"
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

      {options.length < 2 && !optionsLoading && !optionsError && (
        <div className="rounded-2xl border border-line bg-cream p-10 text-center text-sm text-fg-dim">
          {t(
            "You need at least two rides to run a comparison. Keep riding with the Tarmoto mobile app! ",
          )}
        </div>
      )}

      {selectedA && selectedB && selectedA !== selectedB && (
        <ComparisonView rideAId={selectedA} rideBId={selectedB} />
      )}

      {selectedA && selectedB && selectedA === selectedB && (
        <div className="rounded-xl border border-quality-q2/40 bg-quality-q2/15 p-4 text-sm text-amber-700">
          {t("Pick two different rides to compare. ")}
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
    <label className="block rounded-2xl border border-line bg-cream p-4">
      <span className="block text-xs uppercase tracking-wider text-fg-dim mb-2">
        {label}
      </span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading || options.length === 0}
        className="w-full rounded-lg border border-line-strong bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:border-ink disabled:opacity-50"
      >
        <option value="" disabled>
          {loading ? "Loading rides…" : "Select a ride"}
        </option>
        {options.map((ride) => (
          <option key={ride.id} value={ride.id}>
            {formatRideMeta(ride)}
          </option>
        ))}
      </select>
    </label>
  );
}
function formatRideMeta(ride: {
  started_at: string;
  distance_km: number | null;
}): string {
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
  // Both `fetchRide` calls hit the authed detail endpoint — gate the
  // effect on auth so a comparison opened cold doesn't race AuthSync.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  useEffect(() => {
    if (!authReady) return;
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
  }, [rideAId, rideBId, authReady]);
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
      <div className="flex items-center gap-2 text-fg-dim mt-4">
        <Loader2 size={16} className="animate-spin" />
        {t("Loading rides\u2026 ")}
      </div>
    );
  }
  if (error || !rideA || !rideB) {
    return (
      <div className="mt-4 rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-400">
        {error ?? "Could not load rides"}
      </div>
    );
  }
  return (
    <div className="space-y-6 animate-slide-up">
      <RouteCompareSection rideA={rideA} rideB={rideB} />
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
}: {
  rideA: FetchedRide;
  rideB: FetchedRide;
}) {
  const sharedBounds = useMemo(
    () => buildSharedRouteBounds(rideA.route_geometry, rideB.route_geometry),
    [rideA.route_geometry, rideB.route_geometry],
  );

  return (
    <section className="rounded-2xl bg-cream border border-line p-5">
      <h2 className="text-sm font-semibold text-ink mb-1">{t("Route maps")}</h2>
      <p className="text-xs text-fg-dim mb-4">
        {t(
          "Side-by-side interactive maps show each ride route over the same road quality overlay used elsewhere in Tarmoto.",
        )}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <RouteBox
          label="Ride A"
          meta={formatRideMeta(rideA)}
          geometry={rideA.route_geometry}
          color="#0ED3CF"
          labelColor="#0E7A75"
          fitBounds={sharedBounds}
        />
        <RouteBox
          label="Ride B"
          meta={formatRideMeta(rideB)}
          geometry={rideB.route_geometry}
          color="#F472B6"
          labelColor="#9D2C5C"
          fitBounds={sharedBounds}
        />
      </div>
    </section>
  );
}
// `color` paints the map route line (chosen for visibility on the cream
// basemap). `labelColor` is the darker, cream-safe text colour for the
// "Ride A/B" label — using the map hue directly on a paper-tinted card
// drops to ~1.5:1 / ~2.1:1, well below AA. Callers pass a hue-matched
// darker variant so the A/B colour-cue is preserved in both surfaces.
function RouteBox({
  label,
  meta,
  geometry,
  color,
  labelColor,
  fitBounds,
}: {
  label: string;
  meta: string;
  geometry: FetchedRide["route_geometry"];
  color: string;
  labelColor: string;
  fitBounds: RouteMapBounds | null;
}) {
  const hasGeometry = geometry != null && geometry.length >= 2;
  return (
    <div className="rounded-xl border border-line bg-paper p-4">
      <div className="flex items-center justify-between mb-3">
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: labelColor }}
        >
          {label}
        </span>
        <span className="text-[11px] text-fg-dim">{meta}</span>
      </div>
      {hasGeometry ? (
        <RideRouteMap
          geometry={geometry}
          color={color}
          label={`${label} interactive route map`}
          fitBounds={fitBounds}
        />
      ) : (
        <div className="rounded-lg border border-dashed border-line p-8 text-center text-xs text-fg-dim">
          {t("{label} has no GPS track.", { label })}
        </div>
      )}
    </div>
  );
}

function buildSharedRouteBounds(
  a: FetchedRide["route_geometry"],
  b: FetchedRide["route_geometry"],
): RouteMapBounds | null {
  const aValid = validRoutePoints(a);
  const bValid = validRoutePoints(b);
  if (aValid.length < 2 || bValid.length < 2) return null;

  const all = [...aValid, ...bValid];
  return all.reduce<RouteMapBounds>(
    (bounds, point) => ({
      minLng: Math.min(bounds.minLng, point.lng),
      minLat: Math.min(bounds.minLat, point.lat),
      maxLng: Math.max(bounds.maxLng, point.lng),
      maxLat: Math.max(bounds.maxLat, point.lat),
    }),
    {
      minLng: Infinity,
      minLat: Infinity,
      maxLng: -Infinity,
      maxLat: -Infinity,
    },
  );
}

function validRoutePoints(
  geometry: FetchedRide["route_geometry"],
): Array<{ lat: number; lng: number }> {
  return (geometry ?? []).filter(
    (point): point is { lat: number; lng: number } =>
      Number.isFinite(point.lat) &&
      Number.isFinite(point.lng) &&
      Math.abs(point.lat) <= 90 &&
      Math.abs(point.lng) <= 180,
  );
}

function StatsTable({ rows }: { rows: StatRow[] }) {
  return (
    <section className="rounded-2xl bg-cream border border-line p-5">
      <h2 className="text-sm font-semibold text-ink mb-1">{t("Stats diff")}</h2>
      <p className="text-xs text-fg-dim mb-4">
        {t(
          "Delta column is B \u2212 A. Arrow color reflects whether higher values are better for that metric. ",
        )}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-fg-dim">
              <th className="py-2 pr-4 font-semibold">{t("Metric")}</th>
              <th className="py-2 pr-4 font-semibold text-right">
                {t("Ride A")}
              </th>
              <th className="py-2 pr-4 font-semibold text-right">
                {t("Ride B")}
              </th>
              <th className="py-2 pr-0 font-semibold text-right">
                {t("\u0394 (B \u2212 A)")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => {
              const dir = deltaDirection(
                row.delta,
                row.higherIsBetter,
                row.digits,
              );
              return (
                <tr key={row.key} className="text-ink">
                  <td className="py-2 pr-4">{row.label}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatNumber(row.a, row.digits)}
                    {row.unit && (
                      <span className="text-fg-dim ml-1">{row.unit}</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatNumber(row.b, row.digits)}
                    {row.unit && (
                      <span className="text-fg-dim ml-1">{row.unit}</span>
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
  // Delta chips sit inside cream stat cards. text-quality-excellent
  // (canonical q5 #6FD38A) and text-quality-very-poor (q1 #E05A3C) are
  // surface hues — they fail WCAG AA as small text on cream
  // (~1.6:1 / ~3.2:1). Route through darker, cream-safe tokens:
  // text-emerald-700 (~7.5:1 native dark green) and text-red-400
  // (auto-remapped to #b91c1c on cream surfaces, ~5.7:1).
  const color =
    direction === "improved"
      ? "text-emerald-700"
      : direction === "regressed"
        ? "text-red-400"
        : "text-fg-dim";
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
          <span className="text-fg-dim ml-1 font-normal">{unit}</span>
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
    <section className="rounded-2xl bg-cream border border-line p-5">
      <h2 className="text-sm font-semibold text-ink mb-1">{t("Elevation")}</h2>
      <p className="text-xs text-fg-dim mb-4">
        {t(
          "Bars share a scale so gain/loss are visually comparable across both rides. ",
        )}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/*
          Same A/B hue convention as RouteBox above — but ElevationBars has
          no map context, so we pass only the darker cream-safe variant
          (≥5:1 on cream, ≥3:1 on paper for the bar-fill UI cue).
        */}
        <ElevationBars
          label="Ride A"
          color="#0E7A75"
          gain={rideA.elevation_gain}
          loss={rideA.elevation_loss}
          max={max}
        />
        <ElevationBars
          label="Ride B"
          color="#9D2C5C"
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
      <div className="flex items-center justify-between text-xs text-fg-dim mb-1">
        <span className="inline-flex items-center gap-1">
          {kind === "gain" ? (
            <ArrowRight size={10} className="rotate-[-45deg]" aria-hidden />
          ) : (
            <ArrowRight size={10} className="rotate-[45deg]" aria-hidden />
          )}
          {label}
        </span>
        <span className="tabular-nums text-ink">
          {value == null ? "—" : `${Math.round(value)} m`}
        </span>
      </div>
      <div className="h-2 rounded-full bg-paper overflow-hidden" aria-hidden>
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
    <section className="rounded-2xl bg-cream border border-line p-5">
      <h2 className="text-sm font-semibold text-ink mb-1">
        {t("Road quality")}
      </h2>
      <p className="text-xs text-fg-dim mb-4">
        {t(
          "Share of segments by quality tier. Arrows indicate change on Ride B relative to Ride A \u2014 improved tiers (more excellent/good, less poor/very-poor) are shown in green. ",
        )}
      </p>
      {total === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-6 text-center text-xs text-fg-dim">
          {t("Neither ride recorded per-segment quality readings. ")}
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
                <div className="col-span-3 flex items-center gap-2 text-ink">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: row.color }}
                  />
                  {QUALITY_CONFIG[row.tier].label}
                </div>
                <div className="col-span-4 flex items-center gap-2 text-xs text-fg-dim">
                  <div className="flex-1 h-1.5 rounded-full bg-paper overflow-hidden">
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
                <div className="col-span-4 flex items-center gap-2 text-xs text-fg-dim">
                  <div className="flex-1 h-1.5 rounded-full bg-paper overflow-hidden">
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
