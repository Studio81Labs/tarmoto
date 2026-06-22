"use client";

import { useEffect } from "react";
import { Toast } from "@tarmoto/ui";
import { useToastStore, type ToastRecord } from "@/stores/toast";

/**
 * Single mount point for the global toast queue (rendered in `AppProviders`).
 * Stacks toasts top-right on desktop, full-width along the top on mobile. The
 * container is click-through (`pointer-events-none`) so it never blocks the UI
 * behind it; individual toasts re-enable pointer events.
 */
export function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-3 top-3 z-[100] flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:top-4 sm:w-[360px]">
      {toasts.map((record) => (
        <ToastItem
          key={record.id}
          record={record}
          onDismiss={() => dismiss(record.id)}
        />
      ))}
    </div>
  );
}

function ToastItem({
  record,
  onDismiss,
}: {
  record: ToastRecord;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (record.durationMs == null) return;
    const timer = window.setTimeout(onDismiss, record.durationMs);
    return () => window.clearTimeout(timer);
    // Re-arm only when the toast identity changes; onDismiss is stable per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id, record.durationMs]);

  return (
    <div className="animate-slide-in-right pointer-events-auto">
      <Toast
        intent={record.intent}
        title={record.title}
        actionLabel={record.actionLabel}
        onAction={
          record.onAction
            ? () => {
                record.onAction?.();
                onDismiss();
              }
            : undefined
        }
        onClose={onDismiss}
        showProgress={record.durationMs != null}
      >
        {record.description}
      </Toast>
    </div>
  );
}
