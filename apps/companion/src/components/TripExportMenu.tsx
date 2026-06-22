"use client";
import { t } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Download,
  FileDown,
  FileText,
  Link as LinkIcon,
  Loader2,
  Printer,
  Smartphone,
} from "lucide-react";
import { ApiError, tripSharesApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { Trip } from "@/lib/types";
import {
  TRIP_PRINT_STORAGE_KEY,
  buildMobileDeepLink,
  buildTripShareUrl,
  tripFileName,
  tripToGpx,
} from "@/lib/trip-export";
import { Button } from "@tarmoto/ui";
interface TripExportMenuProps {
  trip: Trip | null;
  /**
   * Whether this menu is rendered next to a backend-persisted trip
   * ("saved-trip", default) or against the in-memory planner draft
   * ("planner"). Drives the PDF download route: `saved-trip` opens the
   * per-id print page so members/region come from the API, `planner`
   * opens the local-snapshot print page.
   *
   * Avoid status-based heuristics here — a backend-persisted trip can
   * legitimately be in `draft` status (created but not yet route-
   * generated), so guessing from `trip.status` would silently route
   * those trips to the planner print path and drop API-only fields.
   */
  context?: "saved-trip" | "planner";
}
/**
 * Export menu for a planned trip (US-39): GPX download, shareable link,
 * mobile deep-link handoff with token, printable summary, and a one-click
 * PDF download (browser print-to-PDF on a print-only page).
 *
 * Disabled until a trip is loaded — the actions all need trip data, and the
 * menu doubles as a visual cue that "Load demo trip" or a generated trip is
 * the next step.
 */
export function TripExportMenu({
  trip,
  context = "saved-trip",
}: TripExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [pushPending, setPushPending] = useState(false);
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
  const disabled = !trip;
  function show(kind: "ok" | "err", message: string) {
    if (kind === "ok") toast.success(message);
    else toast.error(message);
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
  async function handlePushMobile() {
    if (!trip || pushPending) return;
    setPushPending(true);
    try {
      // Mint a fresh share token for every push so revoking one device
      // doesn't kill another rider's import. The mobile app fetches the
      // snapshot via `GET /trip-shares/:token` (no auth) and copies the
      // trip into the rider's library.
      const { data } = await tripSharesApi.create({
        title: trip.name || "Untitled trip",
        snapshot: trip as unknown as Record<string, unknown>,
      });
      const deepLink = buildMobileDeepLink(trip.id, data.share_token);
      // Browser silently no-ops if the app isn't installed; copying the
      // link to the clipboard gives the rider something to paste manually
      // as a fallback.
      window.location.href = deepLink;
      navigator.clipboard?.writeText(deepLink).catch(() => {
        /* clipboard is best-effort */
      });
      show("ok", "Opening in Tarmoto app…");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? "Couldn't prepare the handoff — try again in a moment"
          : "Couldn't prepare the handoff — check your connection";
      show("err", message);
    } finally {
      setPushPending(false);
    }
  }
  /**
   * Open the print page for `trip`, optionally with the `autoprint` flag
   * that lets the page trigger `window.print()` after hydration.
   *
   * Routes by the explicit `context` prop, not by inspecting `trip.status`:
   * a backend-persisted trip can legitimately be in `draft` status (created
   * but not yet route-generated), so a status check would silently send it
   * down the planner-print path and drop the members/region the per-id
   * print page fetches from the API.
   *
   * Planner-context trips need the local snapshot stashed in localStorage
   * because `window.open(..., "noopener")` severs the creator
   * relationship and the new tab starts with an empty Zustand store.
   * `sessionStorage` would be the natural fit but the HTML spec skips its
   * copy when `noopener` severs the creator link; localStorage is shared
   * across same-origin tabs so the hand-off works regardless. The print
   * page clears the key as soon as it hydrates.
   */
  function openPrintPage(autoprint: boolean) {
    if (!trip) return;
    if (context === "planner") {
      try {
        localStorage.setItem(TRIP_PRINT_STORAGE_KEY, JSON.stringify(trip));
      } catch {
        /* private mode or storage full — the print page falls back to demo */
      }
    }
    const flag = autoprint ? "autoprint=1" : "";
    const url =
      context === "saved-trip"
        ? `/trips/${encodeURIComponent(trip.id)}/print${flag ? `?${flag}` : ""}`
        : `/trips/planner/print?trip=${encodeURIComponent(trip.id)}${flag ? `&${flag}` : ""}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setOpen(false);
  }
  function handlePrint() {
    openPrintPage(false);
  }
  function handlePdf() {
    openPrintPage(true);
  }
  return (
    <div className="relative" ref={menuRef}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        leftIcon={<Download size={14} />}
        rightIcon={<ChevronDown size={12} className="opacity-70" />}
      >
        {t("Export ")}
      </Button>

      {open && !disabled && (
        <div
          role="menu"
          className="animate-fade-in absolute left-0 z-30 mt-2 w-60 overflow-hidden rounded-xl border border-line-strong bg-cream shadow-[0_12px_32px_rgba(14,14,16,0.16)]"
        >
          <MenuItem
            icon={<FileDown size={14} />}
            label="Download GPX"
            hint="For Garmin, Calimoto, Kurviger…"
            onClick={handleGpx}
          />
          <MenuItem
            icon={<FileText size={14} />}
            label="Download PDF"
            hint="Printable trip plan, A4/Letter"
            onClick={handlePdf}
          />
          <MenuItem
            icon={<LinkIcon size={14} />}
            label="Copy share link"
            hint="Anyone with the link can view"
            onClick={handleShareLink}
          />
          <MenuItem
            icon={
              pushPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Smartphone size={14} />
              )
            }
            label="Push to mobile app"
            hint={
              pushPending
                ? "Preparing handoff…"
                : "Opens in Tarmoto for iOS/Android"
            }
            onClick={() => void handlePushMobile()}
            disabled={pushPending}
          />
          <MenuItem
            icon={<Printer size={14} />}
            label="Print summary"
            hint="Turn list with waypoints"
            onClick={handlePrint}
          />
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
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="mt-0.5 text-accent">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="block truncate text-[11px] text-fg-dim">{hint}</span>
      </span>
    </button>
  );
}
