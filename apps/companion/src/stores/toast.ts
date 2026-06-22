import { create } from "zustand";
import type { ReactNode } from "react";
import type { ToastIntent } from "@tarmoto/ui";

/**
 * Global toast queue. Components fire toasts through the `toast` helper
 * (`@/lib/toast`); the single `<ToastHost />` mounted in `AppProviders`
 * subscribes here and renders them. A store (not React context) keeps the
 * API callable from anywhere — event handlers, `catch` blocks, non-render
 * code — without threading a provider through every consumer.
 */
export interface ToastRecord {
  id: string;
  intent: ToastIntent;
  title: ReactNode;
  description?: ReactNode;
  /** Auto-dismiss delay in ms; `null` keeps the toast until dismissed. */
  durationMs: number | null;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastState {
  toasts: ToastRecord[];
  add: (toast: Omit<ToastRecord, "id">) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

/** Cap the visible stack so a burst of failures can't bury the screen. */
const MAX_TOASTS = 4;

let counter = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (toast) => {
    counter += 1;
    const id = `toast-${counter}`;
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id }].slice(-MAX_TOASTS),
    }));
    return id;
  },
  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  dismissAll: () => set({ toasts: [] }),
}));
