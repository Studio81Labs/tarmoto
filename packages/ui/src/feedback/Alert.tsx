import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Alert · persistent in-layout notification. Spec: §18.
 * Five intents share one anatomy: stripe + glyph + title + body + optional action.
 * Cap visible stack at 3 — collapse the rest behind a "+ N more" pill.
 */
export type AlertIntent = "info" | "success" | "warning" | "danger" | "neutral";

// Container/stripe/glyph palettes match the source `.alert.alert-*`
// intent rules — see the "Intent → tokens" table in §18:
//   success: stripe --q5, glyph --q5, bg Q5 @ 12 %
//   warning: stripe --accent, glyph --accent, bg accent @ 10 %
//   danger:  stripe --q1, glyph --q1, bg Q1 @ 10 %, title --q1
//   neutral: stripe --fg-mute, glyph --fg-dim, bg --paper-2
//   info:    stripe --ink, glyph --ink, bg --paper
const containerClass: Record<AlertIntent, string> = {
  info: "bg-paper border-line",
  success: "bg-quality-q5/12 border-quality-q5/40",
  warning: "bg-accent/10 border-accent/35",
  danger: "bg-quality-q1/10 border-quality-q1/40",
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
  success: "text-quality-q5",
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

// Glyph size: 14×14 inside the full alert's 24×24 slot, 12×12 inside the
// compact alert's 18×18 slot. Compact glyphs drop the inner detail (no
// exclamation mark inside the warning triangle, no `i` stroke inside the
// info circle) so the smaller outline stays legible — this matches the
// source `alert-compact` rendering.
function defaultGlyph(intent: AlertIntent, compact = false): ReactNode {
  const size = compact ? 12 : 14;
  switch (intent) {
    case "success":
      return (
        <svg viewBox="0 0 16 16" width={size} height={size}>
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
        <svg viewBox="0 0 16 16" width={size} height={size}>
          <path
            d="M 8 1 L 15 14 L 1 14 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          {!compact && (
            <>
              <path
                d="M 8 6 L 8 10"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
              <circle cx="8" cy="12" r="0.8" fill="currentColor" />
            </>
          )}
        </svg>
      );
    case "danger":
      return (
        <svg viewBox="0 0 16 16" width={size} height={size}>
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
        <svg viewBox="0 0 16 16" width={size} height={size}>
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
        <svg viewBox="0 0 16 16" width={size} height={size}>
          <circle
            cx="8"
            cy="8"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          />
          {!compact && (
            <>
              <circle cx="8" cy="4.5" r="1" fill="currentColor" />
              <path
                d="M 8 7 L 8 12"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            </>
          )}
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
  if (compact) {
    // Compact alerts are an inline single-line variant: bold title runs
    // INLINE with the body (no separate title/body blocks), 12 px font,
    // 12 px glyph, no fg-dim treatment on body. Matches the source
    // `alert.alert-compact` rendering used inside cards (§18 inline alert).
    return (
      <div
        role="status"
        className={cn(
          // Compact mode has no left stripe — the source markup renders just
          // glyph + inline text inside a tinted card. The stripe is reserved
          // for the full-anatomy alert that stands on its own.
          "flex items-center gap-2 rounded-lg border px-3 py-2.5",
          containerClass[intent],
          className,
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "grid size-3 shrink-0 place-items-center",
            glyphClass[intent],
          )}
        >
          {glyph ?? defaultGlyph(intent, true)}
        </span>
        <div className={cn("text-[12px] leading-[1.5]", titleClass[intent])}>
          <strong className="font-bold">{title}</strong>
          {children && <> {children}</>}
        </div>
      </div>
    );
  }
  return (
    <div
      role="status"
      className={cn(
        "relative grid items-center gap-3 border rounded-[12px] py-3.5 pl-[26px] pr-[18px]",
        action ? "grid-cols-[24px_1fr_auto]" : "grid-cols-[24px_1fr]",
        containerClass[intent],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-2 top-2 bottom-2 w-1 rounded-[2px]",
          stripeClass[intent],
        )}
      />
      <span
        aria-hidden="true"
        className={cn("grid size-6 place-items-center", glyphClass[intent])}
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
      {action && <div className="justify-self-end">{action}</div>}
    </div>
  );
}
