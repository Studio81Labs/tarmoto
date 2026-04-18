"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Download,
  FileDown,
  Link as LinkIcon,
  Printer,
  Smartphone,
} from "lucide-react";
import type { Trip } from "@/lib/types";
import {
  TRIP_PRINT_STORAGE_KEY,
  buildMobileDeepLink,
  buildTripShareUrl,
  tripFileName,
  tripToGpx,
} from "@/lib/trip-export";

interface TripExportMenuProps {
  trip: Trip | null;
}

type Feedback = { kind: "ok" | "err"; message: string } | null;

/**
 * Export menu for a planned trip (US-39): GPX download, shareable link,
 * mobile deep-link handoff, and a printable summary view.
 *
 * Disabled until a trip is loaded — the four actions all need trip data, and
 * the menu doubles as a visual cue that "Load demo trip" or a generated trip
 * is the next step.
 */
export function TripExportMenu({ trip }: TripExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!feedback) return;
    const id = window.setTimeout(() => setFeedback(null), 2500);
    return () => window.clearTimeout(id);
  }, [feedback]);

  const disabled = !trip;

  function show(kind: "ok" | "err", message: string) {
    setFeedback({ kind, message });
    setOpen(false);
  }

  function handleGpx() {
    if (!trip) return;
    try {
      const xml = tripToGpx(trip);
      const blob = new Blob([xml], { type: "application/gpx+xml" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = tripFileName(trip, "gpx");
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      show("ok", "GPX downloaded");
    } catch {
      show("err", "Could not generate GPX");
    }
  }

  async function handleShareLink() {
    if (!trip) return;
    const url = buildTripShareUrl(trip, window.location.origin);
    try {
      await navigator.clipboard.writeText(url);
      show("ok", "Share link copied");
    } catch {
      show("err", "Copy failed — select the URL manually");
    }
  }

  function handlePushMobile() {
    if (!trip) return;
    // Uses the tarmoto:// scheme so the installed mobile app picks up the
    // intent. If the app isn't installed the browser silently no-ops, so we
    // copy the same link to the clipboard as a fallback the user can paste.
    const deepLink = buildMobileDeepLink(trip);
    window.location.href = deepLink;
    navigator.clipboard?.writeText(deepLink).catch(() => {
      /* clipboard is best-effort */
    });
    show("ok", "Opening in Tarmoto app…");
  }

  function handlePrint() {
    if (!trip) return;
    // The Zustand trip store is tab-local, so the new tab can't read
    // `activeTrip`. sessionStorage would work except `noopener` below severs
    // the creator relationship which skips its copy (HTML spec); localStorage
    // is shared across same-origin tabs, and the print page deletes the key
    // as soon as it hydrates so nothing lingers.
    try {
      localStorage.setItem(TRIP_PRINT_STORAGE_KEY, JSON.stringify(trip));
    } catch {
      /* private mode or storage full — the print page has a demo fallback */
    }
    window.open(
      `/trips/planner/print?trip=${encodeURIComponent(trip.id)}`,
      "_blank",
      "noopener,noreferrer",
    );
    setOpen(false);
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Download size={14} />
        Export
        <ChevronDown size={12} className="opacity-70" />
      </button>

      {open && !disabled && (
        <div
          role="menu"
          className="absolute left-0 mt-2 w-60 rounded-xl border border-slate-800 bg-slate-900 shadow-xl shadow-black/40 z-30 overflow-hidden animate-fade-in"
        >
          <MenuItem
            icon={<FileDown size={14} />}
            label="Download GPX"
            hint="For Garmin, Calimoto, Kurviger…"
            onClick={handleGpx}
          />
          <MenuItem
            icon={<LinkIcon size={14} />}
            label="Copy share link"
            hint="Anyone with the link can view"
            onClick={handleShareLink}
          />
          <MenuItem
            icon={<Smartphone size={14} />}
            label="Push to mobile app"
            hint="Opens in Tarmoto for iOS/Android"
            onClick={handlePushMobile}
          />
          <MenuItem
            icon={<Printer size={14} />}
            label="Print summary"
            hint="Turn list with waypoints"
            onClick={handlePrint}
          />
        </div>
      )}

      {feedback && (
        <div
          role="status"
          aria-live="polite"
          className={`absolute left-0 top-full mt-12 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs whitespace-nowrap z-30 ${
            feedback.kind === "ok"
              ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
              : "bg-red-500/10 text-red-300"
          }`}
        >
          {feedback.kind === "ok" && <Check size={12} />}
          {feedback.message}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm text-slate-200 hover:bg-slate-800 transition"
    >
      <span className="mt-0.5 text-tarmoto-cyan">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="block text-[11px] text-slate-500 truncate">
          {hint}
        </span>
      </span>
    </button>
  );
}
