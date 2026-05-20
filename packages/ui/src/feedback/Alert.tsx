import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Alert · persistent in-layout notification. Spec: §18.
 * Five intents share one anatomy: stripe + glyph + title + body + optional action.
 * Cap visible stack at 3 — collapse the rest behind a "+ N more" pill.
 */
export type AlertIntent = "info" | "success" | "warning" | "danger" | "neutral";

const containerClass: Record<AlertIntent, string> = {
  info: "bg-paper border-line",
  success: "bg-quality-q5/12 border-quality-q5/40",
  warning: "bg-accent/8 border-accent/35",
  danger: "bg-quality-q1/8 border-quality-q1/40",
  neutral: "bg-paper-2 border-line",
};

const stripeClass: Record<AlertIntent, string> = {
  info: "bg-ink",
  success: "bg-quality-q5",
  warning: "bg-accent",
  danger: "bg-quality-q1",
  neutral: "bg-fg-mute",
};

const glyphClass: Record<AlertIntent, string> = {
  info: "text-ink",
  success: "text-[#2E8B4F]",
  warning: "text-accent",
  danger: "text-quality-q1",
  neutral: "text-fg-dim",
};

const titleClass: Record<AlertIntent, string> = {
  info: "text-ink",
  success: "text-ink",
  warning: "text-ink",
  danger: "text-quality-q1",
  neutral: "text-ink",
};

function defaultGlyph(intent: AlertIntent): ReactNode {
  switch (intent) {
    case "success":
      return (
        <svg viewBox="0 0 16 16" width={14} height={14}>
          <path
            d="M 3 8.5 L 6.5 12 L 13 4.5"
            stroke="currentColor"
            strokeWidth={2}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "warning":
      return (
        <svg viewBox="0 0 16 16" width={14} height={14}>
          <path
            d="M 8 1 L 15 14 L 1 14 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          <path
            d="M 8 6 L 8 10"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <circle cx="8" cy="12" r="0.8" fill="currentColor" />
        </svg>
      );
    case "danger":
      return (
        <svg viewBox="0 0 16 16" width={14} height={14}>
          <circle
            cx="8"
            cy="8"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          />
          <path
            d="M 5 5 L 11 11 M 11 5 L 5 11"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </svg>
      );
    case "neutral":
      return (
        <svg viewBox="0 0 16 16" width={14} height={14}>
          <rect
            x={2}
            y={3}
            width={12}
            height={10}
            rx={1.5}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          />
          <path
            d="M 5 3 L 5 13 M 11 3 L 11 13"
            stroke="currentColor"
            strokeWidth={1.5}
          />
        </svg>
      );
    case "info":
    default:
      return (
        <svg viewBox="0 0 16 16" width={14} height={14}>
          <circle
            cx="8"
            cy="8"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          />
          <circle cx="8" cy="4.5" r="1" fill="currentColor" />
          <path
            d="M 8 7 L 8 12"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

export interface AlertProps {
  intent?: AlertIntent;
  title: ReactNode;
  children?: ReactNode;
  /** Optional CTA rendered at the right edge (typically a Button sm). */
  action?: ReactNode;
  /** Compact variant for inline placement inside another card. */
  compact?: boolean;
  glyph?: ReactNode;
  className?: string;
}

export function Alert({
  intent = "info",
  title,
  children,
  action,
  compact = false,
  glyph,
  className,
}: AlertProps) {
  return (
    <div
      role="status"
      className={cn(
        "relative grid items-center gap-3 border",
        compact
          ? "grid-cols-[18px_1fr] rounded-lg py-2.5 pl-[22px] pr-3.5"
          : action
            ? "grid-cols-[24px_1fr_auto] rounded-[12px] py-3.5 pl-[26px] pr-[18px]"
            : "grid-cols-[24px_1fr] rounded-[12px] py-3.5 pl-[26px] pr-[18px]",
        containerClass[intent],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute rounded-[2px]",
          compact
            ? "left-1.5 top-1.5 bottom-1.5 w-[3px]"
            : "left-2 top-2 bottom-2 w-1",
          stripeClass[intent],
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "grid place-items-center",
          compact ? "size-[18px]" : "size-6",
          glyphClass[intent],
        )}
      >
        {glyph ?? defaultGlyph(intent)}
      </span>
      <div className="min-w-0">
        <div
          className={cn(
            "font-sans text-[13px] font-bold leading-tight",
            titleClass[intent],
          )}
        >
          {title}
        </div>
        {children && (
          <div className="mt-0.5 text-[12px] leading-[1.55] text-fg-dim">
            {children}
          </div>
        )}
      </div>
      {action && !compact && <div className="justify-self-end">{action}</div>}
    </div>
  );
}
