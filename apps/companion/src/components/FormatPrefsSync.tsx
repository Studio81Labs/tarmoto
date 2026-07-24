"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { canonicalizeFormatLocale, isValidTimeZone } from "@tarmoto/shared";
import { FORMAT_LOCALE_COOKIE, TIMEZONE_COOKIE } from "@/format";

const SYNC_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000] as const;

function readCookie(name: string): string | null {
  const match = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${name}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    // A hand-tampered cookie value (e.g. a lone "%" or an invalid escape
    // sequence) throws URIError inside decodeURIComponent — treat it the
    // same as a missing cookie rather than crashing the effect.
    return null;
  }
}

/**
 * Follow-the-device autodetection (spec decision #2): compares the device's
 * regional format locale + IANA timezone against the format-prefs cookies
 * and, on divergence, POSTs /api/format-prefs — which sets the cookies and
 * best-effort mirrors the values to the user record — then refreshes once
 * so server components re-render with the new cookies. Re-checks when the tab
 * becomes visible/focused and retries transient failures with capped backoff.
 * Matching cookies remain a pure no-op: no POST, no refresh. Headless: renders
 * nothing.
 */
export function FormatPrefsSync() {
  const router = useRouter();
  const ran = useRef(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const rerunRequested = useRef(false);
  const retryIndex = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;

    const clearRetry = () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };

    const scheduleRetry = (sync: () => Promise<void>) => {
      if (!mounted.current || retryTimer.current) return;
      const delay =
        SYNC_RETRY_DELAYS_MS[
          Math.min(retryIndex.current, SYNC_RETRY_DELAYS_MS.length - 1)
        ];
      retryIndex.current += 1;
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null;
        void sync();
      }, delay);
    };

    const sync = async (): Promise<void> => {
      if (inFlight.current) {
        // A device change can arrive while the previous snapshot is being
        // persisted. Queue one re-read instead of dropping the focus event.
        rerunRequested.current = true;
        return;
      }
      // Focus/visibility events must respect a scheduled retry. The timer
      // clears itself before calling sync().
      if (retryTimer.current) return;

      const detectedLocale = canonicalizeFormatLocale(navigator.language);
      const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const timeZone = isValidTimeZone(detectedZone) ? detectedZone : null;
      const patch: { format_locale?: string; timezone?: string } = {};
      if (
        detectedLocale &&
        readCookie(FORMAT_LOCALE_COOKIE) !== detectedLocale
      ) {
        patch.format_locale = detectedLocale;
      }
      if (timeZone && readCookie(TIMEZONE_COOKIE) !== timeZone) {
        patch.timezone = timeZone;
      }

      // Environments that expose only one preference still persist the useful
      // half. If neither changed, there is no work to retry.
      if (Object.keys(patch).length === 0) {
        retryIndex.current = 0;
        clearRetry();
        return;
      }

      inFlight.current = true;
      try {
        const response = await fetch("/api/format-prefs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) {
          console.error("Failed to sync format preferences", response.status);
          scheduleRetry(sync);
          return;
        }
        retryIndex.current = 0;
        clearRetry();
        if (mounted.current) router.refresh();
      } catch (error) {
        console.error("Failed to sync format preferences", error);
        scheduleRetry(sync);
      } finally {
        inFlight.current = false;
        if (rerunRequested.current && mounted.current) {
          rerunRequested.current = false;
          void sync();
        }
      }
    };

    // Guard the initial request against strict-mode's effect replay while still
    // installing fresh foreground listeners on the replayed effect.
    if (!ran.current) {
      ran.current = true;
      void sync();
    }

    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    const syncOnFocus = () => void sync();
    document.addEventListener("visibilitychange", syncWhenVisible);
    window.addEventListener("focus", syncOnFocus);

    return () => {
      mounted.current = false;
      clearRetry();
      document.removeEventListener("visibilitychange", syncWhenVisible);
      window.removeEventListener("focus", syncOnFocus);
    };
  }, [router]);

  return null;
}
