import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { Card, Mono, TarmotoMark } from "@tarmoto/ui";
import type { Formatters } from "@tarmoto/shared";
import { splitCompactMetricDuration } from "@/format/metricTile";
import type { Translate } from "@/i18n";
import type { RoutePreview } from "@/lib/ride-detail";
import type { FreeToggleFeatureKey } from "@tarmoto/shared";
import { KillSwitchShareCta } from "@/components/KillSwitchShareCta";

/**
 * Shared chrome for the public (unauthenticated) share pages
 * (`/rides/shared/:token`, `/trips/shared/:token`). Kept in one place so both
 * pages stay visually consistent — a cream header/footer, the three-stroke
 * route-preview SVG with A/B endpoint markers, and the pill/CTA atoms. All
 * pieces are server-renderable (plain `<Link>`, no client island).
 */

/**
 * Sticky public header: a home-linked logo + a "TARMOTO / <breadcrumb>" trail
 * and a CTA into the app. Both the logo and the CTA point at `/` (the companion
 * home, which is public) so a visitor can always reach the app.
 */
export function PublicShareHeader({
  breadcrumb,
  t,
}: {
  breadcrumb: string;
  t: Translate;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-cream/[0.86] backdrop-blur-[12px] backdrop-saturate-[1.4]">
      <div className="mx-auto flex h-[60px] max-w-[980px] items-center justify-between gap-4 px-7">
        <Link
          href="/"
          aria-label={t("Tarmoto home")}
          className="flex min-w-0 items-center gap-2.5 transition hover:opacity-80"
        >
          <span className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-lg bg-accent">
            <TarmotoMark size={17} />
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-extrabold tracking-tight">
              {t("TARMOTO")}
            </span>
            <span className="text-ink/40">/</span>
            <Mono className="truncate text-[11px] text-fg-dim">
              {breadcrumb}
            </Mono>
          </div>
        </Link>
        <ShareCtaLink
          href="/"
          variant="outline"
          icon={<ArrowUpRight size={14} />}
        >
          {t("Open Tarmoto")}
        </ShareCtaLink>
      </div>
    </header>
  );
}

/** Public footer: a "shared via public link" stamp + a single ink CTA. */
export function PublicShareFooter({
  cta,
  year,
  t,
}: {
  cta: {
    href: string;
    label: string;
    icon: ReactNode;
    /**
     * Hide the CTA when this operator kill switch is off. Set it whenever the
     * destination is itself gated — this page is server-rendered, so the check
     * has to happen in a client island (see `KillSwitchShareCta`).
     */
    feature?: FreeToggleFeatureKey;
  };
  year: number;
  t: Translate;
}) {
  return (
    <footer className="border-t border-line bg-paper-2">
      <div className="mx-auto flex max-w-[980px] flex-wrap items-center justify-between gap-4 px-7 py-[22px]">
        <Mono className="text-[11px] tracking-[0.5px] text-fg-mute">
          {t("TARMOTO · SHARED VIA PUBLIC LINK · {year}", { year })}
        </Mono>
        {cta.feature ? (
          <KillSwitchShareCta
            feature={cta.feature}
            href={cta.href}
            label={cta.label}
            icon={cta.icon}
          />
        ) : (
          <ShareCtaLink href={cta.href} variant="ink" icon={cta.icon}>
            {cta.label}
          </ShareCtaLink>
        )}
      </div>
    </footer>
  );
}

/**
 * Route-preview card: title + subtitle over the three-stroke route SVG with a
 * Start/Finish legend, or an empty-state panel when there's no drawable route.
 * `preview.path` may contain multiple `M`-separated subpaths (e.g. per trip
 * day) — they render as separate strokes and the A/B markers land on the first
 * and last projected points overall.
 */
export function SharedRoutePreviewCard({
  preview,
  label,
  title,
  subtitle,
  emptyText,
  t,
}: {
  preview: RoutePreview | null;
  label: string;
  title: string;
  subtitle: string;
  emptyText: string;
  t: Translate;
}) {
  return (
    <Card className="mb-6 p-6">
      <h2 className="text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
        {title}
      </h2>
      <p className="mt-1 text-[13.5px] text-fg-dim">{subtitle}</p>
      <div className="relative mt-[18px] overflow-hidden rounded-xl border border-line">
        {preview ? (
          <>
            <RoutePreviewSvg
              path={preview.path}
              viewBox={preview.viewBox}
              width={preview.width}
              height={preview.height}
              markers={preview.markers ?? []}
              label={label}
            />
            <div className="absolute bottom-4 left-4 flex gap-4 rounded-[10px] border border-line-strong bg-cream px-3 py-2.5 shadow-[0_6px_16px_rgba(14,14,16,0.08)]">
              <LegendDot label={t("Start")} ink />
              <LegendDot label={t("Finish")} />
              {preview.markers && preview.markers.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="grid h-4 w-4 place-items-center">
                    <span className="h-2.5 w-2.5 rounded-full border-2 border-ink bg-cream" />
                  </span>
                  <span className="text-[11px] font-semibold text-ink">
                    {t("Stops")}
                  </span>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-[280px] items-center justify-center bg-paper-2 text-sm text-fg-dim">
            {emptyText}
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Cream route preview. Three stacked strokes (casing → ink shadow → accent)
 * plus A/B endpoint markers, matching the in-app route styling. Stroke and
 * marker sizes scale with the fitted viewBox so narrow or square routes stay
 * legible.
 */
function RoutePreviewSvg({
  path,
  viewBox,
  width,
  height,
  markers = [],
  label,
}: {
  path: string;
  viewBox: string;
  width: number;
  height: number;
  markers?: { x: number; y: number }[];
  label: string;
}) {
  const dim = Math.max(width, height);
  const casingW = dim * 0.014;
  const shadowW = dim * 0.0094;
  const accentW = dim * 0.007;
  const markerR = dim * 0.02;
  const markerFont = dim * 0.019;
  const viaR = dim * 0.0115;
  const ends = previewEndpoints(path);
  return (
    <svg
      viewBox={viewBox}
      role="img"
      aria-label={label}
      preserveAspectRatio="xMidYMid meet"
      className="block h-auto max-h-[460px] w-full bg-paper-2"
    >
      <path
        d={path}
        fill="none"
        stroke="#C4BBA8"
        strokeWidth={casingW}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={path}
        fill="none"
        stroke="#0E0E10"
        strokeWidth={shadowW}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.18}
      />
      <path
        d={path}
        fill="none"
        stroke="#FF6A1A"
        strokeWidth={accentW}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {markers.map((m, i) => (
        <circle
          key={i}
          cx={m.x}
          cy={m.y}
          r={viaR}
          fill="#F5EFE6"
          stroke="#0E0E10"
          strokeWidth={viaR * 0.34}
        />
      ))}
      {ends && (
        <g>
          <circle
            cx={ends.start.x}
            cy={ends.start.y}
            r={markerR}
            fill="#0E0E10"
            stroke="#F5EFE6"
            strokeWidth={markerR * 0.19}
          />
          <text
            x={ends.start.x}
            y={ends.start.y + markerFont * 0.34}
            textAnchor="middle"
            fill="#F5EFE6"
            fontFamily="var(--font-jetbrains, monospace)"
            fontSize={markerFont}
            fontWeight={800}
          >
            A
          </text>
          <circle
            cx={ends.end.x}
            cy={ends.end.y}
            r={markerR}
            fill="#FF6A1A"
            stroke="#0E0E10"
            strokeWidth={markerR * 0.15}
          />
          <text
            x={ends.end.x}
            y={ends.end.y + markerFont * 0.34}
            textAnchor="middle"
            fill="#0E0E10"
            fontFamily="var(--font-jetbrains, monospace)"
            fontSize={markerFont}
            fontWeight={800}
          >
            B
          </text>
        </g>
      )}
    </svg>
  );
}

/** First and last projected point of the SVG path (the route endpoints). */
function previewEndpoints(
  path: string,
): { start: { x: number; y: number }; end: { x: number; y: number } } | null {
  const nums = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (!nums || nums.length < 4) return null;
  return {
    start: { x: nums[0]!, y: nums[1]! },
    end: { x: nums[nums.length - 2]!, y: nums[nums.length - 1]! },
  };
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

/** Rounded meta pill used in the share hero. */
export function SharePill({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line-strong bg-cream px-[13px] py-[7px] text-[12.5px] font-semibold text-fg-dim">
      <span className="flex text-fg-mute">{icon}</span>
      {children}
    </span>
  );
}

/**
 * Public-page CTA. Plain styled `<Link>` (not the `Button` atom) so the pages
 * stay server components with no client island just for navigation.
 */
export function ShareCtaLink({
  href,
  children,
  icon,
  variant,
}: {
  href: string;
  children: ReactNode;
  icon: ReactNode;
  variant: "outline" | "ink";
}) {
  return (
    <Link
      href={href}
      className={`inline-flex flex-shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] transition ${
        variant === "ink"
          ? "border border-ink bg-ink text-cream hover:bg-ink/90"
          : "border border-line-strong bg-transparent text-ink hover:bg-paper-2"
      }`}
    >
      {icon}
      {children}
    </Link>
  );
}

/**
 * Format a duration for a MetricTile without splitting inside a localized
 * measurement. For a compound duration, the first complete measurement keeps
 * the large value style and the second complete measurement uses the compact
 * suffix style. This remains safe for both "4h 12m" and "saa 4 dak 12".
 */
export function splitDuration(min: number | null, format: Formatters) {
  return splitCompactMetricDuration(min, format);
}
