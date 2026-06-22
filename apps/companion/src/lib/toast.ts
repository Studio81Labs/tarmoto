import type { ReactNode } from "react";
import type { ToastIntent } from "@tarmoto/ui";
import { useToastStore } from "@/stores/toast";

/**
 * Ergonomic, sonner-style toast API. Import `{ toast }` anywhere and call
 * `toast.success("Saved")` / `toast.error("Couldn't save", { description })`.
 * Backed by `useToastStore`; rendered by the single `<ToastHost />`.
 *
 * Use toasts for *transient* action feedback (a button click succeeded or
 * failed). Errors bound to a form field, a modal, or a page's load state
 * should stay inline so they persist in context — see the notification audit.
 */
export interface ToastOptions {
  description?: ReactNode;
  /** Override the auto-dismiss delay; `null` keeps it until dismissed. */
  durationMs?: number | null;
  actionLabel?: string;
  onAction?: () => void;
}

/** Matches the `Toast` progress-bar animation so the bar empties on dismiss. */
const DEFAULT_DURATION_MS = 4000;

function show(intent: ToastIntent, title: ReactNode, opts: ToastOptions = {}) {
  return useToastStore.getState().add({
    intent,
    title,
    description: opts.description,
    durationMs:
      opts.durationMs === undefined ? DEFAULT_DURATION_MS : opts.durationMs,
    actionLabel: opts.actionLabel,
    onAction: opts.onAction,
  });
}

export const toast = {
  info: (title: ReactNode, opts?: ToastOptions) => show("info", title, opts),
  success: (title: ReactNode, opts?: ToastOptions) =>
    show("success", title, opts),
  warning: (title: ReactNode, opts?: ToastOptions) =>
    show("warning", title, opts),
  /** Danger intent. */
  error: (title: ReactNode, opts?: ToastOptions) => show("danger", title, opts),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
  dismissAll: () => useToastStore.getState().dismissAll(),
};
