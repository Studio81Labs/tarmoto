"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import type { EnglishMessageKey, Translate } from "@/i18n";
import Link from "next/link";
import { useAuthStore } from "@/stores/auth";
import { useUserTrips } from "@/hooks/useUserTrips";
import { useRecentRides } from "@/hooks/useRecentRides";
import { useMonthlyStats } from "@/hooks/useMonthlyStats";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { ridesWithinDays, scoreToQualityTier } from "@/lib/utils";
import type { MonthlyStats } from "@tarmoto/shared";
import { useFormat } from "@/format/FormatProvider";
import { timeWindowLabel } from "@/lib/time-window-label";
import { TRIP_STATUS_LABELS } from "@/i18n/domainLabels";
import { RouteOutlineSvg } from "@/components/trips/RouteOutlineSvg";
import { RecentRidesTable } from "./_home/RecentRidesTable";
import {
  ArrowUpRight,
  BarChart3,
  History,
  Map,
  Plus,
  Route,
} from "lucide-react";
import {
  Button,
  Card,
  Heading,
  MetricTile,
  MiniRouteSvg,
  Mono,
  QualityBars,
  SkeletonList,
  Stamp,
} from "@tarmoto/ui";
import { LocalizedStyledValue } from "@/i18n/LocalizedStyledValue";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";

const QUICK_ACTIONS = [
  {
    href: "/trips/planner",
    icon: Route,
    label: "Plan a trip",
    sub: "Draft a multi-day loop",
    stamp: "01",
  },
  {
    href: "/explore",
    icon: Map,
    label: "Explore roads",
    sub: "Quality across regions",
    stamp: "02",
  },
  {
    href: "/rides",
    icon: History,
    label: "Ride history",
    sub: "Your tracks + stats",
    stamp: "03",
  },
  {
    href: "/rides/stats",
    icon: BarChart3,
    label: "Statistics",
    sub: "Distance, lean, quality",
    stamp: "04",
  },
] as const;

export default function HomePage() {
  const { enabled: tripPlanningEnabled } =
    useFeatureKillSwitch("trip_planning");
  const t = useTranslation();
  const user = useAuthStore((s) => s.user);
  const { trips, loading, error: tripsError } = useUserTrips();
  const {
    rides: recentRides,
    loading: ridesLoading,
    error: ridesError,
  } = useRecentRides(5);
  const firstName = user?.displayName?.split(" ")[0];
  // Debounced: with a warm cache both fetches resolve in well under the
  // delay, so the loading placeholders never flash.
  const showLoader = useDelayedLoading(loading || ridesLoading);
  const draftTrips = trips
    .filter((trip) => trip.status === "draft" || trip.status === "planned")
    .slice(0, 3);

  // Current-month KPI snapshot. Null while loading / before first fetch;
  // the tile row stays hidden until a non-empty month resolves, and the
  // sync pill reads `last_synced_at` off this same payload.
  const { stats: monthlyStats } = useMonthlyStats();

  // Returning rider check uses ALL trips (any status) + recent rides —
  // an account with only active/completed trips, or one that has rides
  // but no saved trips, IS a returning rider, not a first-time user. This
  // intentionally uses the UNWINDOWED ride list: a rider whose last ride
  // is older than 30 days is still returning, not first-time.
  const hasAnyContent = trips.length > 0 || recentRides.length > 0;
  // The section heading is "Last 30 days", so the table itself only shows
  // rides inside that window (the unwindowed list above stays for the
  // returning-rider check). Rides come newest-first and are capped at 5,
  // so windowing the fetched page is equivalent to a server date bound.
  const ridesInWindow = ridesWithinDays(recentRides, 30);
  const hasDrafts = draftTrips.length > 0;
  // First-time hero copy ("Welcome to Tarmoto") only when we've
  // finished loading AND confirmed an empty trip list — during the
  // initial `useUserTrips()` fetch and on a network error, default to
  // "Welcome back" so returning riders don't see first-time messaging
  // flash on every cold load (statistically the dominant case under
  // normal network latency).
  const isFirstTimeUser =
    !loading && !ridesLoading && !tripsError && !ridesError && !hasAnyContent;
  // A load error only surfaces in the no-content branch (below) — once we
  // have trips/rides to show, swallow it rather than nudging a returning
  // rider with real data toward a "first trip" CTA. We can't honestly
  // claim "no rides/trips" when the fetch itself failed, so each side of
  // the empty layout shows its own retry card instead of onboarding copy.

  return (
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      {/* Hero */}
      <header className="mb-7 flex items-end justify-between gap-6">
        <div>
          <Stamp>
            {isFirstTimeUser ? t("Welcome to Tarmoto") : t("Welcome back")}
          </Stamp>
          <Heading size="2xl" as="h1" className="mt-1">
            {firstName
              ? t("Hello, {name}.", { name: firstName })
              : t("Hello, rider.")}
          </Heading>
          <p className="mt-2 max-w-lg text-[15px] text-fg-dim">
            {t("Know the road before you ride it.")}
          </p>
        </div>
        {/* Only render once stats resolve — while loading or on a fetch
            error `monthlyStats` is null, and asserting "No mobile sync yet"
            then would misrepresent an outage as an unsynced account. A
            genuine null `last_synced_at` from a successful fetch still
            shows the no-sync pill. */}
        {monthlyStats && <SyncPill syncedAt={monthlyStats.last_synced_at} />}
      </header>

      {/* 4-KPI tile row — shown once the rider has logged distance this
          month (so an idle month doesn't render a wall of zeros). The
          current-month figure is computed from a UTC 'YYYY-MM' bucket
          server-side; see UsersService.getMonthlyStats. */}
      {monthlyStats && monthlyStats.this_month_km > 0 && (
        <KpiTileRow stats={monthlyStats} />
      )}

      {/* Jump in */}
      <Stamp className="block">{t("Jump in")}</Stamp>
      <div className="mb-9 mt-3 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {QUICK_ACTIONS.filter(
          // Operator kill switch: the planner itself is gated, so an entry tile
          // that still looks live just sends the rider to an unavailable page.
          (action) => action.href !== "/trips/planner" || tripPlanningEnabled,
        ).map((action) => (
          <Link
            key={action.href}
            href={action.href}
            className="group flex min-h-[160px] flex-col gap-3.5 rounded-[14px] border border-line bg-cream p-5 transition hover:border-line-strong"
          >
            <div className="flex items-start justify-between">
              <Mono className="text-[11px] font-bold uppercase tracking-[1.5px] text-fg-mute">
                {action.stamp}
              </Mono>
              <ArrowUpRight
                size={14}
                className="text-fg-mute transition group-hover:text-ink"
              />
            </div>
            <action.icon
              size={18}
              strokeWidth={2}
              className="mt-auto text-accent"
            />
            <div>
              <div className="text-[18px] font-extrabold tracking-[-0.3px] text-ink">
                {t(action.label)}
              </div>
              <div className="mt-1 text-[12px] text-fg-dim">
                {t(action.sub)}
              </div>
            </div>
          </Link>
        ))}
      </div>

      {loading || ridesLoading ? (
        showLoader ? (
          <SkeletonList rows={3} label={t("Loading your rides and trips…")} />
        ) : null
      ) : !hasAnyContent ? (
        // Nothing loaded. If a fetch failed, show a per-side retry card
        // rather than first-time onboarding — we can't claim "no rides /
        // no trips" when we never reached the server (they may have data
        // we couldn't load). Otherwise both genuinely empty → the simple
        // 2-col centered cards, with the trips "Plan a trip" CTA.
        <DualEmptyState
          ridesEmpty={
            ridesError ? (
              <LoadErrorCard
                title={t("Couldn't load your rides")}
                message={t(
                  "We hit a network hiccup loading your rides. Refresh to try again.",
                )}
              />
            ) : (
              <RidesEmptyCard />
            )
          }
          tripsEmpty={
            tripsError ? (
              <LoadErrorCard
                title={t("Couldn't load your trips")}
                message={t(
                  "We hit a network hiccup loading your drafts. Refresh to try again — your trips are safe.",
                )}
              />
            ) : (
              <TripsEmptyCard planningEnabled={tripPlanningEnabled} />
            )
          }
        />
      ) : (
        // Returning rider → render the populated layout: Recent rides
        // section (RecentRidesTable when rides exist, empty card otherwise) +
        // Trip drafts section (3-up grid when there are drafts, otherwise
        // a centered empty Card so the section affordance stays
        // visible to riders with only active/completed trips).
        <>
          <SectionHeader
            stamp={t("Recent rides")}
            title={timeWindowLabel("30d", t)}
            actionHref="/rides"
            actionLabel={t("View all")}
          />
          {ridesError ? (
            // Rides failed but trips loaded — asserting "No rides recorded
            // yet" here would be wrong, so show the same retry the
            // no-content branch uses.
            <LoadErrorCard
              title={t("Couldn't load your rides")}
              message={t(
                "We hit a network hiccup loading your rides. Refresh to try again.",
              )}
            />
          ) : ridesInWindow.length > 0 ? (
            <RecentRidesTable rides={ridesInWindow} />
          ) : (
            <Card padded={false} className="px-6 py-10 text-center">
              <History
                size={18}
                strokeWidth={2}
                className="mx-auto text-fg-mute"
              />
              <Stamp className="mt-2.5 block">{t("Recent rides")}</Stamp>
              <p className="mt-1 text-[16px] font-bold text-ink">
                {t("No rides recorded yet")}
              </p>
              <p className="mx-auto mt-1 max-w-[320px] text-[12px] leading-[1.55] text-fg-dim">
                {t(
                  "Your rides from the mobile app will appear here once you start tracking.",
                )}
              </p>
            </Card>
          )}

          <div className="mt-10">
            <SectionHeader
              stamp={t("Trip drafts")}
              title={t("Your route ideas")}
              {...(tripPlanningEnabled
                ? {
                    actionHref: "/trips/planner",
                    actionLabel: t("Plan new trip"),
                  }
                : {})}
            />
            {tripsError ? (
              // Reached the populated layout via rides, but the trips fetch
              // failed — don't assert "No trips planned yet" (or nudge a
              // "Plan a trip" CTA) over saved trips we just couldn't reach.
              <LoadErrorCard
                title={t("Couldn't load your trips")}
                message={t(
                  "We hit a network hiccup loading your drafts. Refresh to try again — your trips are safe.",
                )}
              />
            ) : hasDrafts ? (
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
                {draftTrips.map((trip, i) => (
                  <TripDraftCard key={trip.id} trip={trip} seed={i * 3 + 1} />
                ))}
              </div>
            ) : (
              <Card padded={false} className="px-6 py-10 text-center">
                <Route
                  size={18}
                  strokeWidth={2}
                  className="mx-auto text-fg-mute"
                />
                <Stamp className="mt-2.5 block">{t("Trip drafts")}</Stamp>
                <p className="mt-1 text-[16px] font-bold text-ink">
                  {t("No trips planned yet")}
                </p>
                <p className="mx-auto mt-1 max-w-[320px] text-[12px] leading-[1.55] text-fg-dim">
                  {t(
                    "Create your first trip to discover the best roads in your region.",
                  )}
                </p>
                {tripPlanningEnabled && (
                  <Link
                    href="/trips/planner"
                    className="mt-4 inline-flex items-center gap-2 rounded-[10px] border border-accent bg-accent px-4 py-2.5 text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
                  >
                    <Plus size={14} />
                    {t("Plan a trip")}
                  </Link>
                )}
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SyncPill({ syncedAt }: { syncedAt: string | null }) {
  const t = useTranslation();
  if (!syncedAt) {
    // Spec's empty-state pill — ghost / line-strong border / fg-mute
    // dot + text. Shown until the rider's first mobile upload lands.
    return (
      <div className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line-strong px-2.5 py-[5px] text-[11px] font-bold tracking-[0.2px] text-fg-dim">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-fg-mute" />
        {t("No mobile sync yet")}
      </div>
    );
  }
  return (
    <div className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-accent px-2.5 py-[5px] text-[11px] font-bold tracking-[0.2px] text-ink">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-ink" />
      {formatSyncedLabel(syncedAt, t)}
    </div>
  );
}

// Returns a fully-translated sync label like "Mobile synced 4m ago". The
// relative-time portion is delegated to the shared format seam so it stays
// locale-correct — mirrors `relativeTime`'s "now" / "Xm/h/d ago" / absolute
// date beyond 7 days.
// Deliberately NOT `format.relativeTime()`: this phrase is embedded in a
// translated sentence, so the time wording must come from the i18n catalog
// (UI language), not the FORMAT locale — otherwise a cs-CZ format
// preference yields mixed-language copy ("Mobile synced před 5 m") and the
// <1 min bucket reads "synced now" instead of "synced just now". Same
// translated-copy exclusion class as the challenge countdowns.
function formatSyncedLabel(iso: string, t: Translate): string {
  const d = new Date(iso);
  const diffMin = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (diffMin < 1) return t("Mobile synced just now");
  if (diffMin < 60) return t("Mobile synced {n}m ago", { n: diffMin });
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return t("Mobile synced {n}h ago", { n: hours });
  return t("Mobile synced {n}d ago", { n: Math.floor(hours / 24) });
}

function KpiTileRow({ stats }: { stats: MonthlyStats }) {
  const t = useTranslation();
  const format = useFormat();
  const kmFraction =
    stats.prev_month_km > 0
      ? (stats.this_month_km - stats.prev_month_km) / stats.prev_month_km
      : null;
  const kmDelta =
    kmFraction == null
      ? t("first tracked month")
      : t("{percent} vs last month", {
          percent: format.number(kmFraction, {
            style: "percent",
            signDisplay: "exceptZero",
            maximumFractionDigits: 0,
          }),
        });
  // Hours arrive with one decimal of precision; the design shows whole
  // hours ("32 HRS"), so round the display value but compute the delta
  // from the raw values to avoid rounding-induced misleading deltas.
  const hoursNow = Math.round(stats.ride_hours);
  const rawHoursDelta = Math.round(stats.ride_hours - stats.prev_ride_hours);
  const hoursDelta = t("{hours} vs last month", {
    hours: format.number(rawHoursDelta, {
      style: "unit",
      unit: "hour",
      unitDisplay: "narrow",
      signDisplay: "exceptZero",
      maximumFractionDigits: 0,
    }),
  });
  // Key the sublabel off the lean reading itself (max_lean_at), not the
  // ride name — an unnamed ride can still hold this month's max lean, so
  // fall back to just the date rather than the misleading "No lean recorded".
  const leanSub =
    stats.max_lean_at != null
      ? [stats.max_lean_ride_name, format.shortDate(stats.max_lean_at)]
          .filter(Boolean)
          .join(" · ")
      : t("No lean recorded");
  const monthDistance = format.splitDistanceKm(stats.this_month_km);
  const rideTime = format.splitUnit(hoursNow, "hour", {
    unitDisplay: "short",
    maximumFractionDigits: 0,
  });

  return (
    <div className="mb-8 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
      <MetricTile
        variant="ink"
        accentNumber
        label={t("This month")}
        value={monthDistance.value}
        unit={monthDistance.unit}
        unitPosition={monthDistance.unitPosition}
        delta={kmDelta}
      />
      <MetricTile
        label={t("Ride time")}
        value={rideTime.value}
        unit={rideTime.unit}
        unitPosition={rideTime.unitPosition}
        delta={hoursDelta}
      />
      <MetricTile
        label={t("New roads")}
        value={format.integer(stats.new_roads)}
        unit={t("DISCOVERED")}
        unitPosition="after"
        delta={t("this month")}
      />
      <MetricTile
        accentNumber
        label={t("Lean angle")}
        value={
          stats.max_lean_deg != null
            ? format.number(stats.max_lean_deg, {
                style: "unit",
                unit: "degree",
                unitDisplay: "narrow",
                maximumFractionDigits: 0,
              })
            : "—"
        }
        unit={t("MAX")}
        unitPosition="after"
        delta={leanSub}
      />
    </div>
  );
}

function DualEmptyState({
  ridesEmpty,
  tripsEmpty,
}: {
  ridesEmpty: React.ReactNode;
  tripsEmpty: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
      {ridesEmpty}
      {tripsEmpty}
    </div>
  );
}

// Shown in the no-content branch when a rides or trips fetch failed, in
// place of the "you have nothing yet" empty card — a transient outage
// must not read as an empty account. Reload re-runs both queries.
function LoadErrorCard({ title, message }: { title: string; message: string }) {
  const t = useTranslation();
  return (
    <Card padded={false} className="px-6 py-10 text-center">
      <Stamp className="text-quality-q1">{title}</Stamp>
      <p className="mx-auto mt-2 max-w-[320px] text-[12px] leading-[1.55] text-fg-dim">
        {message}
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="mt-4"
        onClick={() => {
          if (typeof window !== "undefined") window.location.reload();
        }}
      >
        {t("Retry")}
      </Button>
    </Card>
  );
}

function RidesEmptyCard() {
  const t = useTranslation();
  return (
    <Card padded={false} className="px-6 py-10 text-center">
      <History size={18} strokeWidth={2} className="mx-auto text-fg-mute" />
      <Stamp className="mt-2.5 block">{t("Recent rides")}</Stamp>
      <p className="mt-1 text-[16px] font-bold text-ink">
        {t("No rides recorded yet")}
      </p>
      <p className="mx-auto mt-1 max-w-[320px] text-[12px] leading-[1.55] text-fg-dim">
        {t(
          "Your rides from the mobile app will appear here once you start tracking.",
        )}
      </p>
    </Card>
  );
}

// Exported for tests, like `TripMetadataCount` — the CTA it renders points at
// a kill-switchable destination, so its gating needs direct coverage.
export function TripsEmptyCard({
  planningEnabled,
}: {
  planningEnabled: boolean;
}) {
  const t = useTranslation();
  return (
    <Card padded={false} className="px-6 py-10 text-center">
      <Route size={18} strokeWidth={2} className="mx-auto text-fg-mute" />
      <Stamp className="mt-2.5 block">{t("Trip drafts")}</Stamp>
      <p className="mt-1 text-[16px] font-bold text-ink">
        {t("No trips planned yet")}
      </p>
      <p className="mx-auto mt-1 max-w-[320px] text-[12px] leading-[1.55] text-fg-dim">
        {t("Create your first trip to discover the best roads in your region.")}
      </p>
      {planningEnabled && (
        <Link
          href="/trips/planner"
          className="mt-4 inline-flex items-center gap-2 rounded-[10px] border border-accent bg-accent px-4 py-2.5 text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
        >
          <Plus size={14} />
          {t("Plan a trip")}
        </Link>
      )}
    </Card>
  );
}

function SectionHeader({
  stamp,
  title,
  actionHref,
  actionLabel,
}: {
  stamp: string;
  title: string;
  // Optional so a section can render without a CTA — needed when an operator
  // kill switch removes the destination the action would point at.
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div>
        <Stamp>{stamp}</Stamp>
        <Heading
          size="lg"
          as="h2"
          className="mt-1 text-[26px] leading-[1.05] tracking-[-0.5px]"
        >
          {title}
        </Heading>
      </div>
      {actionHref && actionLabel ? (
        <Link
          href={actionHref}
          className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ink transition hover:text-accent"
        >
          {actionLabel}
          <ArrowUpRight size={14} className="text-accent" />
        </Link>
      ) : null}
    </div>
  );
}

// Trip status pill tones inside a draft card — picks the spec's
// 5-stop palette per status. Active (currently riding) uses the
// canonical solid-accent treatment used elsewhere in the app, while
// the other statuses ride on q-scale tints.
const STATUS_TONE: Record<
  "draft" | "planned" | "active" | "completed",
  "dim" | "accent"
> = {
  draft: "dim",
  planned: "dim",
  active: "accent",
  completed: "dim",
};

export function TripMetadataCount({
  count,
  kind,
}: {
  count: number;
  kind: "days" | "passes";
}) {
  const t = useTranslation();
  const format = useFormat();
  const messageKey: EnglishMessageKey =
    kind === "days"
      ? "{count, plural, one {{formattedCount} DAY} other {{formattedCount} DAYS}}"
      : "{count, plural, one {{formattedCount} PASS} other {{formattedCount} PASSES}}";
  return (
    <LocalizedStyledValue
      t={t}
      messageKey={messageKey}
      values={{ count }}
      valueName="formattedCount"
      formattedValue={format.integer(count)}
      className="font-bold text-ink"
    />
  );
}

function TripDraftCard({
  trip,
  seed,
}: {
  trip: {
    id: string;
    name: string;
    status: string;
    num_days: number;
    distance_km?: number | null;
    quality_avg?: number | null;
    passes_count?: number | null;
    overviewGeometry?: number[][][] | null | undefined;
  };
  seed: number;
}) {
  const t = useTranslation();
  const format = useFormat();
  const status =
    (trip.status as "draft" | "planned" | "active" | "completed") ?? "draft";
  // MiniRouteSvg and QualityBars are visually coupled — both take this one
  // tier. MiniRouteSvg has no "no data" state (it always draws a route in a
  // q-colour), so when a trip has no rolled-up quality yet (e.g. an empty
  // draft) we default both to the neutral mid-tier rather than hiding the
  // bars alone, which would leave the card's sketch and glyph mismatched.
  // (The KM/PASSES slots below DO hide when absent — they aren't coupled to
  // the sketch.) Matches the trip-card treatment on the /trips page.
  const tier = scoreToQualityTier(trip.quality_avg) ?? 3;
  return (
    <Link
      href={`/trips/${trip.id}`}
      className="block overflow-hidden rounded-[14px] border border-line bg-cream transition hover:border-line-strong"
    >
      <div className="relative h-[120px] overflow-hidden">
        {/* Real per-day route outline when the trip has geometry (same as the
            /trips cards); the abstract seeded sketch is only a fallback for
            drafts that haven't been routed yet. */}
        {trip.overviewGeometry && trip.overviewGeometry.length > 0 ? (
          <RouteOutlineSvg
            geometry={trip.overviewGeometry}
            className="absolute inset-0 h-full w-full"
          />
        ) : (
          <MiniRouteSvg q={tier} seed={seed} className="absolute inset-0" />
        )}
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Stamp tone={STATUS_TONE[status]}>
              {t(TRIP_STATUS_LABELS[status])}
            </Stamp>
            <div className="mt-1 line-clamp-2 text-[16px] font-extrabold leading-tight text-ink">
              {trip.name}
            </div>
          </div>
          <QualityBars q={tier} size={4} />
        </div>
        <div className="mt-2.5 flex items-center gap-3 text-[11px] text-fg-dim">
          {trip.distance_km != null && trip.distance_km > 0 && (
            <Mono className="uppercase">
              <span className="font-bold text-ink">
                {format.distanceKm(trip.distance_km)}
              </span>
            </Mono>
          )}
          {trip.num_days > 0 && (
            <Mono className="uppercase">
              <TripMetadataCount count={trip.num_days} kind="days" />
            </Mono>
          )}
          {trip.passes_count != null && trip.passes_count > 0 && (
            <Mono className="uppercase">
              <TripMetadataCount count={trip.passes_count} kind="passes" />
            </Mono>
          )}
        </div>
      </div>
    </Link>
  );
}
