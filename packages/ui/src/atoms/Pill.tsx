import type { MouseEvent, ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Pill · the workhorse chip. Spec: §08.
 * Four variants only — primary (ink), accent, ghost (outline), danger.
 * Plus an `onDark` variant for use inside ink panels.
 * Padding 5/10 · radius 999 · 11px / 700.
 */
export type PillVariant = "primary" | "accent" | "ghost" | "danger" | "on-dark";

export interface PillProps {
  children: ReactNode;
  variant?: PillVariant;
  className?: string;
  as?: "span" | "button" | "a";
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  disabled?: boolean;
  title?: string;
  href?: string;
  type?: "button" | "submit" | "reset";
}

// Source spec (§08, Design Map CSS): primary + accent have NO border;
// ghost + danger carry a 1px border in their tint. Without per-variant
// border control the pill picks up 2px of extra height/width vs the
// canonical 5/10 padding box, which reads as "wrong padding" against
// the design source.
const variantClass: Record<PillVariant, string> = {
  primary: "bg-ink text-cream border-0",
  accent: "bg-accent text-ink border-0",
  ghost: "bg-transparent text-ink border border-line-strong",
  danger: "bg-transparent text-quality-q1 border border-quality-q1",
  "on-dark": "bg-cream/10 text-cream border border-cream/15",
};

export function Pill({
  children,
  variant = "primary",
  className,
  as: Tag = "span",
  onClick,
  disabled,
  title,
  href,
  type,
}: PillProps) {
  const interactive = Tag === "button" || Tag === "a";
  const Component = Tag as "span" | "button" | "a";
  const isDisabledAnchor = Tag === "a" && disabled;
  const handleClick = (event: MouseEvent<HTMLElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <Component
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-[5px]",
        // Source pill inherits body line-height 1.5, NOT leading-none — without
        // this the line-box collapses and the pill looks ~5px shorter than the
        // canonical 5/10 padding box.
        "font-sans text-[11px] font-bold tracking-[0.2px] whitespace-nowrap leading-[1.5]",
        variantClass[variant],
        interactive &&
          !disabled &&
          "cursor-pointer transition-colors hover:brightness-95",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
      onClick={interactive ? handleClick : undefined}
      title={title}
      href={Tag === "a" && !isDisabledAnchor ? href : undefined}
      role={isDisabledAnchor ? "link" : undefined}
      tabIndex={isDisabledAnchor ? -1 : undefined}
      type={Tag === "button" ? (type ?? "button") : undefined}
      disabled={Tag === "button" ? disabled : undefined}
      aria-disabled={Tag !== "button" && disabled ? true : undefined}
    >
      {children}
    </Component>
  );
}
