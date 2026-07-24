"use client";

import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { canonicalizeFormatLocale, isValidTimeZone } from "@tarmoto/shared";
import { getStoredUnitSystem, usePreferencesStore } from "@/stores/preferences";
import { isSupportedLocale, LOCALE_COOKIE, type SupportedLocale } from "@/i18n";
import { usersApi, type UpdateProfileInput } from "@/lib/api/users";

function readLocaleCookie(): SupportedLocale | undefined {
  const prefix = `${LOCALE_COOKIE}=`;
  const raw = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  if (!raw) return undefined;
  try {
    const locale = decodeURIComponent(raw);
    return isSupportedLocale(locale) ? locale : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hydrates the unit preference and reconciles display preferences with the
 * account record.
 *
 * Local hydrate runs first (fast paint with the device's last choice).
 * Once the session is authenticated, one `/me` read reconciles in both
 * directions:
 *  - units: the account value wins when present (cross-device source of
 *    truth); a rider with only a pre-account localStorage value gets it
 *    backfilled once, so an expressed preference never silently stays
 *    device-local (spec decision #4).
 *  - format_locale / timezone: the RECORD follows the device (spec
 *    decision #2). This must live here, against `/me`, not only in
 *    FormatPrefsSync's cookie comparison — cookies set while logged out
 *    make that comparison a no-op after login, and the record would never
 *    be prefilled at all.
 * Headless: renders nothing.
 */
export function PreferencesSync() {
  const { status } = useSession();
  const hydrate = usePreferencesStore((s) => s.hydrate);
  const setUnitSystem = usePreferencesStore((s) => s.setUnitSystem);
  // Guards the reconciliation effect below against React strict-mode
  // double-invoke and repeat "authenticated" passes (session refresh
  // re-renders) firing a second /me GET+PATCH cycle. Must NOT latch on a
  // pre-auth pass — only set once the effect actually runs the
  // reconciliation, so an eventual authenticated pass still fires.
  const ran = useRef(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (status !== "authenticated" || ran.current) return;
    ran.current = true;
    // No unmount-cancellation guard here on purpose: `ran` already ensures
    // this async work only ever starts once per mounted instance, so a
    // `cancelled` flag set by strict-mode's simulated-unmount cleanup would
    // make the sole in-flight request bail before the (unmount-safe)
    // zustand store update / network PATCH ever runs — silently dropping
    // the reconciliation in dev. Same pattern as FormatPrefsSync.
    void (async () => {
      try {
        // Snapshot the explicit local choice BEFORE the read: if it changes
        // while /me is in flight, the rider toggled units mid-read and the
        // account value below is stale — applying it would revert their
        // just-made choice (with `ran` latched, nothing in-session would
        // heal the revert) while the toggle's own PATCH puts the account on
        // the new value anyway. Format prefs are device-derived and
        // unaffected by the race.
        const storedBefore = getStoredUnitSystem();
        const { data: me } = await usersApi.getMe();

        const prefsPatch: {
          units?: "metric" | "imperial";
          format_locale?: string;
          timezone?: string;
        } = {};

        const accountUnits = me.preferences?.units;
        const stored = getStoredUnitSystem();
        if (stored === storedBefore) {
          if (accountUnits === "metric" || accountUnits === "imperial") {
            if (accountUnits !== stored) setUnitSystem(accountUnits);
          } else if (stored) {
            prefsPatch.units = stored;
          }
        }

        const deviceLocale = canonicalizeFormatLocale(navigator.language);
        if (deviceLocale && me.preferences?.format_locale !== deviceLocale) {
          prefsPatch.format_locale = deviceLocale;
        }
        const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (
          isValidTimeZone(deviceZone) &&
          me.preferences?.timezone !== deviceZone
        ) {
          prefsPatch.timezone = deviceZone;
        }

        const update: UpdateProfileInput = {};
        if (Object.keys(prefsPatch).length > 0) {
          update.preferences = prefsPatch;
        }

        // `/api/locale` intentionally returns after a bounded best-effort
        // account PATCH. Its durable cookie is therefore also a retry marker:
        // every authenticated mount compares it with `/me`, and retries until
        // backend/mobile/email language state converges.
        const cookieLocale = readLocaleCookie();
        if (cookieLocale && me.language !== cookieLocale) {
          update.language = cookieLocale;
        }

        if (Object.keys(update).length > 0) {
          await usersApi.updateMe(update);
        }
      } catch (error) {
        console.error("Failed to sync display preferences with account", error);
      }
    })();
  }, [status, setUnitSystem]);

  return null;
}
