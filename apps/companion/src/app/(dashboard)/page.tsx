"use client";
import { t } from "@/i18n";
import Link from "next/link";
import { useAuthStore } from "@/stores/auth";
import { useUserTrips } from "@/hooks/useUserTrips";
import {
  Map,
  Route,
  History,
  BarChart3,
  ArrowUpRight,
  ChevronRight,
} from "lucide-react";
import { Card, Heading, Mono, Stamp } from "@tarmoto/ui";

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

// Trip list rows come from the trips list endpoint which carries only
// id / name / status / num_days. Per-trip total km, quality average and
// pass count are not yet exposed there, so the meta strip below stays
// minimal until the API returns those fields. See `useUserTrips`.

export default function HomePage() {
  const user = useAuthStore((s) => s.user);
  const { trips, loading, error: tripsError } = useUserTrips();
  const firstName = user?.displayName?.split(" ")[0];
  const draftTrips = trips
    .filter((trip) => trip.status === "draft" || trip.status === "planned")
    .slice(0, 3);

  return (
    <div className="mx-auto w-full max-w-page animate-fade-in space-y-10 p-7">
      {/* Hero */}
      <header>
        <Stamp>{t("Welcome back")}</Stamp>
        <Heading size="2xl" as="h1" className="mt-1">
          {firstName ? `${t("Hello")}, ${firstName}.` : t("Hello, rider.")}
        </Heading>
        <p className="mt-2 max-w-lg text-[15px] text-fg-dim">
          {t("Know the road before you ride it.")}
        </p>
      </header>

      {/* Quick actions */}
      <section>
        <Stamp className="mb-3 block">{t("Jump in")}</Stamp>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_ACTIONS.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="group flex min-h-[160px] flex-col gap-3.5 rounded-[14px] border border-line bg-cream p-5 transition hover:bg-paper"
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
                size={26}
                strokeWidth={1.8}
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
      </section>

      {/* Recent rides */}
      <section>
        <SectionHeader
          stamp={t("Recent rides")}
          title={t("Last 30 days")}
          actionHref="/rides"
          actionLabel={t("View all")}
        />
        <Card padded={false} className="overflow-hidden">
          <div className="grid grid-cols-[80px_1fr_60px_70px_70px] gap-3 border-b border-line bg-paper px-5 py-2.5">
            <Mono className="text-[10px] font-bold uppercase tracking-[1.2px] text-fg-mute">
              {t("Date")}
            </Mono>
            <Mono className="text-[10px] font-bold uppercase tracking-[1.2px] text-fg-mute">
              {t("Ride")}
            </Mono>
            <Mono className="text-[10px] font-bold uppercase tracking-[1.2px] text-fg-mute">
              {t("KM")}
            </Mono>
            <Mono className="text-[10px] font-bold uppercase tracking-[1.2px] text-fg-mute">
              {t("Avg")}
            </Mono>
            <Mono className="text-[10px] font-bold uppercase tracking-[1.2px] text-fg-mute">
              {t("Quality")}
            </Mono>
          </div>
          <div className="px-5 py-10 text-center">
            <History
              size={36}
              className="mx-auto mb-3 text-ink/30"
              strokeWidth={1.5}
            />
            <p className="text-[14px] font-semibold text-ink">
              {t("No rides recorded yet.")}
            </p>
            <p className="mt-1 text-[12px] text-fg-dim">
              {t("Your rides from the mobile app will appear here.")}
            </p>
          </div>
        </Card>
      </section>

      {/* Trip drafts */}
      <section>
        <SectionHeader
          stamp={t("Trip drafts")}
          title={t("Your route ideas")}
          actionHref="/trips/planner"
          actionLabel={t("Plan new trip")}
        />
        {loading ? (
          <Card>
            <div className="px-5 py-10 text-center text-[13px] text-fg-dim">
              {t("Loading your trips…")}
            </div>
          </Card>
        ) : tripsError && draftTrips.length === 0 ? (
          // Distinguish "we don't know" from "rider has none" — a transient
          // API outage or expired token must not nudge a rider with real
          // saved drafts to start a brand new trip.
          <Card>
            <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
              <Stamp className="text-quality-q1">
                {t("Couldn't load your trips")}
              </Stamp>
              <p className="max-w-sm text-[12px] text-fg-dim">
                {t(
                  "We hit a network hiccup while loading your drafts. Refresh the page to try again — your trips are safe.",
                )}
              </p>
              <button
                type="button"
                onClick={() => {
                  if (typeof window !== "undefined") window.location.reload();
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-cream px-3 py-1.5 text-[12px] font-bold text-ink transition hover:bg-paper"
              >
                {t("Retry")}
              </button>
            </div>
          </Card>
        ) : draftTrips.length === 0 ? (
          <Card>
            <div className="px-5 py-12 text-center">
              <Route
                size={36}
                className="mx-auto mb-3 text-ink/30"
                strokeWidth={1.5}
              />
              <p className="text-[14px] font-semibold text-ink">
                {t("No trips planned yet.")}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-[12px] text-fg-dim">
                {t(
                  "Create your first trip to discover the best roads. Pick a region, tune the curves and asphalt, push it to your phone.",
                )}
              </p>
              <Link
                href="/trips/planner"
                className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-ink px-4 py-2.5 text-[13px] font-bold text-cream transition hover:bg-tarmac"
              >
                {t("Plan a trip")}
                <ArrowUpRight size={14} />
              </Link>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {draftTrips.map((trip) => {
              const days = trip.num_days;
              return (
                <Link
                  key={trip.id}
                  href={`/trips/${trip.id}`}
                  className="group block overflow-hidden rounded-[14px] border border-line bg-cream transition hover:border-line-strong"
                >
                  <TripDraftThumb />
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <Stamp>{trip.status}</Stamp>
                        <div className="mt-1 line-clamp-2 text-[16px] font-extrabold leading-tight text-ink">
                          {trip.name}
                        </div>
                      </div>
                    </div>
                    {days > 0 && (
                      <div className="mt-3 flex items-center gap-3 text-[11px] text-fg-dim">
                        <Mono className="uppercase">
                          <span className="font-bold text-ink">{days}</span>{" "}
                          {days > 1 ? t("days") : t("day")}
                        </Mono>
                      </div>
                    )}
                    <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-[11px] font-semibold text-fg-dim group-hover:text-ink">
                      <span>{t("Open draft")}</span>
                      <ChevronRight size={14} />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
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
    <div className="mb-3.5 flex items-end justify-between gap-3">
      <div>
        <Stamp>{stamp}</Stamp>
        <Heading size="lg" as="h2" className="mt-1">
          {title}
        </Heading>
      </div>
      <Link
        href={actionHref}
        className="flex items-center gap-1.5 text-[13px] font-bold text-ink transition hover:text-accent"
      >
        {actionLabel}
        <ArrowUpRight size={14} className="text-accent" />
      </Link>
    </div>
  );
}

// Trip-card thumb · paper noise + topo + abstract route line.
// Spec uses MiniRouteSvg from v2-pages.jsx — we keep the same visual
// language (paper noise + topo contours + single quality-coloured
// ribbon) but inline here since `RouteMini` in @tarmoto/ui carries
// fixed multi-segment geometry that's overkill for an unloaded draft
// (no quality data yet). When trip list payloads gain a quality field,
// swap this for `RouteMini` with the real segment ribbon.
function TripDraftThumb() {
  return (
    <div className="h-[120px] w-full bg-paper">
      <svg
        viewBox="0 0 200 120"
        preserveAspectRatio="xMidYMid slice"
        className="size-full"
        aria-hidden="true"
      >
        <g stroke="rgba(14,14,16,0.10)" strokeWidth="1" fill="none">
          <path d="M -10 30 C 50 22, 110 38, 210 26" />
          <path d="M -10 50 C 50 44, 110 58, 210 48" />
          <path d="M -10 70 C 50 62, 110 78, 210 68" />
          <path d="M -10 90 C 50 84, 110 98, 210 88" />
        </g>
        <path
          d="M 10 100 C 50 80, 90 70, 120 50 S 170 30, 195 20"
          stroke="#C4BBA8"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
        />
        <circle cx="10" cy="100" r="4" fill="#0E0E10" />
        <circle
          cx="195"
          cy="20"
          r="4"
          fill="#FF6A1A"
          stroke="#0E0E10"
          strokeWidth="1"
        />
      </svg>
    </div>
  );
}
