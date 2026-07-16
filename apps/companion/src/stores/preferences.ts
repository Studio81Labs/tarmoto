import { create } from "zustand";
import type { UnitSystem } from "@tarmoto/shared";

/**
 * User-level display preferences. Backend stores everything in metric per
 * AGENTS.md, so every display formatter reads this store to decide whether to
 * convert. Persisted locally (no server round-trip today); once the account
 * endpoint gains a preferences field we can swap `loadUnitSystem`/`save` for
 * an API call without touching consumers.
 */

const STORAGE_KEY = "tarmoto:preferences:unit-system";
const VALID_UNITS: readonly UnitSystem[] = ["metric", "imperial"];

function isUnitSystem(value: unknown): value is UnitSystem {
  return (
    typeof value === "string" &&
    (VALID_UNITS as readonly string[]).includes(value)
  );
}

function loadUnitSystem(): UnitSystem {
  if (typeof window === "undefined") return "metric";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isUnitSystem(raw) ? raw : "metric";
  } catch {
    return "metric";
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
    set({ unitSystem: loadUnitSystem(), hydrated: true });
  },
}));
