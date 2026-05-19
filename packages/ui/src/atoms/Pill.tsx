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

const variantClass: Record<PillVariant, string> = {
  primary: "bg-ink text-cream border-ink",
  accent: "bg-accent text-ink border-accent",
  ghost: "bg-transparent text-ink border-line-strong",
  danger: "bg-transparent text-quality-q1 border-quality-q1",
  "on-dark": "bg-cream/10 text-cream border-cream/15",
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
  return (
    <Component
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[5px]",
        "font-sans text-[11px] font-bold tracking-[0.2px] whitespace-nowrap leading-none",
        variantClass[variant],
        interactive &&
          !disabled &&
          "cursor-pointer transition-colors hover:brightness-95",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
      onClick={onClick}
      title={title}
      href={Tag === "a" ? href : undefined}
      type={Tag === "button" ? (type ?? "button") : undefined}
      disabled={Tag === "button" ? disabled : undefined}
      aria-disabled={Tag !== "button" && disabled ? true : undefined}
    >
      {children}
    </Component>
  );
}
