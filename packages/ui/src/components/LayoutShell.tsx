import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * LayoutShell · the four canonical Web App v2 shells. Spec: §20 Layouts.
 *
 * - `three-col` · 360 list / fluid map / 340 params (Trip Planner)
 * - `two-col` · fluid map / 380 detail (Road Explorer)
 * - `single-col` · header + 4-up metrics + content (History / Community)
 * - `sidebar` · 220 section nav + content (Account)
 *
 * Each variant renders a labelled, dashed-outline schematic — these are
 * documentation primitives, not actual layout components. Real screens
 * compose `NavRail` + content directly.
 */
export type LayoutShellKind =
  | "three-col"
  | "two-col"
  | "single-col"
  | "sidebar";

export interface LayoutShellProps {
  kind: LayoutShellKind;
  className?: string;
}

function Zone({
  label,
  className,
  tone = "default",
  children,
}: {
  label?: string;
  className?: string;
  tone?: "default" | "center" | "tinted";
  children?: ReactNode;
}) {
  const toneClass = {
    default: "bg-cream border-line",
    center: "bg-paper border-line",
    tinted: "bg-paper-2 border-line",
  }[tone];
  return (
    <div
      className={cn(
        "relative flex items-center justify-center rounded-md border border-dashed font-mono text-[10px] font-bold uppercase tracking-[1.2px] text-fg-mute",
        toneClass,
        className,
      )}
    >
      {label}
      {children}
    </div>
  );
}

export function LayoutShell({ kind, className }: LayoutShellProps) {
  const frameClass =
    "aspect-[5/3] grid gap-2 rounded-[14px] border border-line bg-cream p-3";

  if (kind === "three-col") {
    return (
      <div className={cn(frameClass, "grid-cols-[1fr_2fr_1fr]", className)}>
        <Zone label="LIST 360" />
        <Zone label="MAP · fluid" tone="center" />
        <Zone label="PARAMS 340" tone="tinted" />
      </div>
    );
  }

  if (kind === "two-col") {
    return (
      <div className={cn(frameClass, "grid-cols-[2fr_1fr]", className)}>
        <Zone label="MAP · fluid" tone="center" />
        <Zone label="DETAIL 380" tone="tinted" />
      </div>
    );
  }

  if (kind === "single-col") {
    return (
      <div className={cn(frameClass, "grid-cols-1", className)}>
        <div className="flex h-full flex-col gap-2">
          <Zone label="HEADER · stamp + h1 + filters" className="h-9" />
          <div className="grid grid-cols-4 gap-2">
            <Zone label="METRIC" className="h-9" />
            <Zone label="METRIC" className="h-9" />
            <Zone label="METRIC" className="h-9" />
            <Zone label="METRIC" className="h-9" />
          </div>
          <Zone label="TABLE / CARDS" className="flex-1" />
        </div>
      </div>
    );
  }

  // sidebar
  return (
    <div className={cn(frameClass, "grid-cols-[1fr_2.5fr]", className)}>
      <Zone label="SECTION NAV 220" />
      <Zone label="SETTINGS CARDS" tone="center" />
    </div>
  );
}
