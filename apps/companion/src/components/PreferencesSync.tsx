"use client";

import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { canonicalizeFormatLocale, isValidTimeZone } from "@tarmoto/shared";
import { getStoredUnitSystem, usePreferencesStore } from "@/stores/preferences";
import {
  isSupportedLocale,
  LOCALE_COOKIE,
  LOCALE_SYNC_PENDING_COOKIE,
  type SupportedLocale,
} from "@/i18n";
import { usersApi, type UpdateProfileInput } from "@/lib/api/users";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const SYNC_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000] as const;

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  const raw = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function readLocaleCookie(name: string): SupportedLocale | undefined {
  const locale = readCookie(name);
  return locale && isSupportedLocale(locale) ? locale : undefined;
}

function writeLocaleCookie(name: string, locale: SupportedLocale): void {
  document.cookie = `${name}=${encodeURIComponent(locale)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}

function clearCookie(name: string): void {
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}

/**
 * Hydrates the unit preference and reconciles display preferences with the
 * account record.
 *
 * Local hydrate runs first (fast paint with the device's last choice).
 * Once the session is authenticated, `/me` reconciliation runs in both
 * directions and retries transient failures with capped backoff:
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
  const router = useRouter();
  const hydrate = usePreferencesStore((s) => s.hydrate);
  const setUnitSystem = usePreferencesStore((s) => s.setUnitSystem);
  // Guards the reconciliation loop below against React strict-mode
  // double-invoke and repeat "authenticated" passes starting a second loop.
  // Must NOT latch on a pre-auth pass so eventual authentication still starts
  // the first attempt.
  const ran = useRef(false);
  const mounted = useRef(false);
  const syncGeneration = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, []);

  useEffect(() => {
    if (status !== "unauthenticated") return;
    // Stop a previous account's in-flight/retry loop and allow the next
    // authenticated account to reconcile on this still-mounted shell.
    syncGeneration.current += 1;
    ran.current = false;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, [status]);

  useEffect(() => {
    if (status !== "authenticated" || ran.current) return;
    ran.current = true;
    // The in-flight request is allowed to finish across strict-mode's
    // simulated unmount; `mounted` only controls whether a failed attempt may
    // schedule another timer. On a real unmount, pending retry timers are
    // cleared by the lifecycle effect above.
    let retryIndex = 0;
    const generation = syncGeneration.current;

    const reconcile = async (): Promise<void> => {
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
        if (generation !== syncGeneration.current) return;

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

        const cookieLocale = readLocaleCookie(LOCALE_COOKIE);
        let pendingLocale = readLocaleCookie(LOCALE_SYNC_PENDING_COOKIE);
        if (pendingLocale && pendingLocale !== cookieLocale) {
          // A superseded or hand-tampered marker never gets authority over
          // either the current browser locale or the account.
          clearCookie(LOCALE_SYNC_PENDING_COOKIE);
          pendingLocale = undefined;
        }

        let accountLocaleToAdopt: SupportedLocale | undefined;
        if (pendingLocale) {
          // Only an explicit, still-pending browser selection may flow from
          // cookie -> account. An ordinary cookie can be stale after mobile
          // changed the cross-device preference.
          if (me.language !== pendingLocale) {
            update.language = pendingLocale;
          } else {
            clearCookie(LOCALE_SYNC_PENDING_COOKIE);
          }
        } else if (
          me.language &&
          isSupportedLocale(me.language) &&
          me.language !== cookieLocale
        ) {
          accountLocaleToAdopt = me.language;
        }

        if (Object.keys(update).length > 0) {
          await usersApi.updateMe(update);
        }
        if (generation !== syncGeneration.current) return;
        if (update.language) {
          clearCookie(LOCALE_SYNC_PENDING_COOKIE);
        }
        if (accountLocaleToAdopt) {
          writeLocaleCookie(LOCALE_COOKIE, accountLocaleToAdopt);
          router.refresh();
        }
      } catch (error) {
        console.error("Failed to sync display preferences with account", error);
        if (!mounted.current || generation !== syncGeneration.current) return;
        const delay =
          SYNC_RETRY_DELAYS_MS[
            Math.min(retryIndex, SYNC_RETRY_DELAYS_MS.length - 1)
          ];
        retryIndex += 1;
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          void reconcile();
        }, delay);
      }
    };

    void reconcile();
  }, [router, status, setUnitSystem]);

  return null;
}
