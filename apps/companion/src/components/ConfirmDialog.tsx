"use client";
import { t } from "@/i18n";
import type { ReactNode } from "react";
import { Button } from "@tarmoto/ui";

/**
 * App-styled confirmation dialog — system dialogs (window.confirm/alert/
 * prompt) are disallowed: they block the whole tab, ignore the design
 * system, and can't be tested or translated. Every destructive or
 * irreversible action confirms through this instead.
 */
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  /** Optional extra content under the message (e.g. a copyable link). */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' renders the destructive filled commit (danger-solid). */
  tone?: "default" | "danger";
  /** Hide the cancel action (informational dialogs with one way out). */
  hideCancel?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  children,
  confirmLabel,
  cancelLabel,
  tone = "default",
  hideCancel = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-sm rounded-[14px] border border-line-strong bg-cream p-5 shadow-[0_18px_48px_rgba(14,14,16,0.3)]">
        <h2 className="font-sans text-[17px] font-extrabold tracking-[-0.3px] text-ink">
          {title}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-dim">
          {message}
        </p>
        {children ? <div className="mt-3">{children}</div> : null}
        <div className="mt-5 flex gap-2">
          {!hideCancel ? (
            <Button
              variant="secondary"
              size="md"
              block
              disabled={busy}
              onClick={onCancel}
            >
              {cancelLabel ?? t("Cancel")}
            </Button>
          ) : null}
          <Button
            variant={tone === "danger" ? "danger-solid" : "primary"}
            size="md"
            block
            loading={busy}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel ?? t("Confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}
