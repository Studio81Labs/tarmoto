"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "@/lib/toast";
import type { Trip } from "@/lib/types";
import { tripFileName, tripToGpx } from "@/lib/trip-export";
import { Button, Tooltip } from "@tarmoto/ui";
import { useFeature, useEntitlements } from "@/hooks";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
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
  const t = useTranslation();
  const {
    enabled: gpxEnabled,
    isError: gpxError,
    isSuccess: gpxResolved,
  } = useFeature("gpx_export");
  const { tier, refetch: refetchEntitlements } = useEntitlements();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  // Disabled until a trip loads AND the entitlement snapshot is either RESOLVED
  // (isSuccess) or ERRORED. NOT merely "not loading": in the pre-auth window the
  // /users/me query is disabled (isLoading false, isSuccess false), and we can't
  // yet tell a Pro rider (export) from a free one (upgrade). On a genuine lookup
  // ERROR the button stays clickable — but the click RETRIES rather than
  // exporting (see below), so a paid rider isn't stranded while a Free rider
  // still can't slip through.
  const disabled = !trip || (!gpxResolved && !gpxError);
  function handleGpx() {
    // This GPX is generated ENTIRELY in the browser — there is no server to
    // enforce `gpx_export` on. So never export without a CONFIRMED entitlement:
    // on a lookup error, surface the failure and retry instead of failing open.
    if (gpxError) {
      toast.error(t("Couldn't verify your plan. Please try again."));
      refetchEntitlements();
      return;
    }
    // Only steer to the upgrade modal once we've RESOLVED that the rider isn't
    // entitled.
    if (gpxResolved && !gpxEnabled) {
      setUpgradeOpen(true);
      return;
    }
    if (!trip) return;
    try {
      const xml = tripToGpx(trip, new Date(), t);
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
    <>
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
      {upgradeOpen && tier ? (
        <UpgradePrompt
          variant="modal"
          capability={{ feature: "gpx_export" }}
          currentTier={tier}
          message={t("GPX export is a Pro feature.")}
          onClose={() => setUpgradeOpen(false)}
        />
      ) : null}
    </>
  );
}
