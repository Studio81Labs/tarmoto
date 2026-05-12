"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { useRealtimeStore } from "@/stores/realtime";
/**
 * Compact badge surfaced in the Topbar when the realtime socket is not
 * currently connected. Fades in after a short grace period so the normal
 * connect-on-load flicker isn't visible to users. Hidden entirely while
 * connected (no "you are online" reassurance).
 */
const GRACE_PERIOD_MS = 1500;
export function OfflineIndicator() {
  const status = useRealtimeStore((s) => s.status);
  const [showOffline, setShowOffline] = useState(false);
  useEffect(() => {
    if (status === "connected") {
      setShowOffline(false);
      return;
    }
    const timer = window.setTimeout(
      () => setShowOffline(true),
      GRACE_PERIOD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [status]);
  if (!showOffline || status === "connected") return null;
  const label = status === "connecting" ? "Reconnecting…" : "Offline";
  return (
    <div
      role="status"
      aria-live="polite"
      title={t("Real-time updates are paused")}
      className="flex items-center gap-1.5 rounded-full border border-accent/50 bg-accent/15 px-2.5 py-1 text-[11px] font-bold text-ink"
    >
      <WifiOff size={12} />
      <span>{label}</span>
    </div>
  );
}
