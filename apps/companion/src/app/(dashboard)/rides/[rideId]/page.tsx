"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  notFound as renderNotFound,
  useParams,
  usePathname,
} from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Check, Lock, Pencil, Scale, Share2, X } from "lucide-react";
import {
  Button,
  Card,
  DataTable,
  MetricTile,
  Mono,
  QualityBars,
  SkeletonDashboard,
  Stamp,
  type DataTableColumn,
  type MetricTileProps,
} from "@tarmoto/ui";
import type { components } from "@tarmoto/openapi-client";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/stores/auth";
import { useEntitlements, useFeature, useFeatureGrantNonce } from "@/hooks";
import { UserAvatar } from "@/components/UserAvatar";
import { LockedFeatureCard } from "@/components/entitlements/LockedFeatureCard";
import { LockedStatTile } from "@/components/entitlements/LockedStatTile";
import { useFormat } from "@/format/FormatProvider";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { rideTypeLabel, scoreToQualityTier } from "@/lib/utils";
import { buildSpeedProfile, formatNumber } from "@/lib/ride-detail";
import { splitRideDetailDuration } from "./ride-detail-format";
import {
  formatSplitValueUnit,
  kmToMiles,
  type Formatters,
} from "@tarmoto/shared";
import { downloadRideExport } from "@/lib/ride-export";
import { RideExportMenu } from "../_components/RideExportMenu";
import { RideRouteMap } from "../_components/RideRouteMap";

// The ride detail endpoint's response, straight off the generated OpenAPI
// contract — a backend field change surfaces here at typecheck time. The
// nested segment + lean-distribution shapes come from the same source.
type RideDetail = components["schemas"]["RideDetailDto"];
type RideSegment = components["schemas"]["RideSegmentDto"];
type LeanDistribution = components["schemas"]["LeanDistributionDto"];

// Lean buckets the backend reports (US-19). The v2 "Time spent leaning" chart
// uses these 4 buckets directly rather than the design mock's 5 — we render the
// data we actually have rather than fabricating finer bands.
const LEAN_BUCKETS: Array<{
  key: keyof LeanDistribution;
  min: number;
  max: number | null;
  mid: number;
}> = [
  { key: "0_10", min: 0, max: 10, mid: 5 },
  { key: "10_20", min: 10, max: 20, mid: 15 },
  { key: "20_30", min: 20, max: 30, mid: 25 },
  { key: "30_plus", min: 30, max: null, mid: 35 },
];

export default function RideDetailPage() {
  const t = useTranslation();
  const { rideId } = useParams<{ rideId: string }>();
  // The same detail view is mounted under `/rides/:id` (ride history) and
  // `/community/rides/:id` (community). Drive the back link from the route so
  // the nav context stays consistent regardless of who owns the ride.
  const pathname = usePathname();
  const fromCommunity = pathname?.startsWith("/community/") ?? false;
  const backHref = fromCommunity ? "/community/feed" : "/rides";
  const backLabel = fromCommunity
    ? t("Community · Feed")
    : t("Ride History · All rides");
  const format = useFormat();
  // Advanced ride stats (lean angle, elevation gain/loss, lean distribution)
  // are a Pro toggle — the backend already nulls these fields for a
  // non-entitled rider, so `advancedStatsLocked` also covers the "resolved
  // and not enabled" case defensively.
  //
  // Precedence, in order:
  //   1. Once ANY snapshot has resolved (`dataUpdatedAt > 0`), trust its
  //      retained `enabled` value — React Query keeps the last successful data
  //      through a later refetch error. A cached ENABLED stays unlocked (an
  //      entitled rider whose /users/me refetch failed keeps their real
  //      values); a cached DENIAL stays LOCKED (a revoked rider is not
  //      re-exposed to the stale advanced fields just because the refetch
  //      errored).
  //   2. No snapshot ever + the lookup errored → defer to the ride payload
  //      (the backend already gated server-side for this request), so we don't
  //      flash a paywall teaser at a rider we can't classify.
  //   3. No snapshot yet, still loading → fail closed (locked).
  const {
    enabled: advancedStatsEnabled,
    isError: advancedStatsError,
    dataUpdatedAt: advancedStatsDataUpdatedAt,
  } = useFeature("advanced_ride_stats");
  const advancedStatsHasSnapshot = advancedStatsDataUpdatedAt > 0;
  const advancedStatsLocked = advancedStatsHasSnapshot
    ? !advancedStatsEnabled
    : advancedStatsError
      ? false
      : true;
  // When advanced_ride_stats flips disabled→enabled while this page stays
  // mounted (an upgrade in another tab, or an operator re-enabling the flag),
  // the retained payload — fetched while the fields were server-nulled — must
  // be refreshed or the newly-entitled rider sees empty lean/elevation
  // sections. This nonce bumps on that transition and re-arms the fetch below.
  const advancedStatsGrantNonce = useFeatureGrantNonce("advanced_ride_stats");
  const { tier } = useEntitlements();
  const [ride, setRide] = useState<RideDetail | null>(null);
  const [loading, setLoading] = useState(true);
  // Debounced: fast loads swap straight to content instead of flashing the
  // spinner for a frame or two.
  const showLoader = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // Gate the fetch on the access token being hydrated by AuthSync (same
  // pattern as useRidesQuery) so the first GET carries a Bearer header.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  // A grant-triggered refetch (advanced_ride_stats just unlocked) is SILENT: it
  // swaps fresh data in place without flashing the full-page skeleton, and it
  // preserves the current view on failure rather than blowing it away — the
  // rider is already looking at a valid ride, we're only enriching it.
  const grantNonceRef = useRef(advancedStatsGrantNonce);
  // Mirror `ride` into a ref so the fetch effect can tell an enrichment
  // (a ride for THIS id is already on screen) from an unlock that lands while
  // the FIRST load is still pending — without adding `ride` to the effect's
  // deps (which would re-fetch on every load). A silent refetch only makes
  // sense as an enrichment of the SAME ride; with no ride yet it must behave as
  // a normal load so success clears the skeleton and a failure surfaces an
  // error.
  const rideRef = useRef<RideDetail | null>(ride);
  useEffect(() => {
    rideRef.current = ride;
  }, [ride]);
  useEffect(() => {
    if (!rideId || !authReady) return;
    // Require the cached ride to match the CURRENT id: on a same-render
    // rideId-change + nonce-advance, the previously-loaded ride must not make
    // the new-id request look like a silent enrichment (which would suppress a
    // failure and keep showing the old ride under the new URL). Mirrors the
    // explorer's `readyForSelected`.
    const isGrantRefetch =
      advancedStatsGrantNonce !== grantNonceRef.current &&
      rideRef.current?.id === rideId;
    grantNonceRef.current = advancedStatsGrantNonce;
    let cancelled = false;
    if (!isGrantRefetch) {
      setLoading(true);
      setError(null);
      setNotFound(false);
    }
    api
      .GET("/api/v1/rides/{rideId}", { params: { path: { rideId } } })
      .then(({ data, error: apiError, response }) => {
        if (cancelled) return;
        // 400 = a malformed id in the URL — as dead a link as a missing
        // ride, so both land on the global 404 screen.
        if (response?.status === 404 || response?.status === 400) {
          setNotFound(true);
          return;
        }
        if (apiError || !data) {
          // On a silent grant-refetch, keep the ride the rider is already
          // viewing rather than replacing it with a full error page.
          if (!isGrantRefetch) setError(t("Could not load ride"));
          return;
        }
        setRide(data);
      })
      .catch(() => {
        if (!cancelled && !isGrantRefetch) setError(t("Could not load ride"));
      })
      .finally(() => {
        if (!cancelled && !isGrantRefetch) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, rideId, authReady, advancedStatsGrantNonce]);

  async function handleShare() {
    if (typeof window === "undefined" || !ride) return;
    // Copy the public, no-auth share link (/rides/shared/:token) so a logged-
    // out recipient can open the ride — never the auth-gated dashboard URL.
    let token = ride.share_token;
    if (!token && ride.viewer_is_owner) {
      // The owner hasn't shared this ride yet. Create a link-only share (not
      // published to the community feed) so they still get a working link —
      // the token resolves regardless of `is_public`.
      try {
        const { data } = await api.POST("/api/v1/rides/{rideId}/share", {
          params: { path: { rideId: ride.id } },
          body: { is_public: false },
        } as never);
        token =
          (data as { share_token?: string } | undefined)?.share_token ?? null;
        if (token) {
          const created = token;
          setRide((r) => (r ? { ...r, share_token: created } : r));
        }
      } catch {
        // Fall through to the dashboard-URL fallback below.
      }
    }
    const shareUrl = token
      ? `${window.location.origin}/rides/shared/${token}`
      : window.location.href;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success(t("Link copied"));
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
      setRenameError(t("Couldn't rename this ride. Try again."));
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
      <PageShell backHref={backHref} backLabel={backLabel}>
        {showLoader && <SkeletonDashboard label={t("Loading ride…")} />}
      </PageShell>
    );
  }
  // Deleted / private / malformed-id rides render the app-level v2 404
  // screen (app/not-found.tsx) instead of a bespoke in-page card.
  if (notFound) renderNotFound();
  if (error || !ride) {
    return (
      <PageShell backHref={backHref} backLabel={backLabel}>
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-700">
          {error ?? t("Could not load ride")}
        </div>
      </PageShell>
    );
  }

  const rideName = ride.name?.trim()
    ? ride.name
    : t("Ride on {date}", { date: format.date(ride.started_at) });
  const avgTier = scoreToQualityTier(ride.avg_road_quality);
  // Weekday dropped — `format.date` has no weekday slot (accepted change,
  // migration recipe §Global Constraints).
  const startedDate = format.date(ride.started_at);
  // All metrics honour the rider's unit preference (km/m·mph·ft) so the grid
  // stays internally consistent — not a mix of converted distance and raw
  // metric speed/elevation. The format seam already reads the account's
  // unit preference, so there's no separate `unitSystem` store read here.
  const distance = format.splitDistanceKm(ride.distance_km ?? 0);
  const duration = splitRideDetailDuration(ride.duration_min, format);
  const avgSpeed = format.splitSpeed(ride.avg_speed ?? 0);
  const topSpeed = format.splitSpeed(ride.max_speed ?? 0);
  const ascent = format.splitElevation(ride.elevation_gain ?? 0);
  const descent = format.splitElevation(ride.elevation_loss ?? 0);
  // Net change is computed on the raw metric delta, then split/converted
  // once via `format.splitElevation` — subtracting the two ALREADY-split
  // (and unit-converted) display values would be wrong once `.value` is a
  // formatted string rather than a number.
  const netElevationM =
    ride.elevation_gain != null && ride.elevation_loss != null
      ? ride.elevation_gain - ride.elevation_loss
      : null;
  const netElevation =
    netElevationM != null
      ? format.splitElevation(Math.abs(netElevationM))
      : null;
  const speedUnit = avgSpeed.unit;

  // Distance / Duration / Avg / Top / Max lean / Ascent — the design's 2×3 grid.
  // Max lean + Ascent are `advanced_ride_stats` (Pro) — `locked` swaps them
  // for a `LockedStatTile` teaser below instead of dropping the tile.
  const tiles: (MetricTileProps & { locked?: boolean })[] = [
    {
      label: t("Distance"),
      value: ride.distance_km != null ? distance.value : "—",
      unit: distance.unit,
      unitPosition: distance.unitPosition,
      variant: "ink",
      accentNumber: true,
    },
    { label: t("Duration"), ...duration },
    {
      label: t("Avg speed"),
      value: ride.avg_speed != null ? avgSpeed.value : "—",
      unit: speedUnit,
      unitPosition: avgSpeed.unitPosition,
    },
    {
      label: t("Top speed"),
      value: ride.max_speed != null ? topSpeed.value : "—",
      unit: speedUnit,
      unitPosition: topSpeed.unitPosition,
    },
    {
      label: t("Max lean"),
      value:
        ride.max_lean_angle != null
          ? format.number(ride.max_lean_angle, {
              style: "unit",
              unit: "degree",
              unitDisplay: "narrow",
              maximumFractionDigits: 0,
            })
          : "—",
      locked: advancedStatsLocked,
    },
    {
      label: t("Ascent"),
      value: ride.elevation_gain != null ? ascent.value : "—",
      unit: ascent.unit,
      unitPosition: ascent.unitPosition,
      accentNumber: true,
      locked: advancedStatsLocked,
    },
  ];

  return (
    <PageShell
      header={
        <>
          <Link
            href={backHref}
            className="inline-flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.3px] text-fg-dim transition hover:text-ink"
          >
            <ArrowLeft size={14} />
            {backLabel}
          </Link>

          <div className="mt-3.5 mb-[22px] flex items-end justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <Mono className="text-[10px] uppercase tracking-[1.6px] text-fg-dim">
                  {t(rideTypeLabel(ride.ride_type))}
                </Mono>
                <span className="h-[3px] w-[3px] rounded-full bg-fg-mute" />
                <Mono className="text-[10px] uppercase tracking-[1.6px] text-fg-dim">
                  {startedDate}
                </Mono>
                <span className="h-[3px] w-[3px] rounded-full bg-fg-mute" />
                <Link
                  href={`/community/${encodeURIComponent(ride.rider_id)}`}
                  className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[1.6px] text-fg-dim transition hover:text-accent"
                >
                  <UserAvatar
                    name={ride.rider_name}
                    avatarUrl={ride.rider_avatar_url}
                    size={18}
                    fontSize={9}
                  />
                  {t("by {name}", { name: ride.rider_name })}
                </Link>
              </div>

              {renaming ? (
                <div className="mt-2 flex items-center gap-2">
                  {/* eslint-disable-next-line no-restricted-syntax -- inline
                      rename of the H1 styled as the heading itself (2xl
                      extrabold); boxed field chrome would break the layout. */}
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
                  {ride.viewer_is_owner && (
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
                  )}
                </div>
              )}
              {renameError && (
                <p className="mt-1 text-xs text-red-700">{renameError}</p>
              )}
            </div>

            <div className="flex flex-shrink-0 gap-2">
              {ride.viewer_is_owner && (
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
              )}
              <Button
                variant="secondary"
                uppercase
                leftIcon={<Share2 size={14} />}
                onClick={handleShare}
                title={t("Copy share link")}
              >
                {t("Share")}
              </Button>
              {ride.viewer_is_owner && (
                <RideExportMenu
                  onExport={(format) => downloadRideExport(ride.id, format)}
                />
              )}
            </div>
          </div>
        </>
      }
    >
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
          {tiles.map((tile) =>
            tile.locked ? (
              <LockedStatTile key={tile.label} label={tile.label} />
            ) : (
              <MetricTile key={tile.label} {...tile} />
            ),
          )}
        </div>
      </div>

      {/* Elevation summary. We store climb/descent totals but not a per-sample
          altitude track, so the card is the totals — no empty chart slot.
          `elevation_gain`/`elevation_loss` are `advanced_ride_stats` (Pro), so
          a non-entitled (or unresolved) rider sees a locked teaser instead of
          the real totals. */}
      {advancedStatsLocked ? (
        <LockedFeatureCard
          stamp={t("Elevation profile")}
          title={t("Climb & descent")}
          message={t("Elevation gain and loss are a Pro feature.")}
          currentTier={tier}
          className="mb-4"
        />
      ) : (
        <Card className="mb-4">
          <Stamp>{t("Elevation profile")}</Stamp>
          <div className="mt-1 text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
            {t("Climb & descent")}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <ElevationStat
              label={t("Total ascent")}
              value={
                ride.elevation_gain != null
                  ? formatSplitValueUnit({
                      ...ascent,
                      value: `+${ascent.value}`,
                    })
                  : "—"
              }
            />
            <ElevationStat
              label={t("Total descent")}
              value={
                ride.elevation_loss != null
                  ? formatSplitValueUnit({
                      ...descent,
                      value: `−${descent.value}`,
                    })
                  : "—"
              }
            />
            <ElevationStat
              label={t("Net change")}
              value={
                netElevation != null
                  ? formatSplitValueUnit({
                      ...netElevation,
                      value: `${netElevationM! >= 0 ? "+" : "−"}${netElevation.value}`,
                    })
                  : "—"
              }
            />
          </div>
          <p className="mt-3 text-xs text-fg-mute">
            {t(
              "Per-sample elevation profile isn't recorded yet — climb/descent totals shown above.",
            )}
          </p>
        </Card>
      )}

      {/* Speed profile (US-48): per-segment avg/max speed for populated rides */}
      <SpeedProfileCard segments={ride.segments} format={format} />

      {/* Ride dynamics + character. Lean angle / lean distribution are
          `advanced_ride_stats` (Pro) — locked teaser instead of the card when
          not entitled (or unresolved). */}
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        {advancedStatsLocked ? (
          <LockedFeatureCard
            stamp={t("Ride dynamics")}
            title={t("Time spent leaning")}
            message={t("Lean angle stats are a Pro feature.")}
            currentTier={tier}
          />
        ) : (
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
                  {avgLean != null
                    ? format.number(avgLean, {
                        style: "unit",
                        unit: "degree",
                        unitDisplay: "narrow",
                        maximumFractionDigits: 0,
                      })
                    : "—"}
                </div>
              </div>
            </div>
            <LeanHistogram distribution={ride.lean_distribution} />
          </Card>
        )}

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
                  ? t("{score} / {max}", {
                      score: formatNumber(ride.avg_road_quality, 1, format),
                      max: format.integer(5),
                    })
                  : "—"
              }
            />
            <CharacterStat
              label={t("Curves")}
              value={
                ride.curve_count != null
                  ? format.integer(ride.curve_count)
                  : "—"
              }
            />
            <CharacterStat
              label={t("Fuel estimate")}
              value={
                ride.fuel_estimate_l != null
                  ? format.number(ride.fuel_estimate_l, {
                      style: "unit",
                      unit: "liter",
                      unitDisplay: "narrow",
                      minimumFractionDigits: ride.fuel_estimate_l === 0 ? 0 : 1,
                      maximumFractionDigits: 1,
                    })
                  : "—"
              }
            />
            <CharacterStat
              label={t("Elev. descent")}
              value={
                advancedStatsLocked
                  ? t("Pro")
                  : ride.elevation_loss != null
                    ? formatSplitValueUnit(descent)
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
          leanLocked={advancedStatsLocked}
        />
      )}
    </PageShell>
  );
}

function PageShell({
  children,
  header,
  backHref = "/rides",
  backLabel,
}: {
  children: React.ReactNode;
  header?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  const t = useTranslation();
  const resolvedBackLabel = backLabel ?? t("Ride History · All rides");
  return (
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      {header ?? (
        <Link
          href={backHref}
          className="mb-6 inline-flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.3px] text-fg-dim transition hover:text-ink"
        >
          <ArrowLeft size={14} />
          {resolvedBackLabel}
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
  const t = useTranslation();
  const format = useFormat();
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
  const degree = (value: number) =>
    format.number(value, {
      style: "unit",
      unit: "degree",
      unitDisplay: "narrow",
      maximumFractionDigits: 0,
    });
  const bucketLabel = (bucket: (typeof LEAN_BUCKETS)[number]) =>
    bucket.max == null
      ? t("{value}+", { value: degree(bucket.min) })
      : t("{start} – {end}", {
          start: degree(bucket.min),
          end: degree(bucket.max),
        });
  return (
    <div className="mt-[18px] flex h-[150px] items-end gap-3">
      {LEAN_BUCKETS.map((bucket, i) => (
        <div
          key={bucket.key}
          className="flex flex-1 flex-col items-center justify-end gap-1.5"
        >
          <Mono className="text-[10px] text-fg-mute">
            {format.number((pcts[i] ?? 0) / 100, {
              style: "percent",
              maximumFractionDigits: 0,
            })}
          </Mono>
          <div
            className={`w-full rounded-t ${
              i === peakIdx ? "bg-accent" : "bg-ink/[0.82]"
            }`}
            style={{ height: `${Math.max(4, (pcts[i]! / peak) * 110)}px` }}
          />
          <Mono className="text-[9px] font-bold text-fg-mute">
            {bucketLabel(bucket)}
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
  leanLocked,
}: {
  segments: RideSegment[];
  distanceKm: number | null;
  format: Formatters;
  /** `max_lean_angle` (per segment) is `advanced_ride_stats` (Pro) — the LEAN
   *  column shows a lock glyph per row instead of the value when not
   *  entitled (or unresolved). */
  leanLocked: boolean;
}) {
  const t = useTranslation();
  const total = distanceKm != null ? format.splitDistanceKm(distanceKm) : null;
  const speedUnit = format.splitSpeed(0).unit;
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
          {format.number(s.idx + 1, {
            useGrouping: false,
            minimumIntegerDigits: 2,
            maximumFractionDigits: 0,
          })}
        </Mono>
      ),
    },
    {
      key: "segment",
      label: t("SEGMENT"),
      primary: true,
      render: (s) => (
        <span className="truncate font-bold text-ink">
          {s.road_name ?? t("Unnamed road")}
        </span>
      ),
    },
    {
      key: "avg",
      label: t("AVG {unit}", { unit: speedUnit }),
      size: "100px",
      render: (s) => (
        <Mono className="text-ink">
          {s.speed_avg != null ? format.splitSpeed(s.speed_avg).value : "—"}
        </Mono>
      ),
    },
    {
      key: "max",
      label: t("MAX {unit}", { unit: speedUnit }),
      size: "100px",
      render: (s) => (
        <Mono className="text-ink">
          {s.speed_max != null ? format.splitSpeed(s.speed_max).value : "—"}
        </Mono>
      ),
    },
    {
      key: "lean",
      label: (
        <span className="inline-flex items-center gap-1">
          {t("LEAN")}
          {leanLocked && <Lock size={10} aria-hidden />}
        </span>
      ),
      size: "70px",
      render: (s) =>
        leanLocked ? (
          <span
            title={t("Upgrade to Pro to see this stat.")}
            className="inline-flex"
          >
            <Lock size={13} className="text-fg-mute" aria-hidden />
            <span className="sr-only">
              {t("Upgrade to Pro to see this stat.")}
            </span>
          </span>
        ) : (
          <Mono className="text-ink">
            {s.lean_angle_max != null
              ? format.number(s.lean_angle_max, {
                  style: "unit",
                  unit: "degree",
                  unitDisplay: "narrow",
                  maximumFractionDigits: 0,
                })
              : "—"}
          </Mono>
        ),
    },
    {
      key: "quality",
      label: t("QUALITY"),
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
              {t(
                "{count, plural, one {{n} road ridden} other {{n} roads ridden}}",
                {
                  count: segments.length,
                  n: format.integer(segments.length),
                },
              )}
            </div>
          </div>
          {total != null && (
            <Mono className="text-[11px] text-fg-dim">
              {t("{measurement} TOTAL", {
                measurement: formatSplitValueUnit(total),
              })}
            </Mono>
          )}
        </div>
      }
    />
  );
}

/**
 * Per-segment speed visualisation (US-48 / T31). The map + tiles give totals;
 * this restores the speed graph the product spec requires for populated rides,
 * unit-aware (km/h vs mph).
 */
function SpeedProfileCard({
  segments,
  format,
}: {
  segments: RideSegment[];
  format: Formatters;
}) {
  const t = useTranslation();
  const points = buildSpeedProfile(segments);
  const conv = (kmh: number) =>
    format.units === "imperial" ? kmToMiles(kmh) : kmh;
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
            {t("{measurement} PEAK", {
              measurement: format.number(peak, {
                style: "unit",
                unit:
                  format.units === "imperial"
                    ? "mile-per-hour"
                    : "kilometer-per-hour",
                unitDisplay: "short",
                maximumFractionDigits: 0,
              }),
            })}
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
}: {
  points: Array<{ x: number; y: number }>;
  secondaryPoints: Array<{ x: number; y: number }>;
  minY: number;
  maxY: number;
}) {
  const t = useTranslation();
  const format = useFormat();
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
  const formatSpeedValue = (value: number) =>
    format.number(value, {
      style: "unit",
      unit:
        format.units === "imperial" ? "mile-per-hour" : "kilometer-per-hour",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    });
  // SVG stroke values are drawing parameters, not rider-visible numerals.
  // Compute the nodes before JSX so the display-numeral guard only inspects
  // expressions that can render text.
  const primarySeries = renderSeries(points, "#FF6A1A", "3");
  const comparisonSeries = renderSeries(
    secondaryPoints,
    "#f472b6",
    "2.5",
    "6 5",
  );
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
        {primarySeries}
        {comparisonSeries}
      </svg>
      <div className="flex items-center justify-between text-[11px] text-fg-mute">
        <span>{format.integer(1)}</span>
        {lastY != null && <Mono>{formatSpeedValue(lastY)}</Mono>}
        <span>{format.integer(maxX)}</span>
      </div>
    </div>
  );
}
