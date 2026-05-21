import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * MetricTile · the KPI brick. Spec: §12.
 * Anatomy: stamp (key) → big number → unit → delta.
 * The accent number is for the *one* metric we're proudest of in a row.
 */
export type MetricTileVariant = "default" | "ink" | "paper";

const variantClass: Record<MetricTileVariant, string> = {
  default: "bg-cream border-line text-ink",
  ink: "bg-ink border-ink text-cream",
  paper: "bg-paper border-line text-ink",
};

export interface MetricTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  /** Optional secondary text under the value ("+18% vs March"). */
  delta?: ReactNode;
  variant?: MetricTileVariant;
  /** Tints the big number orange — one per row, max. */
  accentNumber?: boolean;
  className?: string;
}

export function MetricTile({
  label,
  value,
  unit,
  delta,
  variant = "default",
  accentNumber = false,
  className,
}: MetricTileProps) {
  const inverted = variant === "ink";
  return (
    <div
      className={cn(
        "rounded-[14px] border p-[18px]",
        variantClass[variant],
        className,
      )}
    >
      <div
        className={cn(
          "font-mono text-[10px] font-bold uppercase tracking-[1.6px]",
          inverted ? "text-fg-on-dark-dim" : "text-fg-dim",
        )}
      >
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <div
          className={cn(
            "font-sans text-[36px] font-extrabold leading-none tracking-[-1px]",
            accentNumber && "text-accent",
          )}
        >
          {value}
        </div>
        {unit && (
          // Source `.metric .u` carries no letter-spacing — adding any
          // tracking pushes the uppercase unit out of alignment with
          // the canonical 11 px mono rendering used on every KPI brick
          // (§12) and inside the road-preview meta strip (§13).
          <div
            className={cn(
              "font-mono text-[11px] uppercase",
              inverted ? "text-fg-on-dark-dim" : "text-fg-dim",
            )}
          >
            {unit}
          </div>
        )}
      </div>
      {delta && (
        <div
          className={cn(
            "mt-1.5 text-[11px]",
            inverted ? "text-fg-on-dark-mute" : "text-fg-mute",
          )}
        >
          {delta}
        </div>
      )}
    </div>
  );
}
