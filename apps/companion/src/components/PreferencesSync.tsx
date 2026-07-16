"use client";

import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { canonicalizeFormatLocale, isValidTimeZone } from "@tarmoto/shared";
import { getStoredUnitSystem, usePreferencesStore } from "@/stores/preferences";
import { usersApi } from "@/lib/api/users";

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
    let cancelled = false;
    void (async () => {
      try {
        const { data: me } = await usersApi.getMe();
        if (cancelled) return;

        const prefsPatch: {
          units?: "metric" | "imperial";
          format_locale?: string;
          timezone?: string;
        } = {};

        const accountUnits = me.preferences?.units;
        const stored = getStoredUnitSystem();
        if (accountUnits === "metric" || accountUnits === "imperial") {
          if (accountUnits !== stored) setUnitSystem(accountUnits);
        } else if (stored) {
          prefsPatch.units = stored;
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

        if (Object.keys(prefsPatch).length > 0) {
          await usersApi.updateMe({ preferences: prefsPatch });
        }
      } catch (error) {
        console.error("Failed to sync display preferences with account", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, setUnitSystem]);

  return null;
}
