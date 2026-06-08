"use client";
import { t } from "@/i18n";
import Link from "next/link";
import { useAuthStore } from "@/stores/auth";
import { useUserTrips } from "@/hooks/useUserTrips";
import { useRecentRides } from "@/hooks/useRecentRides";
import { useMonthlyStats } from "@/hooks/useMonthlyStats";
import {
  formatShortDate,
  ridesWithinDays,
  scoreToQualityTier,
} from "@/lib/utils";
import type { MonthlyStats } from "@tarmoto/shared";
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
  Stamp,
} from "@tarmoto/ui";

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
  const user = useAuthStore((s) => s.user);
  const { trips, loading, error: tripsError } = useUserTrips();
  const {
    rides: recentRides,
    loading: ridesLoading,
    error: ridesError,
  } = useRecentRides(5);
  const firstName = user?.displayName?.split(" ")[0];
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
    <div className="mx-auto w-full max-w-page animate-fade-in px-10 py-8 pb-12">
      {/* Hero */}
      <header className="mb-7 flex items-end justify-between gap-6">
        <div>
          <Stamp>
            {isFirstTimeUser ? t("Welcome to Tarmoto") : t("Welcome back")}
          </Stamp>
          <Heading size="2xl" as="h1" className="mt-1">
            {firstName ? `${t("Hello")}, ${firstName}.` : t("Hello, rider.")}
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
        {QUICK_ACTIONS.map((action) => (
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
        <DualEmptyState
          ridesEmpty={<RidesEmptyCard />}
          tripsEmpty={
            <Card padded={false} className="px-6 py-10 text-center">
              <p className="text-[13px] text-fg-dim">
                {t("Loading your trips… ")}
              </p>
            </Card>
          }
        />
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
              <TripsEmptyCard />
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
            title={t("Last 30 days")}
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
              actionHref="/trips/planner"
              actionLabel={t("Plan new trip")}
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
                <Link
                  href="/trips/planner"
                  className="mt-4 inline-flex items-center gap-2 rounded-[10px] border border-accent bg-accent px-4 py-2.5 text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
                >
                  <Plus size={14} />
                  {t("Plan a trip")}
                </Link>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SyncPill({ syncedAt }: { syncedAt: string | null }) {
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
      {formatSyncedLabel(new Date(syncedAt))}
    </div>
  );
}

// Returns a fully-translated sync label like "Mobile synced 4m ago".
// Each bucket is its own catalog key so translators can place the
// number naturally in any locale ("Synchronisé il y a 4 min", etc.)
// rather than splicing English fragments through interpolation.
//
// `Math.floor` (not `Math.round`) so a 31-second gap reads as
// "just now" and 59m31s reads as "59m ago" — rounding up would
// roll buckets early.
function formatSyncedLabel(d: Date): string {
  const diffMin = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (diffMin < 1) return t("Mobile synced just now");
  if (diffMin < 60) return t("Mobile synced {n}m ago", { n: diffMin });
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return t("Mobile synced {n}h ago", { n: hours });
  return t("Mobile synced {n}d ago", { n: Math.floor(hours / 24) });
}

function KpiTileRow({ stats }: { stats: MonthlyStats }) {
  const kmPct =
    stats.prev_month_km > 0
      ? Math.round(
          ((stats.this_month_km - stats.prev_month_km) / stats.prev_month_km) *
            100,
        )
      : null;
  const kmDelta =
    kmPct == null
      ? t("first tracked month")
      : `${kmPct > 0 ? "+" : ""}${kmPct}% ${t("vs last month")}`;
  // Hours arrive with one decimal of precision; the design shows whole
  // hours ("32 HRS"), so round the display value but compute the delta
  // from the raw values to avoid rounding-induced misleading deltas.
  const hoursNow = Math.round(stats.ride_hours);
  const rawHoursDelta = Math.round(stats.ride_hours - stats.prev_ride_hours);
  const hoursDelta = `${rawHoursDelta > 0 ? "+" : ""}${rawHoursDelta}h ${t("vs last month")}`;
  // Key the sublabel off the lean reading itself (max_lean_at), not the
  // ride name — an unnamed ride can still hold this month's max lean, so
  // fall back to just the date rather than the misleading "No lean recorded".
  const leanSub =
    stats.max_lean_at != null
      ? [stats.max_lean_ride_name, formatShortDate(stats.max_lean_at)]
          .filter(Boolean)
          .join(" · ")
      : t("No lean recorded");

  return (
    <div className="mb-8 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
      <MetricTile
        variant="ink"
        accentNumber
        label={t("This month")}
        value={stats.this_month_km.toLocaleString()}
        unit="KM"
        delta={kmDelta}
      />
      <MetricTile
        label={t("Ride time")}
        value={String(hoursNow)}
        unit="HRS"
        delta={hoursDelta}
      />
      <MetricTile
        label={t("New roads")}
        value={String(stats.new_roads)}
        unit="DISCOVERED"
        delta={t("this month")}
      />
      <MetricTile
        accentNumber
        label={t("Lean angle")}
        value={stats.max_lean_deg != null ? `${stats.max_lean_deg}°` : "—"}
        unit="MAX"
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

function TripsEmptyCard() {
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
      <Link
        href="/trips/planner"
        className="mt-4 inline-flex items-center gap-2 rounded-[10px] border border-accent bg-accent px-4 py-2.5 text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
      >
        <Plus size={14} />
        {t("Plan a trip")}
      </Link>
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
  actionHref: string;
  actionLabel: string;
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
      <Link
        href={actionHref}
        className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ink transition hover:text-accent"
      >
        {actionLabel}
        <ArrowUpRight size={14} className="text-accent" />
      </Link>
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
  };
  seed: number;
}) {
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
      <div className="h-[120px]">
        <MiniRouteSvg q={tier} seed={seed} />
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Stamp tone={STATUS_TONE[status]}>{status}</Stamp>
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
                {Math.round(trip.distance_km)}
              </span>{" "}
              {t("KM")}
            </Mono>
          )}
          {trip.num_days > 0 && (
            <Mono className="uppercase">
              <span className="font-bold text-ink">{trip.num_days}</span>{" "}
              {trip.num_days === 1 ? t("DAY") : t("DAYS")}
            </Mono>
          )}
          {trip.passes_count != null && trip.passes_count > 0 && (
            <Mono className="uppercase">
              <span className="font-bold text-ink">{trip.passes_count}</span>{" "}
              {trip.passes_count === 1 ? t("PASS") : t("PASSES")}
            </Mono>
          )}
        </div>
      </div>
    </Link>
  );
}
