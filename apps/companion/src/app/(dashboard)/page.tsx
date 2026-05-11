"use client";
import { t } from "@/i18n";
import Link from "next/link";
import { useAuthStore } from "@/stores/auth";
import {
  Map,
  Route,
  History,
  BarChart3,
  ArrowUpRight,
  ChevronRight,
} from "lucide-react";
import {
  Card,
  Heading,
  Mono,
  Pill,
  QualityBars,
  Stamp,
} from "@/components/tarmoto/atoms";

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
  const firstName = user?.displayName?.split(" ")[0];
  return (
    <div className="mx-auto w-full max-w-6xl animate-fade-in space-y-8 p-7">
      {/* Hero stamp + title */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Stamp>{t("Welcome back · today")}</Stamp>
          <Heading size="xl" className="mt-2">
            {firstName ? `${t("Hello")}, ${firstName}.` : t("Hello, rider.")}
          </Heading>
          <p className="mt-2 max-w-lg text-[15px] text-ink/60">
            {t("Know the road before you ride it.")}
          </p>
        </div>
        <div className="flex gap-2">
          <Pill variant="outline">
            <Mono>{t("Metric · °C / km")}</Mono>
          </Pill>
          <Pill variant="accent">
            <Mono>{t("New road data 2h ago")}</Mono>
          </Pill>
        </div>
      </header>

      {/* Quick actions */}
      <section>
        <Stamp className="mb-3 block">{t("Jump in")}</Stamp>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_ACTIONS.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="group flex flex-col gap-4 rounded-2xl border border-ink/10 bg-cream p-5 transition hover:bg-paper"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] font-bold tracking-[1.5px] text-ink/45">
                  {action.stamp}
                </span>
                <ArrowUpRight
                  size={16}
                  className="text-ink/45 transition group-hover:text-ink"
                />
              </div>
              <action.icon size={26} className="text-ink" strokeWidth={1.8} />
              <div>
                <div className="text-[15px] font-bold text-ink">
                  {action.label}
                </div>
                <div className="mt-1 text-[12px] text-ink/55">{action.sub}</div>
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
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[80px_1fr_60px_70px_70px] gap-3 border-b border-ink/10 bg-paper px-5 py-2.5">
            <Mono className="text-[10px] uppercase tracking-[1.2px] text-ink/45">
              {t("Date")}
            </Mono>
            <Mono className="text-[10px] uppercase tracking-[1.2px] text-ink/45">
              {t("Ride")}
            </Mono>
            <Mono className="text-[10px] uppercase tracking-[1.2px] text-ink/45">
              {t("KM")}
            </Mono>
            <Mono className="text-[10px] uppercase tracking-[1.2px] text-ink/45">
              {t("Avg")}
            </Mono>
            <Mono className="text-[10px] uppercase tracking-[1.2px] text-ink/45">
              {t("Quality")}
            </Mono>
          </div>
          <div className="px-5 py-10 text-center">
            <History size={36} className="mx-auto mb-3 text-ink/30" />
            <p className="text-[14px] font-semibold text-ink">
              {t("No rides recorded yet.")}
            </p>
            <p className="mt-1 text-[12px] text-ink/55">
              {t("Your rides from the mobile app will appear here.")}
            </p>
          </div>
        </Card>
      </section>

      {/* Active trips */}
      <section>
        <SectionHeader
          stamp={t("Trip drafts")}
          title={t("Your AI route ideas")}
          actionHref="/trips/planner"
          actionLabel={t("Plan new trip")}
        />
        <Card className="overflow-hidden">
          <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
            {[
              { name: "Stelvio + Umbrail", km: 218, days: 2, q: 5 },
              { name: "Beskydy loop", km: 94, days: 1, q: 4 },
              { name: "Dolomites · east wall", km: 164, days: 1, q: 5 },
            ].map((trip) => (
              <Link
                key={trip.name}
                href="/trips/planner"
                className="group flex flex-col gap-3 rounded-xl border border-ink/10 bg-paper p-4 transition hover:border-ink/30"
              >
                <div className="flex items-start justify-between">
                  <span className="text-[15px] font-bold leading-tight text-ink">
                    {trip.name}
                  </span>
                  <QualityBars q={trip.q} size={4} />
                </div>
                <div className="flex items-center gap-3 text-[11px] text-ink/55">
                  <Mono>{trip.km} KM</Mono>
                  <span className="text-ink/30">·</span>
                  <Mono>
                    {trip.days} {trip.days > 1 ? t("days") : t("day")}
                  </Mono>
                </div>
                <div className="mt-auto flex items-center justify-between border-t border-ink/10 pt-3 text-[11px] font-semibold text-ink/60 group-hover:text-ink">
                  <span>{t("Open draft")}</span>
                  <ChevronRight size={14} />
                </div>
              </Link>
            ))}
          </div>
        </Card>
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
    <div className="mb-4 flex items-end justify-between gap-3">
      <div>
        <Stamp>{stamp}</Stamp>
        <Heading size="md" className="mt-1.5">
          {title}
        </Heading>
      </div>
      <Link
        href={actionHref}
        className="flex items-center gap-1 text-[13px] font-semibold text-ink/70 transition hover:text-accent"
      >
        {actionLabel}
        <ArrowUpRight size={14} />
      </Link>
    </div>
  );
}
