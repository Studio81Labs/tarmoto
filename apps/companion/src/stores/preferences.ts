import { create } from "zustand";
import type { UnitSystem } from "@tarmoto/shared";
import { UNITS_COOKIE, FORMAT_PREFS_COOKIE_MAX_AGE_SECONDS } from "@/format";

/**
 * User-level display preferences. Backend stores everything in metric per
 * AGENTS.md, so every display formatter reads this store to decide whether
 * to convert. Persisted to localStorage AND mirrored into the
 * `tarmoto-units` cookie (so SSR renders the right units), and reconciled
 * with the account's `preferences.units` by PreferencesSync — the account
 * is the cross-device source of truth.
 */

const STORAGE_KEY = "tarmoto:preferences:unit-system";
const VALID_UNITS: readonly UnitSystem[] = ["metric", "imperial"];

function isUnitSystem(value: unknown): value is UnitSystem {
  return (
    typeof value === "string" &&
    (VALID_UNITS as readonly string[]).includes(value)
  );
}

/**
 * The EXPLICIT stored preference, or null when the rider never chose one.
 * The null/default distinction matters: only an explicit value may be
 * backfilled to the account (PreferencesSync) or stamped into the cookie.
 */
export function getStoredUnitSystem(): UnitSystem | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isUnitSystem(raw) ? raw : null;
  } catch {
    return null;
  }
}

function saveUnitSystem(units: UnitSystem): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, units);
  } catch {
    // Quota or private-mode failures are non-fatal — the in-memory state
    // still works for this session.
  }
  saveUnitsCookie(units);
}

function saveUnitsCookie(units: UnitSystem): void {
  if (typeof document === "undefined") return;
  document.cookie = `${UNITS_COOKIE}=${units}; path=/; max-age=${FORMAT_PREFS_COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

interface PreferencesState {
  unitSystem: UnitSystem;
  /** True once localStorage has been read; the FormatProvider keeps using
   *  the server-seeded units until then so SSR and first paint agree. */
  hydrated: boolean;
  setUnitSystem: (units: UnitSystem) => void;
  hydrate: () => void;
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  unitSystem: "metric",
  hydrated: false,
  setUnitSystem: (units) => {
    saveUnitSystem(units);
    set({ unitSystem: units });
  },
  hydrate: () => {
    const stored = getStoredUnitSystem();
    // Refresh the SSR cookie for riders whose explicit choice predates the
    // cookie's existence — without this their next request still SSRs the
    // default.
    if (stored) saveUnitsCookie(stored);
    set({ unitSystem: stored ?? "metric", hydrated: true });
  },
}));
