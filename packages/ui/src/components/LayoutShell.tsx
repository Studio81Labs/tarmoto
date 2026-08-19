import { cn } from "../utils/cn";

/**
 * LayoutShell · the four canonical Web App v2 shells. Spec: §24 Layouts.
 *
 * - `three-col` · 360 list / fluid map / 340 params (Trip Planner)
 * - `two-col` · fluid map / 380 detail (Road Explorer)
 * - `single-col` · header + 4-up metrics + content (History / Community)
 * - `sidebar` · 220 section nav + content (Account)
 *
 * Each variant renders a labelled schematic — these are documentation
 * primitives, not actual layout components. Real screens compose
 * `NavRail` + content directly. Mirrors the `.pattern-frame` rendering
 * in the canonical Design Map source (full-bleed zones split by 1 px
 * dashed line for the 3/2/sidebar shells; an inner padded grid for
 * single-col so the header/metrics/table reading order is visible).
 */
export type LayoutShellKind =
  "three-col" | "two-col" | "single-col" | "sidebar";

export interface LayoutShellProps {
  kind: LayoutShellKind;
  className?: string;
}

const FRAME =
  "relative aspect-[16/9] overflow-hidden rounded-[14px] border border-line bg-cream";

// Source `.zone` styling: dashed right border between siblings, no
// outer outline. `last:` strips the trailing divider. `center`/`tinted`
// both resolve to --paper in source — kept as a flag so callers can
// still distinguish, but they render identically.
const ZONE_BASE =
  "flex items-center justify-center border-r border-dashed border-line p-2.5 font-mono text-[9px] font-bold uppercase tracking-[1px] text-fg-mute last:border-r-0";

const ZONE_TONE = {
  default: "bg-cream",
  paper: "bg-paper",
} as const;

function ColZone({
  label,
  tone = "default",
}: {
  label: string;
  tone?: keyof typeof ZONE_TONE;
}) {
  return <div className={cn(ZONE_BASE, ZONE_TONE[tone])}>{label}</div>;
}

// Inner zone for the single-col layout: standalone dashed-outlined card
// (not a column divider), since this shell stacks reading order rather
// than partitions space.
function InnerZone({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded border border-dashed border-line p-2 font-mono text-[9px] font-bold uppercase tracking-[1px] text-fg-mute",
        className,
      )}
    >
      {label}
    </div>
  );
}

export function LayoutShell({ kind, className }: LayoutShellProps) {
  if (kind === "three-col") {
    return (
      <div
        className={cn(FRAME, "grid", className)}
        style={{ gridTemplateColumns: "22% 1fr 26%" }}
      >
        <ColZone label="LIST 360" />
        <ColZone label="MAP · fluid" tone="paper" />
        <ColZone label="PARAMS 340" tone="paper" />
      </div>
    );
  }

  if (kind === "two-col") {
    return (
      <div
        className={cn(FRAME, "grid", className)}
        style={{ gridTemplateColumns: "1fr 30%" }}
      >
        <ColZone label="MAP · fluid" tone="paper" />
        <ColZone label="DETAIL 380" tone="paper" />
      </div>
    );
  }

  if (kind === "single-col") {
    return (
      <div className={cn(FRAME, "p-4", className)}>
        <div className="flex h-full flex-col gap-2">
          <InnerZone label="HEADER · stamp + h1 + filters" className="py-2" />
          <div className="grid grid-cols-4 gap-1.5">
            <InnerZone label="METRIC" className="py-2" />
            <InnerZone label="METRIC" className="py-2" />
            <InnerZone label="METRIC" className="py-2" />
            <InnerZone label="METRIC" className="py-2" />
          </div>
          <InnerZone label="TABLE / CARDS" className="flex-1" />
        </div>
      </div>
    );
  }

  // sidebar — fixed 220 px nav + fluid content
  return (
    <div
      className={cn(FRAME, "grid", className)}
      style={{ gridTemplateColumns: "220px 1fr" }}
    >
      <ColZone label="SECTION NAV 220" />
      <ColZone label="SETTINGS CARDS" tone="paper" />
    </div>
  );
}
