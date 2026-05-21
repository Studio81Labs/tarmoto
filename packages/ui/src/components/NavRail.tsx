import type { ReactNode } from "react";
import { cn } from "../utils/cn";
import { TarmotoMark } from "../atoms/TarmotoMark";

/**
 * NavRail · 220 px ink rail on the left of every web view. Spec: §14.
 * Layout: brand → divider → numbered nav → spacer → footer slot.
 * Active item is accent fill, ink text, 800 weight.
 *
 * This is a presentational component — the consumer decides how active
 * items are computed (router/path), and how each item renders (link,
 * button, anchor, etc.) via the `renderItem` slot.
 */
export interface NavRailItem {
  key: string;
  num: string;
  label: string;
  active?: boolean;
  onClick?: () => void;
  href?: string;
}

export interface NavRailProps {
  items: ReadonlyArray<NavRailItem>;
  brandTitle?: string;
  brandSub?: string;
  /** Slot rendered below the divider, above the items (rare). */
  topSlot?: ReactNode;
  /** Slot rendered at the bottom of the rail (contribution module, user row). */
  footer?: ReactNode;
  /** Override how each item is rendered (e.g. to wrap in Next.js Link). */
  renderItem?: (item: NavRailItem) => ReactNode;
  className?: string;
}

function defaultRenderItem(item: NavRailItem): ReactNode {
  const cls = cn(
    "flex items-center gap-2.5 rounded-lg px-3 py-2.5",
    "font-sans text-[13px] transition-colors duration-100 cursor-pointer",
    item.active
      ? "bg-accent text-ink font-extrabold"
      : "bg-transparent text-cream font-semibold hover:bg-cream/6",
  );
  const numCls = cn(
    "font-mono text-[10px] font-bold w-[18px] shrink-0",
    item.active ? "text-ink" : "text-cream/40",
  );
  const inner = (
    <>
      <span className={numCls}>{item.num}</span>
      <span>{item.label}</span>
    </>
  );
  if (item.href) {
    return (
      <a key={item.key} href={item.href} className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <button
      key={item.key}
      type="button"
      onClick={item.onClick}
      className={cn(cls, "border-0 w-full text-left")}
    >
      {inner}
    </button>
  );
}

export function NavRail({
  items,
  brandTitle = "TARMOTO",
  // Brand sub-text (e.g. "WEB · v1.4") is intentionally undefined by
  // default. The companion + preview both render just the mark + name,
  // matching the canonical brand mark in `docs/design/brand/`. Consumers
  // can still pass `brandSub` for one-off documentation demos.
  brandSub,
  topSlot,
  footer,
  renderItem = defaultRenderItem,
  className,
}: NavRailProps) {
  return (
    <aside
      className={cn(
        // Source rail spec: 220 px wide, padding 20 / 14 (vertical /
        // horizontal). The previous `p-5` gave us 20 / 20 — slightly too
        // wide horizontally; this matches the canonical Geometry list.
        "flex w-[220px] shrink-0 flex-col gap-4 bg-ink px-3.5 py-5 text-cream",
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-accent">
          <TarmotoMark size={16} color="#0E0E10" />
        </span>
        <span className="leading-none">
          <span className="block text-[15px] font-extrabold tracking-tight">
            {brandTitle}
          </span>
          {brandSub && (
            <span className="mt-0.5 block font-mono text-[9px] tracking-[1px] text-cream/50 uppercase">
              {brandSub}
            </span>
          )}
        </span>
      </div>

      <div className="h-px bg-cream/8" />

      {topSlot}

      <nav className="flex flex-col gap-0.5">
        {items.map((item) => renderItem(item))}
      </nav>

      {footer && <div className="mt-auto flex flex-col gap-4">{footer}</div>}
    </aside>
  );
}

/**
 * Contribution module · the "YOUR CONTRIBUTION" callout that lives at
 * the bottom of the rail with a big km count and a progress bar.
 * Standalone so consumers can choose to include it or not.
 */
export function NavRailContribution({
  label = "YOUR CONTRIBUTION",
  value,
  unit,
  /** Progress 0–1. */
  progress = 0,
  className,
}: {
  label?: string;
  value: ReactNode;
  unit?: string;
  progress?: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  return (
    <div
      className={cn(
        "rounded-[10px] border border-cream/8 bg-cream/6 p-3",
        className,
      )}
    >
      <div className="font-mono text-[9px] font-bold uppercase tracking-[1.4px] text-cream/55">
        {label}
      </div>
      <div className="mt-1 text-[22px] font-extrabold leading-none tracking-[-0.5px] text-cream">
        {value}
        {unit && (
          <span className="ml-1.5 font-mono text-[10px] font-medium text-cream/60">
            {unit}
          </span>
        )}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-[2px] bg-cream/10">
        <div
          className="h-full rounded-[2px] bg-accent transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
