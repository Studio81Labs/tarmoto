import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * ALL-CAPS technical label. JetBrains Mono · 11px · 1.6 letter-spacing.
 * Spec: Web App v2 Design Map · §07 Atoms (source `.stamp` rule:
 * `letter-spacing: 1.6px`).
 */
export interface StampProps {
  children: ReactNode;
  tone?: "dim" | "ink" | "accent" | "on-dark" | "on-dark-dim";
  as?: "span" | "div" | "h2" | "h3" | "h4";
  className?: string;
}

export function Stamp({
  children,
  tone = "dim",
  as: Tag = "span",
  className,
}: StampProps) {
  return (
    <Tag
      className={cn(
        "font-mono text-[11px] font-bold uppercase tracking-[1.6px] leading-none",
        tone === "dim" && "text-fg-dim",
        tone === "ink" && "text-ink",
        tone === "accent" && "text-accent",
        tone === "on-dark" && "text-fg-on-dark-dim",
        tone === "on-dark-dim" && "text-fg-on-dark-mute",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
