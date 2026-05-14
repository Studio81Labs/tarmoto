"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { useRealtimeStore } from "@/stores/realtime";
/**
 * Compact badge surfaced in the Topbar when the browser is offline or the
 * realtime socket is reconnecting. Browser offline wins because the whole app
 * is cache-only; realtime reconnect is a narrower live-update signal.
 */
const GRACE_PERIOD_MS = 1500;
export function OfflineIndicator() {
  const status = useRealtimeStore((s) => s.status);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [showOffline, setShowOffline] = useState(false);

  useEffect(() => {
    const onOffline = () => {
      setIsOnline(false);
      setShowOffline(true);
    };
    const onOnline = () => {
      setIsOnline(true);
      setShowOffline(false);
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => {
    if (!isOnline) {
      setShowOffline(true);
      return;
    }
    if (status === "connected") {
      setShowOffline(false);
      return;
    }
    const timer = window.setTimeout(
      () => setShowOffline(true),
      GRACE_PERIOD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [isOnline, status]);
  if (!showOffline || (isOnline && status === "connected")) return null;
  const label = !isOnline
    ? "Offline"
    : status === "connecting"
      ? "Reconnecting…"
      : "Realtime paused";
  const title = !isOnline
    ? "Browser is offline; cached map tiles and data may be shown"
    : "Real-time updates are reconnecting";
  return (
    <div
      role="status"
      aria-live="polite"
      title={t(title)}
      className="flex items-center gap-1.5 rounded-full border border-accent/50 bg-accent/15 px-2.5 py-1 text-[11px] font-bold text-ink"
    >
      <WifiOff size={12} />
      <span>{label}</span>
    </div>
  );
}
