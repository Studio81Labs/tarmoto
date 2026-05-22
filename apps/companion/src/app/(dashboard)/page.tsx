"use client";
import { t } from "@/i18n";
import Link from "next/link";
import { useAuthStore } from "@/stores/auth";
import { useUserTrips } from "@/hooks/useUserTrips";
import {
  ArrowUpRight,
  BarChart3,
  History,
  Map,
  Plus,
  Route,
} from "lucide-react";
import { Card, Heading, MiniRouteSvg, Mono, Stamp } from "@tarmoto/ui";

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

// Fields not yet on the trips list endpoint (need backend follow-up
// before the populated state can show real values):
//   - distance_km (total across days)
//   - quality_avg / quality_tier (average road quality)
//   - passes_count (mountain passes touched)
// When those land, populate them on TripSummary in @/lib/types + the
// list endpoint, and the trip-draft cards below will light them up
// automatically. Until then `km` / `passes` slots stay hidden and the
// QualityBars unit only renders when quality data is present.
//
// Similarly, monthly KPI tiles (this month KM / ride time / new roads /
// max lean) need a stats endpoint, and the "Mobile synced …" pill
// needs a sync-status hook — both render their honest "empty" variants
// per spec until the data lands.

export default function HomePage() {
  const user = useAuthStore((s) => s.user);
  const { trips, loading, error: tripsError } = useUserTrips();
  const firstName = user?.displayName?.split(" ")[0];
  const draftTrips = trips
    .filter((trip) => trip.status === "draft" || trip.status === "planned")
    .slice(0, 3);

  // Surfaces stats data when wired. Until the stats endpoint exists,
  // this is null and the KPI tile row stays hidden — spec's empty-
  // state HTML has no tiles either, so honest empty matches the spec.
  const monthlyStats: MonthlyStats | null = null;

  // Same for the live sync-status hook. Spec's empty pill copy is
  // "No mobile sync yet", which is exactly what we want to show now.
  const mobileSync: MobileSyncStatus | null = null;

  // Returning rider check uses ALL trips (any status), not just
  // active drafts — an account with only active/completed trips IS a
  // returning rider, not a first-time user. When a rides signal lands
  // (we don't have a rides endpoint today), include it here too.
  const hasAnyContent = trips.length > 0;
  const hasDrafts = draftTrips.length > 0;
  // First-time hero copy ("Welcome to Tarmoto") only when we've
  // finished loading AND confirmed an empty trip list — during the
  // initial `useUserTrips()` fetch and on a network error, default to
  // "Welcome back" so returning riders don't see first-time messaging
  // flash on every cold load (statistically the dominant case under
  // normal network latency).
  const isFirstTimeUser = !loading && !tripsError && !hasAnyContent;
  // `tripsError` only matters in the empty / loading branches — when
  // we have drafts to show, swallow the error rather than nudging a
  // rider with real saved trips toward starting a new one.
  const showTripsError = tripsError && !hasAnyContent && !loading;

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
        <SyncPill status={mobileSync} />
      </header>

      {/* 4-KPI tile row (only when stats endpoint is wired) */}
      {monthlyStats && <KpiTileRow stats={monthlyStats} />}

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

      {loading ? (
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
      ) : showTripsError ? (
        // Network outage on a fresh visit: don't push them toward a
        // "Plan a trip" CTA — they may already have drafts on the
        // server that we just couldn't reach.
        <DualEmptyState
          ridesEmpty={<RidesEmptyCard />}
          tripsEmpty={
            <Card padded={false} className="px-6 py-10 text-center">
              <Stamp className="text-quality-q1">
                {t("Couldn't load your trips")}
              </Stamp>
              <p className="mx-auto mt-2 max-w-[320px] text-[12px] leading-[1.55] text-fg-dim">
                {t(
                  "We hit a network hiccup loading your drafts. Refresh to try again — your trips are safe.",
                )}
              </p>
              <button
                type="button"
                onClick={() => {
                  if (typeof window !== "undefined") window.location.reload();
                }}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-cream px-3 py-1.5 text-[12px] font-bold text-ink transition hover:bg-paper"
              >
                {t("Retry")}
              </button>
            </Card>
          }
        />
      ) : !hasAnyContent ? (
        // Per spec: both empty → simple 2-col centered cards.
        <DualEmptyState
          ridesEmpty={<RidesEmptyCard />}
          tripsEmpty={<TripsEmptyCard />}
        />
      ) : (
        // Returning rider → render the populated layout: Recent rides
        // section (centered empty card since no rides endpoint) + Trip
        // drafts section (3-up grid when there are drafts, otherwise
        // a centered empty Card so the section affordance stays
        // visible to riders with only active/completed trips).
        <>
          <SectionHeader
            stamp={t("Recent rides")}
            title={t("Last 30 days")}
            actionHref="/rides"
            actionLabel={t("View all")}
          />
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

          <div className="mt-10">
            <SectionHeader
              stamp={t("Trip drafts")}
              title={t("Your route ideas")}
              actionHref="/trips/planner"
              actionLabel={t("Plan new trip")}
            />
            {hasDrafts ? (
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

interface MonthlyStats {
  thisMonthKm: number;
  rideHours: number;
  newRoads: number;
  maxLeanDeg: number;
  vsLastMonthKm: string;
  vsLastMonthHours: string;
  newRoadsThisMonth: number;
  maxLeanLocation: string;
}

interface MobileSyncStatus {
  syncedAt: Date;
}

function SyncPill({ status }: { status: MobileSyncStatus | null }) {
  if (!status) {
    // Spec's empty-state pill — ghost / line-strong border / fg-mute
    // dot + text. Truthful while the mobile-sync hook is unwired.
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
      {formatSyncedLabel(status.syncedAt)}
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
  return (
    <div className="mb-8 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
      <KpiTile
        label={t("This month")}
        value={stats.thisMonthKm.toLocaleString()}
        unit="KM"
        delta={`+${stats.vsLastMonthKm} vs last month`}
        ink
        accentValue
      />
      <KpiTile
        label={t("Ride time")}
        value={String(stats.rideHours)}
        unit="HRS"
        delta={`+${stats.vsLastMonthHours} vs last month`}
      />
      <KpiTile
        label={t("New roads")}
        value={String(stats.newRoads)}
        unit="DISCOVERED"
        delta={`+${stats.newRoadsThisMonth} this month`}
      />
      <KpiTile
        label={t("Lean angle")}
        value={`${stats.maxLeanDeg}°`}
        unit="MAX"
        delta={stats.maxLeanLocation}
        accentValue
      />
    </div>
  );
}

interface KpiTileProps {
  label: string;
  value: string;
  unit: string;
  delta?: string;
  ink?: boolean;
  accentValue?: boolean;
}
function KpiTile({
  label,
  value,
  unit,
  delta,
  ink,
  accentValue,
}: KpiTileProps) {
  return (
    <div
      className={
        ink
          ? "rounded-[14px] border border-ink bg-ink p-[18px] text-cream"
          : "rounded-[14px] border border-line bg-cream p-[18px] text-ink"
      }
    >
      <Stamp tone={ink ? "on-dark" : "dim"}>{label}</Stamp>
      <div className="mt-2 flex items-baseline gap-1.5">
        <div
          className={
            accentValue
              ? "text-[36px] font-extrabold leading-none tracking-[-1px] text-accent"
              : ink
                ? "text-[36px] font-extrabold leading-none tracking-[-1px] text-cream"
                : "text-[36px] font-extrabold leading-none tracking-[-1px] text-ink"
          }
        >
          {value}
        </div>
        <Mono
          className={
            ink ? "text-[11px] text-fg-on-dark-dim" : "text-[11px] text-fg-dim"
          }
        >
          {unit}
        </Mono>
      </div>
      {delta && (
        <div
          className={
            ink
              ? "mt-1.5 text-[11px] text-fg-on-dark-mute"
              : "mt-1.5 text-[11px] text-fg-mute"
          }
        >
          {delta}
        </div>
      )}
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
  trip: { id: string; name: string; status: string; num_days: number };
  seed: number;
}) {
  const status =
    (trip.status as "draft" | "planned" | "active" | "completed") ?? "draft";
  // No quality / km / passes on summary payloads yet — wire those
  // through when the trips list endpoint exposes them (see TODO at
  // file top). For now the thumbnail uses q=3 (yellow-ish neutral)
  // and we hide the QualityBars + km + passes meta slots.
  const q: 1 | 2 | 3 | 4 | 5 = 3;
  return (
    <Link
      href={`/trips/${trip.id}`}
      className="block overflow-hidden rounded-[14px] border border-line bg-cream transition hover:border-line-strong"
    >
      <div className="h-[120px]">
        <MiniRouteSvg q={q} seed={seed} />
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Stamp tone={STATUS_TONE[status]}>{status}</Stamp>
            <div className="mt-1 line-clamp-2 text-[16px] font-extrabold leading-tight text-ink">
              {trip.name}
            </div>
          </div>
        </div>
        <div className="mt-2.5 flex items-center gap-3 text-[11px] text-fg-dim">
          {trip.num_days > 0 && (
            <Mono className="uppercase">
              <span className="font-bold text-ink">{trip.num_days}</span>{" "}
              {trip.num_days === 1 ? t("day") : t("days")}
            </Mono>
          )}
          {/* km + passes hidden until the trips list endpoint exposes them */}
        </div>
      </div>
    </Link>
  );
}
