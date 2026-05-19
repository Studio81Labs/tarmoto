import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Toast · transient feedback. Spec: §20.
 * Use for *transient* feedback — anything persistent is an Alert.
 *
 * This is a presentational toast; pair with your own headless host
 * (e.g. `sonner`, custom queue) for stacking + auto-dismiss timing.
 * Set `showProgress` to render the auto-dismiss bar (4 s animation).
 */
export type ToastIntent = "info" | "success" | "warning" | "danger";

const progressClass: Record<ToastIntent, string> = {
  info: "bg-ink",
  success: "bg-quality-q5",
  warning: "bg-accent",
  danger: "bg-quality-q1",
};

const glyphClass: Record<ToastIntent, string> = {
  info: "text-ink",
  success: "text-[#2E8B4F]",
  warning: "text-accent",
  danger: "text-quality-q1",
};

function defaultGlyph(intent: ToastIntent): ReactNode {
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
          <path d="M 8 6 L 8 10" stroke="currentColor" strokeWidth={1.5} />
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
          <path d="M 8 7 L 8 12" stroke="currentColor" strokeWidth={1.5} />
        </svg>
      );
  }
}

export interface ToastProps {
  intent?: ToastIntent;
  title: ReactNode;
  children?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
  /** Renders the 4 s progress bar. */
  showProgress?: boolean;
  glyph?: ReactNode;
  className?: string;
}

export function Toast({
  intent = "info",
  title,
  children,
  actionLabel,
  onAction,
  onClose,
  showProgress = false,
  glyph,
  className,
}: ToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "relative grid items-center gap-3 overflow-hidden rounded-[10px] border border-line-strong bg-cream px-3.5 py-3",
        "font-sans text-ink shadow-[0_12px_32px_rgba(14,14,16,0.12)]",
        actionLabel && onClose
          ? "grid-cols-[24px_1fr_auto_auto]"
          : actionLabel || onClose
            ? "grid-cols-[24px_1fr_auto]"
            : "grid-cols-[24px_1fr]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("grid size-6 place-items-center", glyphClass[intent])}
      >
        {glyph ?? defaultGlyph(intent)}
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-bold">{title}</div>
        {children && (
          <div className="mt-0.5 text-[12px] leading-[1.5] text-fg-dim">
            {children}
          </div>
        )}
      </div>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[11px] font-bold tracking-[0.4px] text-ink underline underline-offset-[3px]"
        >
          {actionLabel}
        </button>
      )}
      {onClose && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onClose}
          className="cursor-pointer border-0 bg-transparent px-1 text-[18px] leading-none text-fg-mute hover:text-ink"
        >
          ×
        </button>
      )}
      {showProgress && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute bottom-0 left-0 h-0.5 w-full origin-left",
            progressClass[intent],
          )}
          style={{
            animation: "tm-toast-progress 4s linear forwards",
          }}
        />
      )}
      <style>{`@keyframes tm-toast-progress { to { transform: scaleX(0); } }`}</style>
    </div>
  );
}
