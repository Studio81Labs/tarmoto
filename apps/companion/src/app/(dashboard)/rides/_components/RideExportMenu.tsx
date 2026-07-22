"use client";
import { getUserFacingErrorMessage, t } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@tarmoto/ui";
import { toast } from "@/lib/toast";
import type { RideExportFormat } from "@/lib/ride-export";

/**
 * "Export" trigger + CSV/GPX dropdown, shared by the All-rides header
 * (bulk export of the filtered set) and the ride-detail header (one ride).
 * The caller supplies `onExport`; the menu owns its open / busy state and
 * outside-click dismissal, and surfaces failures via a toast.
 */
export function RideExportMenu({
  onExport,
}: {
  onExport: (format: RideExportFormat) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<RideExportFormat | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent) {
      if (!containerRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function handleExport(format: RideExportFormat) {
    if (busy) return;
    setBusy(format);
    try {
      await onExport(format);
      setOpen(false);
    } catch (err) {
      toast.error(t("Export failed"), {
        description: getUserFacingErrorMessage(
          err,
          t("Export failed. Please try again."),
        ),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <Button
        variant="primary"
        uppercase
        onClick={() => setOpen((o) => !o)}
        loading={busy !== null}
        leftIcon={<ArrowUpRight size={14} />}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {t("Export")}
      </Button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 w-44 overflow-hidden rounded-lg border border-line bg-cream shadow-[0_12px_32px_rgba(14,14,16,0.14)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("csv")}
            disabled={busy !== null}
            className="w-full px-3 py-2 text-left text-sm text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("CSV (stats) ")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("gpx")}
            disabled={busy !== null}
            className="w-full border-t border-line px-3 py-2 text-left text-sm text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("GPX (tracks) ")}
          </button>
        </div>
      )}
    </div>
  );
}
