import { useId, useState, type ReactNode, type KeyboardEvent } from "react";
import { cn } from "../utils/cn";

/**
 * Tooltip · explain / reveal / onboard. Spec: §19.
 * Three jobs, one chassis: ink fill, 8 px tail, 200 ms hover delay.
 * Use a popover/alert for content that needs an action.
 */
export type TooltipPlacement = "above" | "below" | "left" | "right";
export type TooltipKind = "label" | "data" | "coach";

const placementClass: Record<TooltipPlacement, string> = {
  above: "bottom-full left-1/2 mb-2 -translate-x-1/2",
  below: "top-full left-1/2 mt-2 -translate-x-1/2",
  right: "left-full top-1/2 ml-2 -translate-y-1/2",
  left: "right-full top-1/2 mr-2 -translate-y-1/2",
};

const tailClass: Record<TooltipPlacement, string> = {
  above: "bottom-[-4px] left-1/2 -translate-x-1/2",
  below: "top-[-4px] left-1/2 -translate-x-1/2",
  right: "left-[-4px] top-1/2 -translate-y-1/2",
  left: "right-[-4px] top-1/2 -translate-y-1/2",
};

const kindClass: Record<TooltipKind, string> = {
  label: "px-2.5 py-1.5 text-[12px] font-semibold rounded-md whitespace-nowrap",
  data: "px-3 py-2.5 text-[12px] rounded-lg max-w-[220px]",
  coach:
    "px-3.5 py-3 text-[12px] rounded-[10px] max-w-[280px] shadow-[0_24px_60px_rgba(14,14,16,0.4)]",
};

export interface TooltipProps {
  /** The trigger — anchor / button / etc. */
  children: ReactNode;
  /** Tooltip body. */
  content: ReactNode;
  placement?: TooltipPlacement;
  kind?: TooltipKind;
  /** Open without hover/focus (for coach marks). */
  open?: boolean;
  className?: string;
}

export function Tooltip({
  children,
  content,
  placement = "above",
  kind = "label",
  open,
  className,
}: TooltipProps) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const visible = open ?? (hovered || focused);

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>): void => {
    if (e.key === "Escape") setFocused(false);
  };

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={handleKeyDown}
      aria-describedby={visible ? id : undefined}
    >
      {children}
      <span
        id={id}
        role="tooltip"
        aria-hidden={!visible}
        className={cn(
          "pointer-events-none absolute z-20 bg-ink text-cream font-sans",
          "shadow-[0_8px_24px_rgba(14,14,16,0.2)] transition-opacity duration-150",
          visible ? "opacity-100 delay-200" : "opacity-0",
          placementClass[placement],
          kindClass[kind],
        )}
      >
        {content}
        <span
          aria-hidden="true"
          className={cn(
            "absolute size-2 rotate-45 bg-ink",
            tailClass[placement],
          )}
        />
      </span>
    </span>
  );
}
