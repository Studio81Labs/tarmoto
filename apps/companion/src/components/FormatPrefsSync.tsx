"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { canonicalizeFormatLocale, isValidTimeZone } from "@tarmoto/shared";
import { FORMAT_LOCALE_COOKIE, TIMEZONE_COOKIE } from "@/format";

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
 * so server components re-render with the new cookies. Steady state (and
 * every mount after the first sync) is a pure no-op: no POST, no refresh.
 * Headless: renders nothing.
 */
export function FormatPrefsSync() {
  const router = useRouter();
  const ran = useRef(false);

  useEffect(() => {
    // Guard against strict-mode double-mount firing two POSTs.
    if (ran.current) return;
    ran.current = true;

    const detectedLocale = canonicalizeFormatLocale(navigator.language);
    const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeZone = isValidTimeZone(detectedZone) ? detectedZone : null;
    // An exotic environment that reports neither is left on the
    // Accept-Language/UTC server fallbacks — nothing useful to persist.
    if (!detectedLocale || !timeZone) return;

    if (
      readCookie(FORMAT_LOCALE_COOKIE) === detectedLocale &&
      readCookie(TIMEZONE_COOKIE) === timeZone
    ) {
      return;
    }

    void fetch("/api/format-prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format_locale: detectedLocale,
        timezone: timeZone,
      }),
    })
      .then((response) => {
        if (response.ok) {
          router.refresh();
        } else {
          console.error("Failed to sync format preferences", response.status);
        }
      })
      .catch((error) => {
        console.error("Failed to sync format preferences", error);
      });
  }, [router]);

  return null;
}
