"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { getUserFacingErrorMessage } from "@/i18n";
/**
 * SharedRidesSection (#371, v2 profile) — companion mirror of mobile's
 * shared-rides list on the public rider profile.
 *
 * Renders the rider's shared rides as a v2 table: route mini-preview, title +
 * shared date, distance, duration, views, and the signature quality bars. The
 * backend gates visibility on the rider's `profile_visibility` (private
 * profiles 404 for non-self viewers) and on each share's `is_public` flag
 * (private shares are filtered server-side for non-self viewers). A 404
 * collapses to the empty state rather than an error block, and the per-row
 * "Private" pill renders only for the rider's own private shares so the UI
 * never leaks a private flag that slipped past the server filter. The header
 * surfaces the rider's total public-ride count and aggregate view total.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Lock, Share2 } from "lucide-react";
import { Mono, QualityBars, Stamp } from "@tarmoto/ui";
import { formatCount } from "@tarmoto/shared";
import { fetchSharedRides, type UserSharedRide } from "@/lib/shared-rides";
import { scoreToQualityTier } from "@/lib/utils";
import { buildRoutePreview } from "@/lib/ride-detail";
import { useAuthStore } from "@/stores/auth";
import { useFormat } from "@/format/FormatProvider";

const PAGE_SIZE = 5;

interface SharedRidesSectionProps {
  userId: string;
  isSelf: boolean;
  /** Display name used in the third-person empty-state copy. */
  displayName: string;
}

type Phase = "loading" | "ready" | "error";

export function SharedRidesSection({
  userId,
  isSelf,
  displayName,
}: SharedRidesSectionProps) {
  const t = useTranslation();
  const format = useFormat();
  const accessToken = useAuthStore((s) => s.accessToken);
  const [items, setItems] = useState<UserSharedRide[]>([]);
  const [total, setTotal] = useState(0);
  const [totalViews, setTotalViews] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    // Mirrors the cancellation pattern used by the parent profile page:
    // openapi-fetch swallows AbortError into its result union, so we keep a
    // `cancelled` flag alongside the controller to guard every setState when
    // a userId or accessToken change races with an in-flight request.
    let cancelled = false;
    const controller = new AbortController();
    setPhase("loading");
    setErrorMessage(null);
    fetchSharedRides(userId, { limit: PAGE_SIZE, signal: controller.signal })
      .then((response) => {
        if (cancelled) return;
        setItems(response?.items ?? []);
        setTotal(response?.total ?? 0);
        setTotalViews(response?.total_views ?? 0);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setPhase("error");
        setErrorMessage(
          getUserFacingErrorMessage(err, t("Could not load shared rides.")),
        );
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // accessToken is captured by the typed client through the auth store;
    // re-running on token change re-issues the request with the new viewer
    // identity so `is_self` and the private-share filter stay in sync.
  }, [t, userId, accessToken]);

  return (
    <section className="overflow-hidden rounded-[14px] border border-line bg-cream">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-2.5">
          <Share2 size={14} className="shrink-0 text-accent" />
          <div>
            <Stamp as="h2">{t("Shared rides")}</Stamp>
            <div className="mt-0.5 text-[18px] font-extrabold tracking-[-0.3px] text-ink">
              {t(
                "{count, plural, one {{n} public ride} other {{n} public rides}}",
                {
                  count: total,
                  n: formatCount(total, format.locale),
                },
              )}
            </div>
          </div>
        </div>
        {phase === "ready" && total > 0 && (
          <Mono className="shrink-0 text-[11px] text-fg-dim">
            {t(
              "{count, plural, one {{n} total view} other {{n} total views}}",
              {
                count: totalViews,
                n: formatCount(totalViews, format.locale),
              },
            )}
          </Mono>
        )}
      </header>

      {phase === "loading" ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[52px] animate-pulse rounded-lg bg-paper"
            />
          ))}
        </div>
      ) : phase === "error" ? (
        <p className="px-5 py-6 text-sm text-fg-dim">{errorMessage}</p>
      ) : items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-fg-dim">
          {isSelf
            ? t("You haven't shared any rides yet.")
            : t("{name} hasn't shared any rides yet.", { name: displayName })}
        </p>
      ) : (
        <ul>
          {items.map((ride) => (
            <li key={ride.share_token}>
              <SharedRideRow ride={ride} isSelf={isSelf} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SharedRideRow({
  ride,
  isSelf,
}: {
  ride: UserSharedRide;
  isSelf: boolean;
}) {
  const t = useTranslation();
  const format = useFormat();
  const preview = buildRoutePreview(ride.route_geometry, 200, 6);
  // See CommunityRideCard: gated at the derivation so every reader of `tier`
  // is covered at once.
  const { enabled: qualityEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const tier = qualityEnabled
    ? scoreToQualityTier(ride.avg_road_quality)
    : null;
  const title = ride.name?.trim() || format.shortDate(ride.started_at);
  const showPrivatePill = isSelf && !ride.is_public;

  return (
    <Link
      href={`/community/rides/${encodeURIComponent(ride.id)}`}
      className="flex flex-col gap-3 border-b border-line px-5 py-3 transition last:border-b-0 hover:bg-paper md:grid md:grid-cols-[64px_1fr_110px_110px_92px_80px] md:items-center md:gap-4"
    >
      <div className="h-[42px] w-16 shrink-0 overflow-hidden rounded-lg border border-line bg-paper">
        {preview ? (
          <svg
            viewBox={preview.viewBox}
            preserveAspectRatio="xMidYMid slice"
            className="h-full w-full"
            role="img"
            aria-hidden="true"
          >
            <path
              d={preview.path}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-bold text-ink">{title}</span>
          {showPrivatePill && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line-strong px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-fg-mute">
              <Lock size={9} />
              {t("Private")}
            </span>
          )}
        </div>
        <Mono className="text-[10px] text-fg-mute">
          {format.shortDate(ride.started_at)}
        </Mono>
      </div>

      <RowMetric
        label={t("Distance")}
        value={
          ride.distance_km != null ? format.distanceKm(ride.distance_km) : "—"
        }
      />
      <RowMetric
        label={t("Duration")}
        value={
          ride.duration_min != null ? format.duration(ride.duration_min) : "—"
        }
      />
      <RowMetric
        label={t("Views")}
        value={
          <Mono>
            {formatCount(
              Math.max(0, Math.round(ride.view_count)),
              format.locale,
            )}
          </Mono>
        }
      />

      <span className="md:justify-self-end">
        {tier != null && <QualityBars q={tier} size={5} />}
      </span>
    </Link>
  );
}

function RowMetric({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <Stamp>{label}</Stamp>
      <div className="mt-0.5 text-sm font-bold text-ink">{value}</div>
    </div>
  );
}
