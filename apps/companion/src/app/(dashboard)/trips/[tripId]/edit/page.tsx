"use client";
import { t } from "@/i18n";
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
/**
 * Edit handoff: reuses the existing planner UI in "live trip" mode by
 * routing to `/trips/planner?tripId=<id>`. The planner already wires the
 * collab session, owner detection, and persisted parameters when this
 * query param is present (see `apps/companion/src/app/(dashboard)/trips/
 * planner/page.tsx`'s `serverTripId` flow).
 */
export default function TripEditRedirectPage() {
  const { tripId } = useParams<{
    tripId: string;
  }>();
  const router = useRouter();
  useEffect(() => {
    if (!tripId) return;
    router.replace(`/trips/planner?tripId=${encodeURIComponent(tripId)}`);
  }, [tripId, router]);
  return (
    <div className="flex h-full items-center justify-center text-fg-dim">
      <Loader2 size={20} className="mr-2 animate-spin" />
      {t("Opening planner\u2026 ")}
    </div>
  );
}
