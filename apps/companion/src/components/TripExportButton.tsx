"use client";
import { t } from "@/i18n";
import { Download } from "lucide-react";
import { toast } from "@/lib/toast";
import type { Trip } from "@/lib/types";
import { tripFileName, tripToGpx } from "@/lib/trip-export";
import { Button, Tooltip } from "@tarmoto/ui";
interface TripExportButtonProps {
  trip: Trip | null;
}
/**
 * One-click GPX export for a planned trip (US-39). Share links and the
 * mobile handoff live in the collaborate dialog — the header button does
 * exactly one thing: download the route as GPX.
 *
 * Disabled until a trip is loaded — the export needs trip data, and the
 * disabled state doubles as a cue that loading/generating a trip comes
 * first.
 */
export function TripExportButton({ trip }: TripExportButtonProps) {
  const disabled = !trip;
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
      toast.success(t("GPX downloaded"));
    } catch {
      toast.error(t("Could not generate GPX"));
    }
  }
  return (
    <Tooltip content={t("Export GPX")} placement="below">
      <Button
        iconOnly
        variant="secondary"
        size="sm"
        onClick={handleGpx}
        disabled={disabled}
        aria-label={t("Export GPX")}
      >
        <Download size={15} />
      </Button>
    </Tooltip>
  );
}
