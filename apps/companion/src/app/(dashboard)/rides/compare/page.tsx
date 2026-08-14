"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { type EnglishMessageKey, type Translate } from "@/i18n";
import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Scale } from "lucide-react";
import type { components } from "@tarmoto/openapi-client";
import { api } from "@/lib/api";
import {
  Card,
  Combobox,
  Mono,
  QualityBars,
  SkeletonDashboard,
  Stamp,
} from "@tarmoto/ui";
import { RidesScaffold } from "../_RidesScaffold";
import { RidesEmptyState } from "../_RidesEmptyState";
import { useAuthStore } from "@/stores/auth";
import { useFormat } from "@/format/FormatProvider";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import type { QualityTier } from "@/lib/types";
import { QUALITY_CONFIG, rideTypeLabel, scoreToQualityTier } from "@/lib/utils";
import { formatNumber } from "@/lib/ride-detail";
import {
  computeStatRows,
  deltaDirection,
  diffQualityBreakdown,
  type ComparableRide,
  type StatRow,
} from "@/lib/ride-compare";
import type { Formatters } from "@tarmoto/shared";
import { RideRouteMap } from "../_components/RideRouteMap";

/** The `RideSummaryDto` fields the picker dropdown reads. */
type RideOption = Pick<
  components["schemas"]["RideSummaryDto"],
  "id" | "name" | "started_at" | "distance_km" | "duration_min"
>;
/** A compared ride: the comparison subset plus the name + type the cards show. */
type FetchedRide = ComparableRide &
  Pick<components["schemas"]["RideDetailDto"], "name" | "ride_type">;

/** Which slot a card represents — drives the stamp + accent hue. */
type Slot = "a" | "b";
const SLOT_LABEL: Record<Slot, EnglishMessageKey> = {
  a: "Ride A",
  b: "Ride B",
};

function CompareRidesPageInner() {
  const t = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const format = useFormat();
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
          setOptionsError(t("Could not load ride list"));
          return;
        }
        setOptions(data?.rides ?? []);
      })
      .catch(() => {
        if (!cancelled) setOptionsError(t("Could not load ride list"));
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, authReady]);
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
  const insufficientRides =
    !optionsLoading && !optionsError && options.length < 2;
  return (
    <RidesScaffold>
      {optionsError && (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-700"
        >
          {optionsError}
        </div>
      )}

      {insufficientRides ? (
        <RidesEmptyState
          icon={<Scale size={18} strokeWidth={2} />}
          title={t("Need two rides to compare")}
          body={t(
            "Track at least two rides on mobile, then pick any pair to see them side by side.",
          )}
        />
      ) : (
        <CompareBody
          selectedA={selectedA}
          selectedB={selectedB}
          options={options}
          optionsLoading={optionsLoading}
          onChangeA={(id) => updateParams(id, selectedB)}
          onChangeB={(id) => updateParams(selectedA, id)}
          format={format}
        />
      )}
    </RidesScaffold>
  );
}

function CompareBody({
  selectedA,
  selectedB,
  options,
  optionsLoading,
  onChangeA,
  onChangeB,
  format,
}: {
  selectedA: string | null;
  selectedB: string | null;
  options: RideOption[];
  optionsLoading: boolean;
  onChangeA: (id: string) => void;
  onChangeB: (id: string) => void;
  format: Formatters;
}) {
  const t = useTranslation();
  const ready = selectedA && selectedB && selectedA !== selectedB;
  const sameRide =
    selectedA != null && selectedB != null && selectedA === selectedB;
  return (
    <>
      <ComparisonView
        rideAId={ready ? selectedA : null}
        rideBId={ready ? selectedB : null}
        selectedA={selectedA}
        selectedB={selectedB}
        options={options}
        optionsLoading={optionsLoading}
        onChangeA={onChangeA}
        onChangeB={onChangeB}
        format={format}
      />
      {sameRide && (
        <div className="mt-4 rounded-xl border border-quality-q2/40 bg-quality-q2/15 p-4 text-sm text-amber-700">
          {t("Pick two different rides to compare.")}
        </div>
      )}
    </>
  );
}

/**
 * The A/B selector card: stamp + quality glyph, a ride picker, a real-route
 * thumbnail (~120px), and a mono footer (distance · duration · region). Region
 * has no per-ride backing data yet, so it degrades to an em-dash rather than
 * being fabricated.
 */
function ABCard({
  slot,
  value,
  options,
  optionsLoading,
  ride,
  onChange,
  format,
}: {
  slot: Slot;
  value: string | null;
  options: RideOption[];
  optionsLoading: boolean;
  ride: FetchedRide | null;
  onChange: (id: string) => void;
  format: Formatters;
}) {
  const t = useTranslation();
  const selected = options.find((o) => o.id === value) ?? null;
  const slotLabel = t(SLOT_LABEL[slot]);
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const quality = ride ? scoreToQualityTier(ride.avg_road_quality) : null;
  const geometry = ride?.route_geometry ?? null;
  const hasGeometry = geometry != null && geometry.length >= 2;
  const distance = ride?.distance_km ?? selected?.distance_km ?? null;
  const duration = ride?.duration_min ?? selected?.duration_min ?? null;
  // Value and unit both come from the same split call so the footer always
  // matches the rider's unit preference (metric "KM" or imperial "MI")
  // instead of pairing a converted value with a hardcoded label.
  const distanceLabel = distance != null ? format.distanceKm(distance) : "—";
  return (
    <div
      data-testid={`compare-slot-${slot}`}
      className="rounded-[14px] border border-line bg-cream p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        {/* Stamp uppercases via CSS, so the translated "Ride A/B" renders
            as "RIDE A/B" without a separate raw all-caps string. */}
        <Stamp>{slotLabel}</Stamp>
        {/* One gate, at the render: it must remove the em-dash fallback as
            well, which is why gating the derivation instead would not be
            enough — and gating both made neither individually load-bearing. */}
        {!qualityOverlayEnabled ? null : quality != null ? (
          <QualityBars q={quality} size={4} />
        ) : (
          <span className="text-fg-mute">—</span>
        )}
      </div>
      <Combobox
        ariaLabel={t("{slot} selector", { slot: slotLabel })}
        value={value ?? ""}
        onChange={onChange}
        options={options.map((opt) => ({
          value: opt.id,
          label: formatPickerOption(opt, format, t),
        }))}
        disabled={optionsLoading || options.length === 0}
        placeholder={optionsLoading ? t("Loading rides…") : t("Select a ride")}
        className="mb-3"
      />
      {hasGeometry ? (
        <RideRouteMap
          geometry={geometry}
          color={slot === "a" ? "#0ED3CF" : "#F472B6"}
          label={t("{label} route map", { label: slotLabel })}
          containerClassName="h-[120px]"
        />
      ) : (
        <div className="flex h-[120px] items-center justify-center rounded-xl border border-dashed border-line bg-paper text-center text-[11px] text-fg-dim">
          {ride
            ? t("{label} has no GPS track.", { label: slotLabel })
            : t("Select a ride to preview its route.")}
        </div>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Mono className="text-[11px] text-fg-dim">{distanceLabel}</Mono>
        <span className="text-fg-mute">·</span>
        <Mono className="text-[11px] text-fg-dim">
          {duration != null ? format.durationCompact(duration) : "—"}
        </Mono>
        <span className="text-fg-mute">·</span>
        <Mono className="text-[11px] text-fg-dim">{"—"}</Mono>
      </div>
    </div>
  );
}

/** `DD Mon · Name (NN km)` per the design's picker option format — unit
 * follows the rider's preference (`splitDistanceKm`'s own `.unit`), so
 * imperial riders see "(NN mi)" instead of a hardcoded "km". */
function formatPickerOption(
  ride: RideOption,
  format: Formatters,
  t: Translate,
): string {
  const date = format.shortDate(ride.started_at);
  const name = ride.name ?? t("Untitled ride");
  const distance =
    ride.distance_km != null ? format.distanceKm(ride.distance_km) : null;
  const suffix = distance ? ` (${distance})` : "";
  return `${date} · ${name}${suffix}`;
}

function ComparisonView({
  rideAId,
  rideBId,
  selectedA,
  selectedB,
  options,
  optionsLoading,
  onChangeA,
  onChangeB,
  format,
}: {
  rideAId: string | null;
  rideBId: string | null;
  selectedA: string | null;
  selectedB: string | null;
  options: RideOption[];
  optionsLoading: boolean;
  onChangeA: (id: string) => void;
  onChangeB: (id: string) => void;
  format: Formatters;
}) {
  const t = useTranslation();
  // Its own read, like ABCard's — no caller threads this down.
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const [rideA, setRideA] = useState<FetchedRide | null>(null);
  const [rideB, setRideB] = useState<FetchedRide | null>(null);
  const [loading, setLoading] = useState(false);
  // Debounced: fast detail fetches swap straight to the comparison
  // instead of flashing the loader row.
  const showLoader = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  // Both `fetchRide` calls hit the authed detail endpoint — gate the
  // effect on auth so a comparison opened cold doesn't race AuthSync.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  useEffect(() => {
    if (!authReady) return;
    if (!rideAId || !rideBId) {
      setRideA(null);
      setRideB(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRideA(null);
    setRideB(null);
    Promise.all([fetchRide(rideAId), fetchRide(rideBId)])
      .then(([a, b]) => {
        if (cancelled) return;
        if (!a || !b) {
          setError(t("Could not load one or both rides"));
          return;
        }
        setRideA(a);
        setRideB(b);
      })
      .catch(() => {
        if (!cancelled) setError(t("Could not load rides"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, rideAId, rideBId, authReady]);

  const statRows = useMemo(() => {
    if (!rideA || !rideB) return [];
    return computeStatRows(rideA, rideB, t);
  }, [t, rideA, rideB]);
  const qualityDiff = useMemo(() => {
    if (!rideA || !rideB) return [];
    return diffQualityBreakdown(rideA, rideB);
  }, [rideA, rideB]);

  return (
    <div className="space-y-6 animate-slide-up">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ABCard
          slot="a"
          value={selectedA}
          options={options}
          optionsLoading={optionsLoading}
          ride={rideA}
          onChange={onChangeA}
          format={format}
        />
        <ABCard
          slot="b"
          value={selectedB}
          options={options}
          optionsLoading={optionsLoading}
          ride={rideB}
          onChange={onChangeB}
          format={format}
        />
      </div>

      {loading && showLoader && (
        <SkeletonDashboard className="mt-2" label={t("Loading rides…")} />
      )}

      {error && !loading && (
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && rideA && rideB && (
        <>
          <MetricTable
            rideA={rideA}
            rideB={rideB}
            rows={statRows}
            format={format}
          />
          <ElevationCompareSection
            rideA={rideA}
            rideB={rideB}
            format={format}
          />
          {/* The entire section, not its rows: it compares nothing but the
              killed dimension, so an empty shell would be worse than absent. */}
          {qualityOverlayEnabled ? (
            <QualityDiffSection
              rideA={rideA}
              rideB={rideB}
              rows={qualityDiff}
              format={format}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

async function fetchRide(rideId: string): Promise<FetchedRide | null> {
  const { data, error } = await api.GET("/api/v1/rides/{rideId}", {
    params: { path: { rideId } },
  });
  if (error || !data) return null;
  return data;
}

/**
 * Single A | B metric comparison table (design layout: `180px 1fr 1fr`, no
 * delta column — the v2 design is a clean two-column read). The design's
 * canonical rows come first (Distance, Duration, Avg speed, Max lean,
 * Hazards, Region, Ride type); the existing richer metrics (max speed,
 * elevation, avg quality, curve count) are preserved as additional rows so we
 * keep the "amount of data" the user asked us to retain. Hazards + Region have
 * no per-ride backing data, so they render an em-dash rather than fabricating.
 */
function MetricTable({
  rideA,
  rideB,
  rows,
  format,
}: {
  rideA: FetchedRide;
  rideB: FetchedRide;
  rows: StatRow[];
  format: Formatters;
}) {
  const t = useTranslation();
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // Design rows first, in the design's order.
  const cell = (row: StatRow | undefined, side: "a" | "b"): string => {
    if (!row) return "—";
    const v = side === "a" ? row.a : row.b;
    if (v == null) return "—";
    // Unit-bearing metrics convert with the rider's preference. Quality and
    // lean are formatted as complete locale-aware measurements here too.
    switch (row.key) {
      case "distance_km":
        return format.distanceKm(v);
      case "avg_speed":
      case "max_speed":
        return format.speed(v);
      case "elevation_gain":
      case "elevation_loss":
        return format.elevation(v);
      case "avg_road_quality":
        return t("{score} / {max}", {
          score: formatNumber(v, row.digits, format),
          max: format.integer(5),
        });
      case "max_lean_angle":
        return format.number(v, {
          style: "unit",
          unit: "degree",
          unitDisplay: "narrow",
          maximumFractionDigits: row.digits,
        });
      default:
        return formatNumber(v, row.digits, format);
    }
  };
  const durationLabel = (min: number | null): string =>
    min != null ? format.durationCompact(min) : "—";
  const designRows: Array<{ label: string; a: string; b: string }> = [
    {
      label: t("Distance"),
      a: cell(byKey.get("distance_km"), "a"),
      b: cell(byKey.get("distance_km"), "b"),
    },
    {
      label: t("Duration"),
      a: durationLabel(rideA.duration_min),
      b: durationLabel(rideB.duration_min),
    },
    {
      label: t("Avg speed"),
      a: cell(byKey.get("avg_speed"), "a"),
      b: cell(byKey.get("avg_speed"), "b"),
    },
    {
      label: t("Max lean"),
      a: cell(byKey.get("max_lean_angle"), "a"),
      b: cell(byKey.get("max_lean_angle"), "b"),
    },
    // No per-ride hazard count nor region in the ride payload — degrade
    // gracefully rather than inventing numbers (plan decision #5).
    { label: t("Hazards"), a: "—", b: "—" },
    { label: t("Region"), a: "—", b: "—" },
    {
      label: t("Ride type"),
      a: t(rideTypeLabel(rideA.ride_type)),
      b: t(rideTypeLabel(rideB.ride_type)),
    },
    // Preserved richer metrics (kept from the previous compare table).
    {
      label: t("Max speed"),
      a: cell(byKey.get("max_speed"), "a"),
      b: cell(byKey.get("max_speed"), "b"),
    },
    {
      label: t("Elevation gain"),
      a: cell(byKey.get("elevation_gain"), "a"),
      b: cell(byKey.get("elevation_gain"), "b"),
    },
    {
      label: t("Elevation loss"),
      a: cell(byKey.get("elevation_loss"), "a"),
      b: cell(byKey.get("elevation_loss"), "b"),
    },
    // Dropped under the kill. A THIRD quality site on this page, and the one
    // my own enumeration missed — it names the metric in a label rather than
    // through a quality-typed identifier, so it hid from the obvious greps.
    ...(qualityOverlayEnabled
      ? [
          {
            label: t("Avg road quality"),
            a: cell(byKey.get("avg_road_quality"), "a"),
            b: cell(byKey.get("avg_road_quality"), "b"),
          },
        ]
      : []),
    {
      label: t("Curve count"),
      a: cell(byKey.get("curve_count"), "a"),
      b: cell(byKey.get("curve_count"), "b"),
    },
  ];

  const nameA = rideA.name ?? format.shortDate(rideA.started_at);
  const nameB = rideB.name ?? format.shortDate(rideB.started_at);

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="grid grid-cols-[180px_1fr_1fr] border-b border-line bg-paper px-5 py-3 font-mono text-[10px] uppercase tracking-[1.2px] text-fg-mute">
        <span>{t("Metric")}</span>
        <span className="truncate">
          {t("Ride A")} · {nameA}
        </span>
        <span className="truncate">
          {t("Ride B")} · {nameB}
        </span>
      </div>
      {designRows.map((row, i) => (
        <div
          key={row.label}
          className="grid grid-cols-[180px_1fr_1fr] items-center px-5 py-2.5 text-sm text-ink"
          style={
            i % 2 === 1 ? { backgroundColor: "rgba(14,14,16,0.02)" } : undefined
          }
        >
          <span className="text-fg-dim">{row.label}</span>
          <Mono className="text-ink">{row.a}</Mono>
          <Mono className="text-ink">{row.b}</Mono>
        </div>
      ))}
    </Card>
  );
}

function ElevationCompareSection({
  rideA,
  rideB,
  format,
}: {
  rideA: FetchedRide;
  rideB: FetchedRide;
  format: Formatters;
}) {
  const t = useTranslation();
  const max = Math.max(
    rideA.elevation_gain ?? 0,
    rideA.elevation_loss ?? 0,
    rideB.elevation_gain ?? 0,
    rideB.elevation_loss ?? 0,
    1,
  );
  return (
    <Card padded={false} className="p-5">
      <Stamp as="h2">{t("Elevation")}</Stamp>
      <p className="mb-4 mt-1 text-xs text-fg-dim">
        {t(
          "Bars share a scale so gain/loss are visually comparable across both rides.",
        )}
      </p>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/*
          A/B hue convention mirrors the route thumbnails — darker cream-safe
          variants for the bar fill (≥3:1 on paper for the UI cue).
        */}
        <ElevationBars
          label={t("Ride A")}
          color="#0E7A75"
          gain={rideA.elevation_gain}
          loss={rideA.elevation_loss}
          max={max}
          format={format}
        />
        <ElevationBars
          label={t("Ride B")}
          color="#9D2C5C"
          gain={rideB.elevation_gain}
          loss={rideB.elevation_loss}
          max={max}
          format={format}
        />
      </div>
    </Card>
  );
}
function ElevationBars({
  label,
  color,
  gain,
  loss,
  max,
  format,
}: {
  label: string;
  color: string;
  gain: number | null;
  loss: number | null;
  max: number;
  format: Formatters;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color }}
        >
          {label}
        </span>
      </div>
      <ElevationBar
        value={gain}
        max={max}
        color={color}
        kind="gain"
        format={format}
      />
      <ElevationBar
        value={loss}
        max={max}
        color={color}
        kind="loss"
        format={format}
      />
    </div>
  );
}
function ElevationBar({
  value,
  max,
  color,
  kind,
  format,
}: {
  value: number | null;
  max: number;
  color: string;
  kind: "gain" | "loss";
  format: Formatters;
}) {
  const t = useTranslation();
  const pct = value != null ? Math.round((value / max) * 100) : 0;
  const label = kind === "gain" ? t("Gain") : t("Loss");
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-center justify-between text-xs text-fg-dim">
        <span className="inline-flex items-center gap-1">
          {kind === "gain" ? (
            <ArrowRight size={10} className="rotate-[-45deg]" aria-hidden />
          ) : (
            <ArrowRight size={10} className="rotate-[45deg]" aria-hidden />
          )}
          {label}
        </span>
        <span className="tabular-nums text-ink">
          {value == null ? "—" : format.elevation(value)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-paper" aria-hidden>
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
function QualityDiffSection({
  rideA,
  rideB,
  rows,
  format,
}: {
  rideA: FetchedRide;
  rideB: FetchedRide;
  rows: ReturnType<typeof diffQualityBreakdown>;
  format: Formatters;
}) {
  const t = useTranslation();
  const total = rows.reduce((acc, row) => acc + row.percent + row.bPercent, 0);
  const nameA = rideA.name ?? format.shortDate(rideA.started_at);
  const nameB = rideB.name ?? format.shortDate(rideB.started_at);
  return (
    <Card padded={false} className="p-5">
      <Stamp as="h2">{t("Road quality")}</Stamp>
      <p className="mb-4 mt-1 text-xs text-fg-dim">
        {t(
          "Share of segments by quality tier for each ride. Arrows indicate change on Ride B relative to Ride A — improved tiers (more excellent/good, less poor/very-poor) are shown in green.",
        )}
      </p>
      {total === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-6 text-center text-xs text-fg-dim">
          {t("Neither ride recorded per-segment quality readings.")}
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const higherIsBetter = isBetterTier(row.tier);
            const dir = deltaDirection(row.deltaPercent, higherIsBetter, 0);
            const arrow =
              dir === "improved" ? "↑" : dir === "regressed" ? "↓" : "→";
            const arrowColor =
              dir === "improved"
                ? "text-emerald-700"
                : dir === "regressed"
                  ? "text-red-700"
                  : "text-fg-mute";
            return (
              <li
                key={row.tier}
                className="grid grid-cols-12 items-center gap-2 text-sm"
              >
                <div className="col-span-3 flex items-center gap-2 text-ink">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: row.color }}
                  />
                  {t(QUALITY_CONFIG[row.tier].label)}
                </div>
                <div className="col-span-4 flex items-center gap-2 text-xs text-fg-dim">
                  <span className="sr-only">{nameA}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper">
                    <div
                      className="h-full"
                      style={{
                        width: `${row.percent}%`,
                        backgroundColor: row.color,
                      }}
                    />
                  </div>
                  <span className="w-10 text-right tabular-nums">
                    {format.percent(row.percent / 100)}
                  </span>
                </div>
                <div className="col-span-4 flex items-center gap-2 text-xs text-fg-dim">
                  <span className="sr-only">{nameB}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper">
                    <div
                      className="h-full"
                      style={{
                        width: `${row.bPercent}%`,
                        backgroundColor: row.color,
                      }}
                    />
                  </div>
                  <span className="w-10 text-right tabular-nums">
                    {format.percent(row.bPercent / 100)}
                  </span>
                </div>
                <div
                  className={`col-span-1 text-right text-xs font-semibold tabular-nums ${arrowColor}`}
                >
                  {arrow}
                  {row.deltaPercent === 0
                    ? ""
                    : ` ${format.integer(
                        Math.abs(Math.round(row.deltaPercent)),
                      )}`}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
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
