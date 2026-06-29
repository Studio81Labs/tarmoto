import { useEffect, type ReactNode } from "react";

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Footer action row (right-aligned), e.g. Cancel + a commit button. */
  footer?: ReactNode;
  /** While true, Escape / overlay-click / close-button are disabled (submit in flight). */
  busy?: boolean;
  size?: "sm" | "md";
}

/**
 * Admin modal dialog — overlay + centered cream card, Escape and
 * click-outside to dismiss. Mirrors the companion's modal chrome
 * (`bg-ink/40` scrim, rounded card, ink/cream palette) so the admin app
 * shares the same dialog language. `@tarmoto/ui` has no Dialog primitive
 * yet; this is the admin-local equivalent.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  busy = false,
  size = "md",
}: DialogProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        className={[
          "w-full rounded-2xl border border-line bg-cream shadow-[0_24px_60px_rgba(14,14,16,0.2)]",
          size === "sm" ? "max-w-sm" : "max-w-md",
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2 className="text-base font-extrabold text-ink">{title}</h2>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            aria-label="Close"
            disabled={busy}
            className="-mr-1 text-[22px] leading-none text-ink/40 transition hover:text-ink disabled:opacity-40"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
